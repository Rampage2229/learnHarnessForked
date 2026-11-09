/**
 * Vision transcription for handwritten/scanned PDFs (notes-import path,
 * personal fork): the missing half of convertPdf's story. convertPdf
 * extracts a TEXT LAYER (pdf.js) and emits `image-only` pages for anything
 * without one — a handwritten e-ink page has no text layer, so the notes
 * import used to refuse those outright ("OCR not supported yet"). Vision
 * models read handwriting far better than tesseract; this module renders
 * each such page and asks the vision slot for a verbatim Markdown
 * transcription, one image-in-the-loop call per page (the pdf-reader /
 * visual-maker's exact single-shot shape — a hand-rolled streamOnce,
 * because image-in-the-loop can't ride the execute-tool plumbing).
 *
 * A DISK CACHE (sha256 of the PDF file bytes + page number) stores each
 * page's transcription as JSON under PATHS.data/pdf-transcriptions/, so a
 * re-import never pays twice. Cache read/write NEVER throws — a corrupt
 * or unwritable cache degrades to a fresh transcription, never a crash.
 *
 * Engine seam: deps.engine? is the test injectable (no network). In
 * production the module resolves the vision slot itself — server→agent is
 * the lawful direction (chat-handler precedent), so this server module
 * resolves `resolveRoleSpec("pdfReader", settings)` + `piEngineForSpec`,
 * exactly like chat-handler's resolveEngine. No top-level side effects.
 */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { PATHS } from "../../config.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { settingsStore } from "../store/settings.ts";
import { piEngineForSpec, type PiEngine, type ThinkingLevel } from "../agent/models.ts";
import { getHeadless, type HeadlessApi } from "../agent/subagents/headless.ts";
import { processImage } from "../agent/image-processing/index.ts";
import type { PdfPage } from "../agent/subagents/pdf-markdown.ts";

/**
 * The transcription prompt — ONE vision call per rendered page. Instructs
 * a verbatim Markdown transcription of handwritten/scanned notes: math in
 * LaTeX, headings/lists/structure preserved, illegible spans marked, no
 * commentary. Exported so tests can assert it carries the required rules.
 */
export const TRANSCRIPTION_PROMPT = `You are a handwriting transcription specialist. You are shown ONE rendered page of handwritten or scanned notes (often from an e-ink tablet). Transcribe it to Markdown.

Rules:
- Transcribe the page VERBATIM as Markdown — reproduce exactly what is written, in reading order.
- Render mathematics in LaTeX: inline math in $...$ and display math in $$...$$. Preserve the meaning of equations, symbols, and sub/superscripts.
- Preserve the page's structure: headings (as # / ## / ###), numbered and bulleted lists, paragraphs, tables, and emphasis as written.
- Keep the original wording and language. Do not summarize, paraphrase, correct, translate, or expand.
- Mark any span you genuinely cannot read as [illegible]. Do not guess illegible words.
- Output ONLY the transcribed Markdown for this page. No preamble, no headings you invented, no commentary, no notes about your process, no closing remarks.`;

/** Default DPI for handwriting — dense small strokes need more than the
 *  pdf-reader's 150 default; 200 matches the ocr tool's handwriting DPI. */
const TRANSCRIPTION_DPI = 200;

/** Default per-file page cap for transcription — vision calls are the slow
 *  part; beyond this, the first N are transcribed and the rest skipped
 *  with a notice (the route applies the cap and reports it). */
export const DEFAULT_TRANSCRIPTION_PAGE_CAP = 20;

/** Where transcriptions are cached, under the app data dir (PATHS.data). */
export function transcriptionCacheDir(): string {
	return path.join(PATHS.data, "pdf-transcriptions");
}

/** The cache key for one page: sha256 of the PDF file bytes + the page
 *  number. Stable across re-imports (same file → same key); a changed
 *  file (different bytes) gets a fresh key. Exported for tests. */
export function transcriptionCacheKey(pdfBytes: Uint8Array, page: number): string {
	const hash = createHash("sha256").update(pdfBytes).digest("hex");
	return `${hash}-p${page}.json`;
}

/** A single cached transcription record on disk. */
export interface CachedTranscription {
	page: number;
	markdown: string;
}

/** Read one page's cached transcription. Returns null on miss, absence,
 *  or ANY read/parse error — the cache never throws. Exported for tests. */
export async function readCachedTranscription(
	pdfBytes: Uint8Array,
	page: number,
	dir = transcriptionCacheDir(),
): Promise<CachedTranscription | null> {
	try {
		const file = path.join(dir, transcriptionCacheKey(pdfBytes, page));
		const raw = await fs.readFile(file, "utf8");
		const parsed = JSON.parse(raw) as Partial<CachedTranscription>;
		if (
			parsed &&
			typeof parsed.page === "number" &&
			parsed.page === page &&
			typeof parsed.markdown === "string"
		) {
			return { page: parsed.page, markdown: parsed.markdown };
		}
		return null;
	} catch {
		return null;
	}
}

/** Write one page's transcription to the cache. Never throws — a full disk
 *  or a permission error degrades to a no-op (re-import re-transcribes).
 *  Exported for tests. */
export async function writeCachedTranscription(
	pdfBytes: Uint8Array,
	page: number,
	markdown: string,
	dir = transcriptionCacheDir(),
): Promise<void> {
	try {
		await fs.mkdir(dir, { recursive: true });
		const file = path.join(dir, transcriptionCacheKey(pdfBytes, page));
		const payload: CachedTranscription = { page, markdown };
		await fs.writeFile(file, JSON.stringify(payload), "utf8");
	} catch {
		/* cache is best-effort; never block the import on it */
	}
}

/** Injectable dependencies for transcribePages — the engine seam (tests
 *  inject a fake; production resolves the vision slot), the headless
 *  renderer (tests inject a fake), and the per-page transcription function
 *  (tests inject a pure stub instead of a real model call). */
export interface TranscribeDeps {
	/** The vision engine to transcribe with. When absent, the module
	 *  resolves the vision slot from settings (resolveRoleSpec("pdfReader") →
	 *  piEngineForSpec); absent in tests that inject `transcribe`. */
	engine?: PiEngine;
	/** The headless renderer (tests inject a fake). */
	headless?: HeadlessApi;
	/** Test seam: a pure function that returns the Markdown for one rendered
	 *  PNG, instead of a real vision call. When set, transcribePages uses
	 *  it directly and skips the engine entirely (no network). */
	transcribe?: (png: Buffer, page: number) => Promise<string>;
	/** The PDF file bytes, when the caller already has them (the upload route
	 *  reads the File once). Used for the cache key, avoiding a second read of
	 *  pdfPath; absent → the module reads pdfPath for the key. */
	pdfBytes?: Uint8Array;
	/** Abort the transcription mid-call. */
	abortSignal?: AbortSignal;
	/** Optional usage callback (one vision call per page). */
	onUsage?: (usage: Usage) => void;
}

/** One page's transcription result. */
export interface PageTranscription {
	page: number;
	markdown: string;
}

/**
 * Transcribe the given pages of a PDF to Markdown via the vision slot.
 * Renders each page (dpi 200 for handwriting) and makes ONE vision call
 * per page with the transcription prompt. Hits the disk cache first — a
 * cached page skips both the render and the model call. Cache write is
 * best-effort (never throws).
 *
 * Reuse, don't rebuild: renderPdfPages (headless.ts) renders; the
 * image-in-the-loop call follows pdf-reader.ts / visual-maker.ts's exact
 * single-shot streamOnce shape (duplicated here — those modules keep it
 * private too).
 */
export async function transcribePages(
	pdfPath: string,
	pages: number[],
	deps: TranscribeDeps = {},
): Promise<PageTranscription[]> {
	const pdfBytes = deps.pdfBytes ?? new Uint8Array(await readFileSafe(pdfPath));
	const headless = deps.headless ?? getHeadless();
	const out: PageTranscription[] = [];
	for (const page of pages) {
		const cached = await readCachedTranscription(pdfBytes, page);
		if (cached) {
			out.push({ page: cached.page, markdown: cached.markdown });
			continue;
		}
		const rendered = await headless.renderPdfPages(pdfPath, [page], { dpi: TRANSCRIPTION_DPI });
		const png = rendered[0]?.png;
		if (!png) {
			// Nothing rendered (page out of range?) — skip rather than crash.
			continue;
		}
		let markdown: string;
		if (deps.transcribe) {
			markdown = (await deps.transcribe(png, page)).trim();
		} else {
			const engine = deps.engine ?? resolveVisionEngine();
			if (!engine) {
				throw new Error("Handwritten pages need a vision model — set one in Settings → Models.");
			}
			markdown = (await transcribeOnePage(engine, png, deps.abortSignal, deps.onUsage)).trim();
		}
		await writeCachedTranscription(pdfBytes, page, markdown);
		out.push({ page, markdown });
	}
	return out;
}

/** Resolve the vision slot engine (production path). The pdfReader role
 *  rides the vision slot (ROLE_SLOT), so the resolution is the same chain
 *  chat-handler's resolveEngine runs for that role. Returns undefined when
 *  the slot is unset (BYOK: no factory floor) — the caller refuses honestly.
 *  Exported so the route can check configured-ness without a render. */
export function resolveVisionEngine(): PiEngine | undefined {
	const spec = resolveRoleSpec("pdfReader", settingsStore.readSettings());
	if (!spec) return undefined;
	try {
		return piEngineForSpec(spec, true);
	} catch {
		// A misconfigured slot (model vanished from the catalog) is treated
		// as unconfigured — the caller refuses with the honest message.
		return undefined;
	}
}

/** The result of merging a converted PDF with its transcriptions — the
 *  shape readNotesFile returns for a successfully-handled PDF. */
export interface MergedNotes {
	/** The full Markdown, every content-bearing page headed `--- Page N ---`
	 *  (joinPages' convention), text and transcribed pages alike. */
	text: string;
	/** A user-facing notice (transcription count, page-cap skips, etc.). */
	notice: string;
}

/** The outcome of applying the per-file transcription page cap: which pages
 *  to transcribe and which to skip. Exported for tests. */
export interface PageCapPlan {
	/** The pages to transcribe (the first `cap` image-only pages, in order). */
	toTranscribe: number[];
	/** The image-only pages beyond the cap, skipped with a notice. */
	skipped: number[];
}

/** Split the image-only pages into a transcribe set (capped) and a skip set,
 *  preserving page order. Pure — exported for tests. */
export function planTranscriptionCap(
	imageOnlyPages: readonly number[],
	cap: number = DEFAULT_TRANSCRIPTION_PAGE_CAP,
): PageCapPlan {
	const sorted = [...imageOnlyPages].sort((a, b) => a - b);
	const toTranscribe = sorted.slice(0, cap);
	const skipped = sorted.slice(cap);
	return { toTranscribe, skipped };
}

/** Merge a converted PDF's pages with transcriptions of its image-only
 *  pages into one Markdown document + a notice, using joinPages' exact
 *  heading convention (`--- Page N ---\n\n<markdown>`, joined by `\n\n`).
 *
 *  - Text pages keep their extracted markdown verbatim.
 *  - Image-only pages with a transcription get the transcribed markdown.
 *  - Image-only pages WITHOUT a transcription (skipped past the cap, or a
 *    transcription that came back empty) are omitted, exactly as joinPages
 *    omits image-only pages — never an empty `--- Page N ---` heading.
 *  - `empty` pages (no text, no image) are omitted as before.
 *
 *  The notice reports how many pages were transcribed and, when the cap
 *  bit, how many were skipped. Pure — exported for tests (the test for the
 *  merge logic passes converted pages + a stub transcribe map; no network).
 */
export function mergeTranscribed(
	pages: readonly PdfPage[],
	transcriptions: ReadonlyMap<number, string>,
	skippedImageOnly: readonly number[] = [],
): MergedNotes {
	const blocks: string[] = [];
	for (const page of pages) {
		if (page.kind === "text") {
			if (page.markdown.trim()) blocks.push(`--- Page ${page.number} ---\n\n${page.markdown}`);
			continue;
		}
		// image-only (or empty): include only when a transcription exists.
		const md = transcriptions.get(page.number);
		if (md && md.trim()) blocks.push(`--- Page ${page.number} ---\n\n${md}`);
	}
	const text = blocks.join("\n\n");
	const transcribed = [...transcriptions.keys()].filter((p) => {
		const md = transcriptions.get(p);
		return md && md.trim() && pages.some((pg) => pg.number === p && pg.kind !== "text");
	}).length;
	const parts: string[] = [];
	if (transcribed > 0) {
		parts.push(`Transcribed ${transcribed} handwritten/scanned ${transcribed === 1 ? "page" : "pages"} with vision.`);
	}
	if (skippedImageOnly.length > 0) {
		parts.push(
			`${skippedImageOnly.length} handwritten/scanned ${skippedImageOnly.length === 1 ? "page" : "pages"} beyond the ${DEFAULT_TRANSCRIPTION_PAGE_CAP}-page transcription cap ${skippedImageOnly.length === 1 ? "was" : "were"} skipped — re-import with fewer pages or transcribe them in batches.`,
		);
	}
	return { text, notice: parts.join(" ") };
}

/** One vision call for one rendered page — the image-in-the-loop shape
 *  pdf-reader.ts / visual-maker.ts use (a hand-rolled streamOnce, because
 *  the image must reach THIS call's model, not ride tool plumbing). */
async function transcribeOnePage(
	engine: PiEngine,
	png: Buffer,
	abortSignal: AbortSignal | undefined,
	onUsage?: (usage: Usage) => void,
): Promise<string> {
	const image = await processImage(png, "image/png", {
		resizeOptions: engine.model.inputLimits?.images?.resize,
	});
	if (!image.ok) {
		throw new Error(`could not prepare the rendered page for the vision model — ${image.message}`);
	}
	const sessionId = randomUUID();
	const reasoning = engine.level;
	const messages: Message[] = [
		{
			role: "user",
			content: [
				{ type: "text", text: [TRANSCRIPTION_PROMPT, ...image.hints].join("\n") },
				{ type: "image", data: image.data, mimeType: image.mimeType },
			],
			timestamp: Date.now(),
		},
	];
	const result = await streamOnce(engine, TRANSCRIPTION_PROMPT, messages, sessionId, reasoning, abortSignal);
	onUsage?.(result.usage);
	const text = result.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("")
		.trim();
	return text;
}

/** One raw model call (no agent loop): the pdf-reader / visual-maker's
 *  streamOnce, duplicated here because those modules keep it private. */
async function streamOnce(
	engine: PiEngine,
	systemPrompt: string,
	messages: Message[],
	sessionId: string,
	reasoning: ThinkingLevel | undefined,
	abortSignal?: AbortSignal,
): Promise<AssistantMessage> {
	const stream = engine.streamFn(engine.model, normalizeContext({ systemPrompt, messages }), {
		sessionId,
		reasoning: reasoning && reasoning !== "off" ? reasoning : undefined,
		signal: abortSignal,
	} as never);
	for await (const event of stream) {
		if (event.type === "done") return event.message;
		if (event.type === "error") {
			if (event.reason === "aborted") {
				const err = new Error("aborted");
				err.name = "AbortError";
				throw err;
			}
			throw new Error(event.error.errorMessage ?? "the model call failed");
		}
	}
	throw new Error("the model stream ended without a result");
}

/** Read a file, rethrowing fs errors with the path (the route's refusal
 *  path needs a clear message). A missing/unreadable PDF is an import
 *  failure, not a silent skip. */
async function readFileSafe(pdfPath: string): Promise<ArrayBuffer> {
	try {
		const buf = await fs.readFile(pdfPath);
		// Copy into a fresh ArrayBuffer so the Uint8Array view is independent
		// of the Node Buffer's underlying pool (sha256 mutates nothing, but
		// the cache key bytes must be the file's, not a shared slab).
		const copy = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
		return copy;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`could not read PDF for transcription (${pdfPath}): ${msg}`);
	}
}
