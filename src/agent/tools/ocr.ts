import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { MAX_OUTPUT_BYTES } from "./fs-shared.ts";
import { pdfInfo, parsePageSpec } from "../subagents/pdf-ops.ts";

/**
 * The ocr tool (OCR wave, personal fork): the missing half of the PDF
 * story. Upstream's pdf pipeline extracts a TEXT LAYER (pdf.js) and
 * renders flagged pages for the VISION model — but a scanned or
 * handwritten page has NO text layer, and the vision slot isn't an OCR
 * engine. The learner's machine has tesseract + poppler; this tool puts
 * them to work: rasterize the requested pages (pdftoppm), run tesseract
 * per page, return the text with page citations.
 *
 * Honest limits, stated in the description and the docs: tesseract reads
 * PRINT well (scanned books, typed scans, screenshots). HANDWRITING is
 * weak — cursive especially; the vision model's page render remains the
 * better read for sloppy handwriting. This tool is the deterministic
 * first pass, not a magic eye.
 *
 * Injected deps (the search-adapters law): tests stub the binary runner,
 * never the network or the local install.
 */

export interface OcrDeps {
	/** Page count + per-page text-layer presence (pdf.js, pdf-ops). */
	info: typeof pdfInfo;
	/** pdftoppm: rasterize one PDF's given pages to PNGs in dir; returns
	 *  the image paths, sorted by page. */
	renderPdf: (pdfPath: string, dpi: number, pages: readonly number[], dir: string) => Promise<string[]>;
	/** tesseract: one image → text (stdout). */
	recognize: (imagePath: string, lang: string) => Promise<string>;
	/** The tesseract data languages actually installed. */
	langs: () => Promise<string[]>;
	/** The binary presence probe (empty string = the error hint). */
	which: (bin: string) => Promise<string | null>;
}

const realDeps: OcrDeps = {
	info: pdfInfo,
	async renderPdf(pdfPath, dpi, pages, dir) {
		// pdftoppm names pages with zero-padded numbers when the doc has
		// 10+ pages — read the dir back rather than predicting names.
		for (const page of pages) {
			await run("pdftoppm", ["-f", String(page), "-l", String(page), "-r", String(dpi), "-png", pdfPath, path.join(dir, `p${String(page).padStart(5, "0")}`)]);
		}
		const entries = await fs.readdir(dir);
		return entries.filter((f) => f.endsWith(".png")).sort().map((f) => path.join(dir, f));
	},
	async recognize(imagePath, lang) {
		return run("tesseract", [imagePath, "stdout", "-l", lang]);
	},
	async langs() {
		const out = await run("tesseract", ["--list-langs"]);
		return out.split("\n").map((l) => l.trim()).filter((l) => l && l !== "List of available languages" && !l.startsWith("Couldn't") && !l.includes("tessdata"));
	},
	async which(bin) {
		try {
			return await run("which", [bin]);
		} catch {
			return null;
		}
	},
};

/** One binary run: stdout, throws on non-zero with the stderr slice. */
async function run(bin: string, args: string[]): Promise<string> {
	return await new Promise((resolve, reject) => {
		const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				/* gone */
			}
		}, 60_000);
		child.stdout.on("data", (d) => (out += String(d)));
		child.stderr.on("data", (d) => (err += String(d)));
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve(out);
			else reject(new Error(`${bin} exited ${code}: ${err.slice(0, 200)}`));
		});
	});
}

const OCR_MAX_PAGES = 40;
const OCR_GUARD_MS = (OCR_MAX_PAGES + 10) * 5_000; // ~5s/page worst case + slack

const ocrInput = Type.Object({
	path: Type.String({
		minLength: 1,
		description:
			"Path to a PDF or an image (png/jpg/tiff). Relative paths and ~ resolve against the learner's home directory.",
	}),
	pages: Type.Optional(
		Type.String({
			description:
				'PDFs only — which pages to OCR, e.g. "3", "1-5,9", or "all". Default: every page, capped at 40 per call (pass a narrower range to continue).',
		}),
	),
	lang: Type.Optional(
		Type.String({
			description: 'Tesseract language code(s), "+"-joined — default "eng". Installed languages are reported when a code is missing.',
		}),
	),
	dpi: Type.Optional(
		Type.Integer({
			minimum: 72,
			maximum: 400,
			description: "Rasterization DPI for PDFs (default 200 — enough for print; 300 helps small handwriting).",
		}),
	),
});

export function ocrToolFor(deps: OcrDeps = realDeps): AgentTool<any> {
	const tool: AgentTool<typeof ocrInput> = {
		name: "ocr",
		label: "ocr",
		description:
			"OCR a PDF's pages or a standalone image with tesseract (the text layer pdf reading can't see: scans, print on paper). " +
			"Use it when pdf_extract/page text comes back empty for a page — a scanned or printed-on-paper document. " +
			"Honest limit: tesseract reads PRINT well, handwriting weakly (cursive poorly) — for sloppy handwriting prefer rendering the page and reading it visually. " +
			"Returns per-page text; 40 pages max per call.",
		parameters: ocrInput,
		executionMode: "sequential",
		execute: serverExecute(
			"ocr",
			ocrInput,
			async (input): Promise<string> => {
				const target = input.path.startsWith("~") ? path.join(os.homedir(), input.path.slice(1)) : path.isAbsolute(input.path) ? input.path : path.join(os.homedir(), input.path);
				if (!await deps.which("tesseract")) {
					return "OCR needs tesseract, which is not installed (install tesseract-ocr).";
				}
				const isPdf = /\.pdf$/i.test(target);
				let stat: Stats | null = null;
				try {
					stat = await fs.stat(target);
				} catch {
					/* handled below */
				}
				if (!stat) return `No file at ${target}.`;
				if (!isPdf && !/\.(png|jpe?g|tiff?|bmp|ppm)$/i.test(target)) {
					return `${target}: not a PDF or a raster image — OCR covers pdf/png/jpg/tiff/bmp.`;
				}
				const lang = input.lang?.trim() || "eng";
				const available = await deps.langs().catch(() => [] as string[]);
				if (available.length > 0) {
					const missing = lang.split("+").filter((code) => !available.includes(code.trim()));
					if (missing.length > 0) {
						return `Tesseract lacks language(s): ${missing.join(", ")}. Installed: ${available.join(", ")}. (Language packs ship as tesseract-ocr-<lang> packages.)`;
					}
				}
				const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-ocr-"));
				try {
					let rendered: string[] = [];
					if (isPdf) {
						const info = await deps.info(target);
						const wanted = parsePageSpec(input.pages?.trim() || "all", info.page_count);
						if (wanted.length === 0) return `No pages matched "${input.pages}" — the PDF has ${info.page_count} page(s).`;
						if (wanted.length > OCR_MAX_PAGES) {
							return (
								`${wanted.length} pages exceed the ${OCR_MAX_PAGES}-page call cap. ` +
								`OCR in slices, e.g. pages "1-${OCR_MAX_PAGES}" then "${OCR_MAX_PAGES + 1}-${Math.min(wanted.length, 2 * OCR_MAX_PAGES)}".`
							);
						}
						rendered = await deps.renderPdf(target, input.dpi ?? 200, wanted, dir);
					} else {
						rendered = [target];
					}
					const sections: string[] = [];
					let totalBytes = 0;
					for (let i = 0; i < rendered.length; i++) {
						const label = isPdf ? `page ${i + 1}` : "image";
						const text = (await deps.recognize(rendered[i]!, lang)).trim();
						const body = text.length > 0 ? text : "(nothing recognized on this page)";
						sections.push(`── ${label} ──\n${body}`);
						totalBytes += Buffer.byteLength(sections.at(-1)!, "utf-8");
						if (totalBytes > MAX_OUTPUT_BYTES) {
							sections.push(`[Output truncated at 50KB — ${rendered.length - i - 1} page(s) unread; OCR the rest with a narrower pages range]`);
							break;
						}
					}
					return sections.join("\n\n");
				} catch (err) {
					return `OCR failed: ${err instanceof Error ? err.message : String(err)}`;
				} finally {
					await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
				}
			},
			{ timeoutMs: OCR_GUARD_MS },
		),
	};
	return tool;
}
