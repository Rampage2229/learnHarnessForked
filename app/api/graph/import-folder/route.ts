/**
 * POST /api/graph/import-folder — import a whole folder of personal-notes
 * files in one action (Obsidian / tablet vault on disk). The per-file picker
 * (`/api/graph/import`) requires the renderer to ship file bytes; the
 * renderer cannot read an arbitrary server-side directory, so this route
 * walks a server-side path instead. The desktop shell hands the renderer a
 * single directory path via the existing native picker (`lh:attachment:pick`
 * "folder" → `window.lh.chooseAttachmentFolder`); this route does the rest.
 *
 * Two phases over the same body `{ path: string, dryRun?: boolean }`:
 *  - dryRun:true  → list the importable files (extension + hidden + dot-dir +
 *                   count/size/depth caps) and return totals for a UI
 *                   confirmation ("Import 37 notes (2.4MB)?"). No reads of
 *                   file contents, no model calls, no source writes.
 *  - dryRun:false → read each listed file server-side and run the SAME
 *                   extraction pipeline the per-file route uses
 *                   (`extraction.importNotes` + `sourceDirectory.registerImport`),
 *                   with the same per-file result shape, error isolation
 *                   (one bad file never aborts the batch), and 3-wide
 *                   concurrency. PDFs are converted to Markdown first, the
 *                   same way `readNotesFile` does in the sibling route.
 *
 * Path resolution mirrors the learner-filesystem tools' home-anchoring
 * (`resolveSourcePath` in src/agent/tools/fs-shared.ts): a relative path or
 * `~` expands against `os.homedir()`, the result is canonicalized with
 * `realpathSync.native`, and a path that escapes home is refused. That logic
 * is duplicated HERE on purpose (the task forbids importing from src/agent
 * in a route, and the fs tools live under src/agent): the only shared
 * safety primitive is `IMPORT_EXTENSIONS` / `MAX_IMPORT_BYTES` from
 * lib/notes-import-limits, the import contract, not the agent layer.
 *
 * CONCURRENCY / DUPLICATION NOTE (task instruction): another agent is
 * editing app/api/graph/import/route.ts concurrently, so this route does
 * NOT import or modify that file. The small PDF/text reading logic
 * (`readNotesFile` here) is a deliberate local copy of the sibling route's
 * `readNotesFile` so this route can stay self-contained and conflict-free.
 * The extraction entry + source registration are reused through the shared
 * `@/src/server` surface, identical to the sibling route's calls.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { convertPdf, extraction, joinPages, NotesImportError, sourceDirectory } from "@/src/server";
import {
	emit,
	ModelsNotConfiguredError,
	ProviderKeyMissingError,
	PROVIDER_KEY_MISSING_CODE,
	type EmissionStats,
} from "@/src/core";
import { IMPORT_EXTENSIONS, MAX_IMPORT_BYTES, validNotesPath } from "@/lib/notes-import-limits.ts";

export const dynamic = "force-dynamic";

// ── Limits (folder-specific) ────────────────────────────────────────────────
/** Cap the number of files a single folder import can carry. The per-file
 *  route's 1000-page limit is a per-PDF ceiling; a folder import is a
 *  user-facing batch and 200 keeps one action's model burst tractable. */
export const MAX_FOLDER_FILES = 200;
/** Never walk deeper than this many directory levels below the chosen root.
 *  Bounds a pathological vault; the common Obsidian vault is far shallower. */
export const MAX_DEPTH = 8;
/** PDF page ceiling, the same as the per-file route (the extractor's budget). */
const MAX_PDF_PAGES = 1000;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

// ── Directory names never entered during a walk, belt-and-braces alongside
// the dot-prefix rule below. Dot-directories (.obsidian, .git, .trash, …)
// hold vault metadata, not notes; the renderer's `hiddenInFolder` rule skips
// any `.`-prefixed segment below the root. The root itself is importable
// even when hidden.
const SKIPPED_DOT_DIRS = new Set([".obsidian", ".git", ".trash"]);

export interface FolderFileEntry {
	/** Folder-relative POSIX path — the file's identity (deterministic source
	 *  id) and provenance label, the same contract as the per-file route's
	 *  `paths` field. Never absolute, never contains `..`. */
	path: string;
	/** Bytes on disk, for the dry-run total and the size cap. */
	size: number;
	/** "text" | "pdf" — known by magic bytes for PDFs, extension otherwise. */
	kind: "text" | "pdf";
}

export interface FolderListing {
	files: FolderFileEntry[];
	/** Files skipped for being hidden, dot-dir residents, the wrong
	 *  extension, oversized, or beyond a cap. The dry-run surfaces the count
	 *  so a surprising vault (e.g. 500 files) is visible without a dump. */
	skipped: number;
	totalBytes: number;
	/** True when the file COUNT cap (not the size cap) truncated the walk. */
	truncated: boolean;
}

export interface FolderImportResult {
	/** The folder-relative POSIX path (matches FolderFileEntry.path). */
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

// ── Home-anchoring (mirrors resolveSourcePath in src/agent/tools/fs-shared.ts) ─

/** Expand a user-supplied path the way the learner-filesystem tools do:
 *  relative/`~` resolves against `os.homedir()`, `~user` stays literal,
 *  then the result is canonicalized. A path that resolves OUTSIDE the home
 *  tree (after realpath) is refused — the same defense the fs tools apply,
 *  duplicated locally so this route never imports src/agent. */
export function resolveFolderPath(p: string, home: string = os.homedir()): string {
	if (typeof p !== "string" || p.length === 0) throw new Error("A folder path is required.");
	// Reject NULs and control chars early (the fs tools' validNotesPath rule).
	if (/[\x00-\x1f\x7f]/.test(p)) throw new Error("Invalid folder path.");
	// `~` and `~/…` expand against home; `~user` is left literal (the fs tools
	// do the same — only the bare-user home shorthand is special).
	let resolved: string;
	if (p === "~") resolved = home;
	else if (p.startsWith("~/") || p.startsWith(`~${path.sep}`)) resolved = path.join(home, p.slice(1));
	else if (path.isAbsolute(p)) resolved = p;
	else resolved = path.resolve(home, p);
	// Canonicalize: resolves symlinks in the path (NOT symlinks found during
	// the walk — those are skipped below). A missing path fails closed here.
	let real: string;
	try { real = fs.realpathSync.native(resolved); }
	catch {
		throw new Error(`Could not open “${p}”. The folder does not exist or cannot be read.`);
	}
	// Containment: the canonical path must stay inside the canonical home.
	// A symlink that points outside home is refused, mirroring guardSourcePath.
	const realHome = (() => { try { return fs.realpathSync.native(home); } catch { return home; } })();
	if (!isWithin(real, realHome)) {
		throw new Error(`Access denied: “${p}” is outside your home folder. Pick a folder inside your home.`);
	}
	return real;
}

/** Segment-aware containment (mirrors src/agent/tools/file-access.ts isWithin),
 *  duplicated locally to avoid importing src/agent. */
function isWithin(absolute: string, root: string): boolean {
	const rel = path.relative(root, absolute);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** True for a path segment the walk skips: a dot-directory (vault metadata)
 *  or a hidden file. The root is exempt — only DESCENDANTS are filtered. */
function isHiddenName(name: string): boolean {
	return name.length > 0 && name.startsWith(".");
}

// ── The pure-ish walk (exported for direct unit testing without extraction) ─

/** Walk `root` recursively and collect importable notes files. Synchronous on
 *  purpose: the dry-run must be deterministic and fast, and the walk is I/O
 *  bound either way. Symlinks are NOT followed (the fs tools' rule); a
 *  symlinked directory entry is skipped. Caps (file count, total bytes,
 *  depth) are enforced as the walk proceeds so a huge vault short-circuits.
 *
 *  Returns the listing only — no extraction, no model calls — so the dry-run
 *  AND a unit test can drive it without the engine seam. `skipped` counts
 *  every file rejected for a non-cap reason (hidden, dot-dir, extension,
 *  oversized, symlink); once `truncated` is set the walk stops and the rest
 *  of the vault is neither collected nor counted. */
export function listImportableFiles(
	root: string,
	opts: { maxFiles?: number; maxBytes?: number; maxDepth?: number } = {},
): FolderListing {
	const maxFiles = opts.maxFiles ?? MAX_FOLDER_FILES;
	const maxBytes = opts.maxBytes ?? MAX_IMPORT_BYTES;
	const maxDepth = opts.maxDepth ?? MAX_DEPTH;
	const files: FolderFileEntry[] = [];
	let skipped = 0;
	let totalBytes = 0;
	let truncated = false;

	const walk = (dir: string, depth: number): void => {
		if (truncated) return;
		if (depth > maxDepth) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			// Unreadable directory (permissions): skip, keep walking siblings.
			return;
		}
		for (const entry of entries) {
			if (truncated) return;
			const full = path.join(dir, entry.name);
			// Never follow symlinks (the fs tools' rule); a symlinked dir/file
			// is skipped, not entered, so a vault can't be widened by a link.
			if (entry.isSymbolicLink()) { skipped++; continue; }
			if (entry.isDirectory()) {
				// Dot-directories (.obsidian, .git, .trash, any `.`-prefix) hold
				// vault metadata, not notes. The named skips are belt-and-
				// braces; the dot-prefix rule is the real filter.
				if (isHiddenName(entry.name) || SKIPPED_DOT_DIRS.has(entry.name)) { continue; }
				walk(full, depth + 1);
				continue;
			}
			if (!entry.isFile()) continue; // sockets, fifos, devices, etc.
			// Hidden files (`.DS_Store`, `.gitignore`, …) are skipped; the root
			// itself is exempt, but every file under it is filtered.
			if (isHiddenName(entry.name)) { skipped++; continue; }
			// Extension filter — the same regex the per-file route accepts.
			if (!IMPORT_EXTENSIONS.test(entry.name)) { skipped++; continue; }
			let size: number;
			try { size = fs.statSync(full).size; }
			catch { skipped++; continue; } // vanished between readdir and stat
			if (size > MAX_IMPORT_BYTES) { skipped++; continue; } // per-file cap
			// Aggregate size cap: stop collecting once the batch would exceed
			// the per-request budget (the per-file route's MAX_IMPORT_BYTES).
			if (totalBytes + size > maxBytes) { truncated = true; return; }
			const rel = path.relative(root, full).split(path.sep).join("/");
			files.push({ path: rel, size, kind: /\.pdf$/i.test(entry.name) ? "pdf" : "text" });
			totalBytes += size;
			if (files.length >= maxFiles) { truncated = true; return; }
		}
	};

	walk(root, 0);
	return { files, skipped, totalBytes, truncated };
}

// ── File reading (deliberate local copy of the sibling route's readNotesFile) ─

type NotesFile = { kind: "notes"; text: string; notice?: string } | { kind: "refused"; error: string };

/** Read a notes file from disk and convert PDFs to page-marked Markdown.
 *  This is an intentional local copy of `readNotesFile` in the sibling route
 *  app/api/graph/import/route.ts (which another agent is editing concurrently);
 *  the only difference is the source is a disk path, not a `File`. PDFs are
 *  detected by their `%PDF-` magic bytes, not their name. */
async function readNotesFileFromDisk(absolutePath: string): Promise<NotesFile> {
	// A fresh ArrayBuffer-backed view, not Node's Buffer: pdfjs mutates the
	// underlying buffer (the sibling route uses `new Uint8Array(await
	// file.arrayBuffer())` for the same reason; a Buffer shares the pool and
	// pdfjs can detach it, yielding an unreadable PDF).
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

// ── The route ───────────────────────────────────────────────────────────────

interface FolderImportBody {
	path?: unknown;
	dryRun?: unknown;
}

async function readBody(request: Request): Promise<FolderImportBody> {
	try { return await request.json() as FolderImportBody; }
	catch { throw new SyntaxError("Invalid JSON body"); }
}

export async function POST(request: Request) {
	let body: FolderImportBody;
	try { body = await readBody(request); }
	catch {
		return Response.json({ error: "Could not read the request. Send a JSON body with a folder path." }, { status: 400 });
	}
	const rawPath = body.path;
	const dryRun = body.dryRun === true;
	if (typeof rawPath !== "string" || rawPath.length === 0) {
		return Response.json({ error: "A folder path is required." }, { status: 400 });
	}

	let root: string;
	try { root = resolveFolderPath(rawPath); }
	catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : "Invalid folder path." }, { status: 400 });
	}
	// The resolved root must actually be a directory.
	try {
		if (!fs.statSync(root).isDirectory()) {
			return Response.json({ error: `“${rawPath}” is not a folder.` }, { status: 400 });
		}
	} catch {
		return Response.json({ error: `Could not open “${rawPath}”. The folder does not exist or cannot be read.` }, { status: 400 });
	}

	const listing = listImportableFiles(root);
	if (listing.files.length === 0) {
		return Response.json({
			files: [], skipped: listing.skipped, totalBytes: 0, truncated: listing.truncated,
			error: "No importable notes found in this folder.",
		}, { status: 400 });
	}

	// dryRun: list only — no reads, no model calls, no source writes.
	if (dryRun) {
		return Response.json({
			files: listing.files, skipped: listing.skipped,
			totalBytes: listing.totalBytes, truncated: listing.truncated,
		});
	}

	// Real import: validate every relative path up front (the per-file route's
	// validNotesPath contract — identity only, no disk path, no traversal).
	// A bad path would abort the batch; refuse the whole request instead.
	const invalid = listing.files.find((f) => !validNotesPath(f.path, path.basename(f.path)));
	if (invalid) {
		return Response.json({ error: "Import contains an unsafe or mismatched relative path." }, { status: 400 });
	}

	// Reuse the SAME extraction pipeline + source registration the per-file
	// route uses, with the same per-file result shape, error isolation, and
	// 3-wide concurrency. One bad file (or one config refusal) never aborts
	// the batch — each result is recorded independently.
	const results: FolderImportResult[] = [];
	const queue = listing.files.map((file) => ({ file, absolute: path.join(root, ...file.path.split("/")) }));
	const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
		for (;;) {
			const next = queue.shift();
			if (!next) return;
			const { file, absolute } = next;
			const filePath = file.path;
			try {
				const notes = await readNotesFileFromDisk(absolute);
				if (notes.kind === "refused") {
					results.push({ filePath, outcome: "failed", ok: false, error: notes.error });
					continue;
				}
				sourceDirectory.registerImport(filePath);
				const stats = await extraction.importNotes({ filePath, text: notes.text });
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
	return Response.json({ results });
}
