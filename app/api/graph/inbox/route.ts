/**
 * POST/GET /api/graph/inbox — THE VAULT WATCHER's HTTP door (personal fork).
 * The owner writes notes on a tablet; Nextcloud syncs the PDFs/Markdown to a
 * watched folder on disk. This route scans that folder, reports the NEW or
 * CHANGED files since the last scan, and imports them through the SAME
 * extraction pipeline the folder-import route uses
 * (`extraction.importNotes` + `sourceDirectory.registerImport`).
 *
 * Two phases over `{ dir, dryRun? }`:
 *  - dryRun:true  → list the NEW-or-CHANGED files only (no reads of file
 *                   contents, no model calls, no source writes, no state
 *                   change). A UI confirmation ("Import 3 new notes?").
 *  - dryRun:false → scan + import the new/changed files, then COMMIT the
 *                   watch state so the next scan skips them. Per-file error
 *                   isolation (one bad file never aborts the batch), PDFs
 *                   converted to Markdown first — both mirrored from the
 *                   folder-import route.
 *
 * GET → the current watch state summary: how many files are tracked and
 *  the timestamp of the last committed scan.
 *
 * DUPLICATION NOTE (task instruction): another agent is editing
 * app/api/graph/import-folder/route.ts concurrently, so this route does
 * NOT import or modify that file. The small path-resolution +
 * PDF/text-reading logic (`resolveFolderPath`, `readNotesFileFromDisk`)
 * is a deliberate local copy of the sibling route's logic so this route
 * stays self-contained and conflict-free. The discovery layer is reused
 * through the shared `@/src/server` surface (`scanInbox` /
 * `commitScan` / `writeState` from src/server/vault-watch.ts). The
 * extraction entry + source registration are reused the same way the
 * folder-import route does.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { convertPdf, extraction, joinPages, NotesImportError, sourceDirectory } from "@/src/server";
import {
	scanInbox,
	commitScan,
	readState,
	writeState,
	type VaultWatchState,
} from "@/src/server";
import {
	emit,
	ModelsNotConfiguredError,
	ProviderKeyMissingError,
	PROVIDER_KEY_MISSING_CODE,
	type EmissionStats,
} from "@/src/core";
import { IMPORT_EXTENSIONS, validNotesPath } from "@/lib/notes-import-limits.ts";
import { PATHS } from "@/config.ts";

export const dynamic = "force-dynamic";

// ── Limits (mirror the folder-import route's PDF handling) ──────────────────
/** PDF page ceiling, the same as the per-file and folder-import routes. */
const MAX_PDF_PAGES = 1000;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

/** Where the watch state lives: alongside the other graph state files, so
 *  the desktop shell's data relocation (LH_DATA_DIR) covers it too. The
 *  GET door + a future UI read this; scanInbox reads/writes it directly. */
const WATCH_STATE_FILE = path.join(PATHS.graph, "vault-watch-state.json");

export interface InboxScanEntry {
	/** The folder-relative POSIX path — the file's identity for the
	 *  extraction pipeline (matches the import routes' `filePath` contract).
	 *  Never absolute, never contains `..`. */
	path: string;
	/** Bytes on disk, for a UI total. */
	size: number;
	kind: "text" | "pdf";
}

export interface InboxScanListing {
	/** The NEW-or-CHANGED files to import (folder-relative POSIX paths). */
	files: InboxScanEntry[];
	/** The full count of currently-tracked valid files (the watch state's
	 *  universe after this scan would commit). */
	tracked: number;
}

export interface InboxImportResult {
	/** The folder-relative POSIX path (matches InboxScanEntry.path). */
	filePath: string;
	ok: boolean;
	outcome: "completed" | "failed" | "partial" | "aborted" | "busy";
	stats?: EmissionStats;
	error?: string;
	code?: "models_not_configured" | (typeof PROVIDER_KEY_MISSING_CODE);
	missing?: string[];
	provider?: string;
	slots?: string[];
	/** Shown beside a completed PDF import (scanner text may be wrong). */
	notice?: string;
}

export interface InboxSummary {
	/** How many files the watch state currently tracks. */
	tracked: number;
	/** The last committed scan's timestamp (ISO), or null if never scanned. */
	lastScanAt: string | null;
}

// ── Home-anchoring (deliberate local copy of import-folder's resolveFolderPath) ─

/** Expand a user-supplied path the way the learner-filesystem tools do:
 *  relative/`~` resolves against `os.homedir()`, then the result is
 *  canonicalized. A path that resolves OUTSIDE the home tree (after
 *  realpath) is refused — the same defense the fs tools apply, duplicated
 *  locally so this route never imports src/agent. COPIED from
 *  app/api/graph/import-folder/route.ts (which another agent is editing);
 *  keep them in sync if the home-anchoring rule changes. */
export function resolveFolderPath(p: string, home: string = os.homedir()): string {
	if (typeof p !== "string" || p.length === 0) throw new Error("A folder path is required.");
	if (/[\x00-\x1f\x7f]/.test(p)) throw new Error("Invalid folder path.");
	let resolved: string;
	if (p === "~") resolved = home;
	else if (p.startsWith("~/") || p.startsWith(`~${path.sep}`)) resolved = path.join(home, p.slice(1));
	else if (path.isAbsolute(p)) resolved = p;
	else resolved = path.resolve(home, p);
	let real: string;
	try { real = fs.realpathSync.native(resolved); }
	catch {
		throw new Error(`Could not open “${p}”. The folder does not exist or cannot be read.`);
	}
	const realHome = (() => { try { return fs.realpathSync.native(home); } catch { return home; } })();
	if (!isWithin(real, realHome)) {
		throw new Error(`Access denied: “${p}” is outside your home folder. Pick a folder inside your home.`);
	}
	return real;
}

/** Segment-aware containment (mirrors src/agent/tools/file-access.ts
 *  isWithin), duplicated locally to avoid importing src/agent. */
function isWithin(absolute: string, root: string): boolean {
	const rel = path.relative(root, absolute);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

// ── File reading (deliberate local copy of import-folder's readNotesFileFromDisk) ─

type NotesFile = { kind: "notes"; text: string; notice?: string } | { kind: "refused"; error: string };

/** Read a notes file from disk and convert PDFs to page-marked Markdown.
 *  COPIED from app/api/graph/import-folder/route.ts (which another agent is
 *  editing concurrently); the only difference is the source is a disk path.
 *  PDFs are detected by their `%PDF-` magic bytes, not their name. Keep in
 *  sync if the PDF conversion path changes. */
async function readNotesFileFromDisk(absolutePath: string): Promise<NotesFile> {
	// A fresh ArrayBuffer-backed view, not Node's Buffer: pdfjs mutates the
	// underlying buffer (a Buffer shares the pool and pdfjs can detach it,
	// yielding an unreadable PDF). Mirrors the folder-import route.
	const bytes = new Uint8Array(fs.readFileSync(absolutePath));
	if (!PDF_MAGIC.every((byte, i) => bytes[i] === byte)) {
		return { kind: "notes", text: new TextDecoder().decode(bytes) };
	}
	const pdf = await convertPdf(bytes, MAX_PDF_PAGES);
	switch (pdf.kind) {
		case "unreadable":
			return { kind: "refused", error: "Could not open this PDF." };
		case "too-long":
			return { kind: "refused", error: "Too long. Max 1,000 pages." };
		case "converted": {
			const text = joinPages(pdf.pages);
			if (!text) return { kind: "refused", error: "OCR not supported yet." };
			const skipped = pdf.pages.filter((page) => page.kind === "image-only").length;
			const omission = skipped > 0 ? ` Skipped ${skipped} image-only ${skipped === 1 ? "page" : "pages"}; OCR is not supported.` : "";
			return { kind: "notes", text, notice: `Scanned pages may have errors.${omission}` };
		}
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** The folder-relative POSIX path for an absolute file under `root` — the
 *  extraction pipeline's source identity (matches the import routes'
 *  `filePath` contract). Never absolute, never contains `..`. */
function relativePath(root: string, absolute: string): string {
	return path.relative(root, absolute).split(path.sep).join("/");
}

interface InboxBody {
	dir?: unknown;
	dryRun?: unknown;
}

async function readBody(request: Request): Promise<InboxBody> {
	try { return await request.json() as InboxBody; }
	catch { throw new SyntaxError("Invalid JSON body"); }
}

// ── GET: the current watch state summary ─────────────────────────────────────

export async function GET() {
	const state: VaultWatchState = readState(WATCH_STATE_FILE);
	const tracked = Object.keys(state).length;
	// lastScanAt is the newest importedAt across tracked files (the most
	// recent commit), or null if nothing is tracked yet.
	let lastScanAt: string | null = null;
	for (const rec of Object.values(state)) {
		if (!lastScanAt || rec.importedAt > lastScanAt) lastScanAt = rec.importedAt;
	}
	return Response.json({ tracked, lastScanAt } satisfies InboxSummary);
}

// ── POST: scan (dryRun) or scan + import + commit ────────────────────────────

export async function POST(request: Request) {
	let body: InboxBody;
	try { body = await readBody(request); }
	catch {
		return Response.json({ error: "Could not read the request. Send a JSON body with a folder path." }, { status: 400 });
	}
	const rawDir = body.dir;
	const dryRun = body.dryRun === true;
	if (typeof rawDir !== "string" || rawDir.length === 0) {
		return Response.json({ error: "A folder path is required." }, { status: 400 });
	}

	let root: string;
	try { root = resolveFolderPath(rawDir); }
	catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : "Invalid folder path." }, { status: 400 });
	}
	try {
		if (!fs.statSync(root).isDirectory()) {
			return Response.json({ error: `“${rawDir}” is not a folder.` }, { status: 400 });
		}
	} catch {
		return Response.json({ error: `Could not open “${rawDir}”. The folder does not exist or cannot be read.` }, { status: 400 });
	}

	// Scan: read state, walk, diff. scanInbox returns ABSOLUTE paths.
	const { newFiles, processed } = scanInbox(root, WATCH_STATE_FILE);

	// Build the folder-relative listing for the wire (the extraction
	// pipeline's `filePath` identity). A relative path that escapes the root
	// (a symlink the walker skipped should never produce one, but validate
	// defensively) aborts the request, mirroring the folder-import route.
	const entries: InboxScanEntry[] = [];
	for (const absolute of newFiles) {
		const rel = relativePath(root, absolute);
		const name = path.basename(absolute);
		// validNotesPath: identity only, no disk path, no traversal (the
		// import contract). A bad path refuses the whole request.
		if (!validNotesPath(rel, name)) {
			return Response.json({ error: "Import contains an unsafe or mismatched relative path." }, { status: 400 });
		}
		let size = 0;
		try { size = fs.statSync(absolute).size; } catch { /* vanished; size 0 */ }
		entries.push({
			path: rel, size,
			kind: /\.pdf$/i.test(name) ? "pdf" : "text",
		});
	}

	// dryRun: list only — no reads, no model calls, no source writes, no
	// state change. The UI confirms "Import N new notes?".
	if (dryRun) {
		return Response.json({
			files: entries,
			tracked: processed.length,
		} satisfies InboxScanListing);
	}

	// Nothing new: nothing to import. Still return an empty result + the
	// tracked count; the state is unchanged (no commit needed).
	if (entries.length === 0) {
		return Response.json({ results: [] as InboxImportResult[], tracked: processed.length });
	}

	// Real import: reuse the SAME extraction pipeline + source registration
	// the folder-import route uses, with the same per-file result shape,
	// error isolation, and 3-wide concurrency. One bad file (or one config
	// refusal) never aborts the batch — each result is recorded
	// independently, and only the successes are committed to the watch state.
	const results: InboxImportResult[] = [];
	const queue = entries.map((entry) => ({ entry, absolute: path.join(root, ...entry.path.split("/")) }));
	const importedNow = new Set<string>();
	const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
		for (;;) {
			const next = queue.shift();
			if (!next) return;
			const { entry, absolute } = next;
			const filePath = entry.path;
			try {
				const notes = await readNotesFileFromDisk(absolute);
				if (notes.kind === "refused") {
					results.push({ filePath, outcome: "failed", ok: false, error: notes.error });
					continue;
				}
				sourceDirectory.registerImport(filePath);
				const stats = await extraction.importNotes({ filePath, text: notes.text });
				importedNow.add(absolute);
				results.push({ filePath, outcome: "completed", ok: true, stats, ...(notes.notice ? { notice: notes.notice } : {}) });
			} catch (err) {
				if (err instanceof ModelsNotConfiguredError) {
					results.push({ filePath, ok: false, outcome: "failed", error: err.envelope.error,
						code: "models_not_configured", missing: err.envelope.missing });
				} else if (err instanceof ProviderKeyMissingError) {
					results.push({ filePath, ok: false, outcome: "failed", error: err.envelope.error,
						code: PROVIDER_KEY_MISSING_CODE, provider: err.envelope.provider, slots: err.envelope.slots });
				} else {
					results.push({ filePath, ok: false,
						outcome: err instanceof NotesImportError ? err.outcome : "failed",
						...(err instanceof NotesImportError ? { stats: err.partialStats } : {}),
						error: err instanceof Error ? err.message : String(err) });
				}
			} finally { emit("sources-changed", {}); }
		}
	});
	await Promise.all(workers);

	// Commit the watch state so the next scan skips the successfully-imported
	// files (and the unchanged ones). Failures are NOT committed — a failed
	// import stays NEW so the next scan retries it. commitScan drops records
	// for files that vanished from the inbox (deleted notes are untracked).
	const oldState = readState(WATCH_STATE_FILE);
	const newState = commitScan(processed, oldState, importedNow, new Date().toISOString());
	writeState(WATCH_STATE_FILE, newState);

	return Response.json({ results, tracked: Object.keys(newState).length });
}
