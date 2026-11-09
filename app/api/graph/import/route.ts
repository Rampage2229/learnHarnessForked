/**
 * POST /api/graph/import — the format-agnostic front door's transport
 * (vision §1, 2026-09-13): raw personal-notes files in, one extraction run
 * per file through the SAME pipeline the sessions use. Multipart form data
 * (field "files", any text format — the extractor is format-agnostic); the
 * pipeline mints a deterministic source id per file path, persists the
 * source record (the file's provenance + the run's usage), and runs
 * extractor → auditor → merger over the raw text.
 *
 * A PDF (spotted by its %PDF- header, not its name) is converted to
 * Markdown first. A PDF with nothing to extract is refused before any
 * model call or source record.
 *
 * Small concurrency cap: the model calls are the slow part, and a burst of
 * 25 simultaneous runs would trip provider rate limits — a 3-wide worker
 * pool keeps the run registry (the dock's status chips) and the ledgers
 * healthy. The dock's chips + graph refetch track progress live through
 * /api/graph/status, as with session runs.
 */
import { convertPdf, extraction, joinPages, NotesImportError, sourceDirectory } from "@/src/server";
import { MAX_IMPORT_BODY_BYTES, MAX_IMPORT_BYTES, validNotesPath } from "@/lib/notes-import-limits.ts";
import {
	mergeTranscribed,
	planTranscriptionCap,
	resolveVisionEngine,
	transcribePages,
	readCachedTranscription,
} from "@/src/server";
import {
	emit,
	ModelsNotConfiguredError,
	PROVIDER_KEY_MISSING_CODE,
	ProviderKeyMissingError,
	type EmissionStats,
} from "@/src/core";

export const dynamic = "force-dynamic";

interface ImportResult {
	requestIndex: number;
	outcome: "completed" | "failed" | "partial" | "aborted" | "busy";
	filePath: string;
	ok: boolean;
	stats?: EmissionStats;
	error?: string;
	/** The machine discriminator when ok:false is a config refusal — the
	 * BYOK models refusal (owner, 2026-09-22) or the provider-key refusal
	 * (2026-09-25); the client can open the setup/keys flow off it. */
	code?: "models_not_configured" | (typeof PROVIDER_KEY_MISSING_CODE);
	missing?: string[];
	/** The key-refusal specifics (provider_key_missing only). */
	provider?: string;
	slots?: string[];
	/** Shown beside a completed import (every PDF: scanner text may be wrong). */
	notice?: string;
}

const MAX_PDF_PAGES = 1000;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

type NotesFile = { kind: "notes"; text: string; notice?: string } | { kind: "refused"; error: string };

/** A PDF becomes page-marked Markdown; any other file is read as text, as before. */
async function readNotesFile(file: File): Promise<NotesFile> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	if (!PDF_MAGIC.every((byte, i) => bytes[i] === byte)) return { kind: "notes", text: new TextDecoder().decode(bytes) };
	// DETACH GUARD (transcription wave): pdfjs transfers the input buffer
	// (zero-copy handoff) — after convertPdf, `bytes` is detached and every
	// later read (the transcription cache key, the temp-file write) would
	// silently fail. pdf.js gets its OWN copy; `bytes` stays alive for the
	// cache and the temp write.
	const pdfBytes = new Uint8Array(bytes);
	const pdf = await convertPdf(pdfBytes, MAX_PDF_PAGES);
	switch (pdf.kind) {
		case "unreadable":
			return { kind: "refused", error: "Could not open this PDF." };
		case "too-long":
			return { kind: "refused", error: "Too long. Max 1,000 pages." };
		case "converted": {
			const imageOnly = pdf.pages.filter((p) => p.kind === "image-only").map((p) => p.number);
			// Text-only (or all-empty) PDF: the old fast path, unchanged.
			if (imageOnly.length === 0) {
				const text = joinPages(pdf.pages);
				if (!text) return { kind: "refused", error: "No readable text in this PDF." };
				return { kind: "notes", text, notice: "Scanned pages may have errors." };
			}
			// Handwritten/scanned pages: transcribe them with the vision slot.
			// CACHE-FIRST: pages already transcribed need no engine at all —
			// re-imports of the same notebook are free and model-less.
			const { toTranscribe, skipped } = planTranscriptionCap(imageOnly);
			const uncached: number[] = [];
			const transcriptions = new Map<number, string>();
			for (const page of toTranscribe) {
				const cached = await readCachedTranscription(bytes, page);
				if (cached) transcriptions.set(page, cached.markdown);
				else uncached.push(page);
			}
			const visionEngine = uncached.length > 0 ? resolveVisionEngine() : undefined;
			if (uncached.length > 0 && !visionEngine) {
				return {
					kind: "refused",
					error: "Handwritten pages need a vision model — set one in Settings → Models.",
				};
			}
			if (uncached.length > 0) {
				const tempPath = await writeTempPdf(bytes);
				try {
					const result = await transcribePages(tempPath, uncached, { pdfBytes: bytes, engine: visionEngine! });
					for (const t of result) transcriptions.set(t.page, t.markdown);
				} finally {
					const { rm } = await import("node:fs/promises");
					const { dirname } = await import("node:path");
					await rm(dirname(tempPath), { recursive: true, force: true }).catch(() => undefined);
				}
			}
			const merged = mergeTranscribed(pdf.pages, transcriptions, skipped);
			if (!merged.text) return { kind: "refused", error: "No readable text in this PDF." };
			return { kind: "notes", text: merged.text, notice: merged.notice || undefined };
		}
	}
}

/** Write the uploaded PDF bytes to a temp file so the renderer (which
 *  reads from a path) and the cache key (which hashes the file bytes) can
 *  work off the same upload without keeping the whole File in memory twice. */
async function writeTempPdf(bytes: Uint8Array): Promise<string> {
	const { writeFile, mkdtemp } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = await mkdtemp(join(tmpdir(), "lh-import-pdf-"));
	const file = join(dir, "upload.pdf");
	await writeFile(file, bytes);
	return file;
}

class ImportBodyLimitError extends Error {}

/** Bound actual body bytes before multipart parsing, including requests without
 * a trustworthy Content-Length. Next's proxy may truncate first; parsing that
 * incomplete body is a separate, handled refusal, never a partial import. */
async function readImportForm(request: Request): Promise<FormData> {
	if (Number(request.headers.get("content-length")) > MAX_IMPORT_BODY_BYTES) {
		void request.body?.cancel().catch(() => undefined);
		throw new ImportBodyLimitError();
	}
	const reader = request.body?.getReader();
	if (!reader) throw new SyntaxError("Missing import body");
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_IMPORT_BODY_BYTES) throw new ImportBodyLimitError();
			chunks.push(value);
		}
		const body = new Uint8Array(bytes);
		let offset = 0;
		for (const chunk of chunks) {
			body.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return await new Response(body, { headers: { "Content-Type": request.headers.get("content-type") ?? "" } }).formData();
	} finally {
		// Do not wait for a tee's other consumer to finish before refusing an upload.
		void reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

export async function POST(request: Request) {
	let form: FormData;
	try {
		form = await readImportForm(request);
	} catch (err) {
		const oversized = err instanceof ImportBodyLimitError;
		return Response.json({ results: [] as ImportResult[], error: oversized
			? "Import request is too large. Select fewer files."
			: "Could not read the upload. It may be incomplete; please select the files again." }, { status: oversized ? 413 : 400 });
	}
	const files = form.getAll("files").filter((f): f is File => f instanceof File);
	if (files.reduce((total, file) => total + file.size, 0) > MAX_IMPORT_BYTES) {
		return Response.json({ results: [] as ImportResult[], error: "Too big. Max 25 MB." }, { status: 413 });
	}
	if (files.length === 0) {
		return Response.json({ results: [] as ImportResult[], error: "no files" }, { status: 400 });
	}

	// PR198: folder-relative identity, matched to either browser filename form.
	// Validate every path before conversions, metadata writes, or model calls.
	const suppliedPaths = form.getAll("paths");
	if (suppliedPaths.length > 0 && (suppliedPaths.length !== files.length || suppliedPaths.some((p) => typeof p !== "string"))) {
		return Response.json({ results: [], error: "Invalid import paths" }, { status: 400 });
	}
	const paths = suppliedPaths.length > 0 ? suppliedPaths as string[] : files.map((f) => f.name);
	if (files.some((file, i) => !validNotesPath(paths[i]!, file.name))) {
		return Response.json({ results: [], error: "Import contains an unsafe or mismatched relative path" }, { status: 400 });
	}
	const results: ImportResult[] = [];
	const queue = files.map((file, requestIndex) => ({ file, requestIndex, filePath: paths[requestIndex]! }));
	const workers = Array.from({ length: Math.min(3, files.length) }, async () => {
		for (;;) {
			const next = queue.shift();
			if (!next) return;
			const { file, requestIndex, filePath } = next;
			try {
				const notes = await readNotesFile(file);
				if (notes.kind === "refused") {
					results.push({ filePath, requestIndex, outcome: "failed", ok: false, error: notes.error });
					continue;
				}
				sourceDirectory.registerImport(filePath);
				const stats = await extraction.importNotes({ filePath, text: notes.text });
				results.push({ filePath, requestIndex, outcome: "completed", ok: true, stats, ...(notes.notice ? { notice: notes.notice } : {}) });
			} catch (err) {
				if (err instanceof ModelsNotConfiguredError) {
					results.push({ filePath, ok: false, requestIndex, outcome: "failed", error: err.envelope.error,
						code: "models_not_configured", missing: err.envelope.missing });
				} else if (err instanceof ProviderKeyMissingError) {
					results.push({ filePath, ok: false, requestIndex, outcome: "failed", error: err.envelope.error,
						code: PROVIDER_KEY_MISSING_CODE, provider: err.envelope.provider, slots: err.envelope.slots });
				} else {
					results.push({ filePath, requestIndex, ok: false,
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