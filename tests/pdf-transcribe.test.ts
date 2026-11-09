/**
 * Vision transcription (notes-import path, personal fork) — hermetic
 * tests for the disk cache, the prompt/structure merge, and transcribePages
 * with an INJECTED transcription function (no network, no real PDF, no native
 * canvas). Mirrors tests/reviews.test.ts: LH_DATA_DIR is pointed at a tmp dir
 * BEFORE the module loads so PATHS.data (the cache root) is isolated.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-pdf-transcribe-"));
process.env.LH_DATA_DIR = TMP;

const mod = await import("../src/server/pdf-transcribe.ts");
const {
	transcriptionCacheDir,
	transcriptionCacheKey,
	readCachedTranscription,
	writeCachedTranscription,
	transcribePages,
	mergeTranscribed,
	planTranscriptionCap,
	TRANSCRIPTION_PROMPT,
	DEFAULT_TRANSCRIPTION_PAGE_CAP,
} = mod;

after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

// ─── cache helpers ───────────────────────────────────────────────────────────

const BYTES_A = new Uint8Array([1, 2, 3, 4, 5, 6]);
const BYTES_B = new Uint8Array([9, 9, 9]); // a different file → a different key

/** A fake headless renderer: returns a deterministic PNG per page, never
 *  touches a real file or native canvas. */
function fakeHeadless() {
	return {
		available: () => true,
		unavailableReason: () => null,
		runDemo: async () => { throw new Error("not used"); },
		renderSvg: async () => { throw new Error("not used"); },
		renderPdfPages: async (_pdfPath: string, pages: number[]) =>
			pages.map((page) => ({ page, png: Buffer.from(`png-${page}`) })),
	};
}

describe("transcription cache", () => {
	it("miss → write → hit", async () => {
		const dir = path.join(TMP, "cache-basic");
		assert.equal(await readCachedTranscription(BYTES_A, 1, dir), null);
		await writeCachedTranscription(BYTES_A, 1, "# Page 1 notes", dir);
		const hit = await readCachedTranscription(BYTES_A, 1, dir);
		assert.deepEqual(hit, { page: 1, markdown: "# Page 1 notes" });
	});

	it("different file bytes → different key (no cross-file hit)", async () => {
		const dir = path.join(TMP, "cache-keying");
		await writeCachedTranscription(BYTES_A, 1, "A-page-1", dir);
		// BYTES_B has different bytes → its page-1 key differs → miss.
		assert.equal(await readCachedTranscription(BYTES_B, 1, dir), null);
		await writeCachedTranscription(BYTES_B, 1, "B-page-1", dir);
		assert.equal((await readCachedTranscription(BYTES_A, 1, dir))!.markdown, "A-page-1");
		assert.equal((await readCachedTranscription(BYTES_B, 1, dir))!.markdown, "B-page-1");
	});

	it("corrupt cache file is tolerated (treated as a miss, never throws)", async () => {
		const dir = path.join(TMP, "cache-corrupt");
		const key = transcriptionCacheKey(BYTES_A, 7);
		await fs.promises.mkdir(dir, { recursive: true });
		await fs.promises.writeFile(path.join(dir, key), "{not valid json", "utf8");
		// read returns null instead of throwing; a write then repairs it.
		assert.equal(await readCachedTranscription(BYTES_A, 7, dir), null);
		await writeCachedTranscription(BYTES_A, 7, "recovered", dir);
		assert.equal((await readCachedTranscription(BYTES_A, 7, dir))!.markdown, "recovered");
	});

	it("a record with the wrong page number is rejected (no silent mismatch)", async () => {
		const dir = path.join(TMP, "cache-mismatch");
		const key = transcriptionCacheKey(BYTES_A, 3);
		await fs.promises.mkdir(dir, { recursive: true });
		// Page 3 key but the record claims page 99 — must not be served for page 3.
		await fs.promises.writeFile(path.join(dir, key), JSON.stringify({ page: 99, markdown: "wrong" }), "utf8");
		assert.equal(await readCachedTranscription(BYTES_A, 3, dir), null);
	});

	it("writeCachedTranscription never throws on an unwritable dir", async () => {
		// A path under a file (not a dir) as the cache root → mkdir fails; the
		// write must swallow it rather than reject.
		const blocker = path.join(TMP, "cache-blocker-file");
		await fs.promises.writeFile(blocker, "x", "utf8");
		const dir = path.join(blocker, "nested"); // parent is a file → mkdir throws
		await assert.doesNotReject(() => writeCachedTranscription(BYTES_A, 1, "x", dir));
		assert.equal(await readCachedTranscription(BYTES_A, 1, dir), null);
	});

	it("cache key is sha256(bytes)-pN.json", () => {
		const key = transcriptionCacheKey(BYTES_A, 12);
		assert.match(key, /^[0-9a-f]{64}-p12\.json$/);
	});
});

describe("transcription prompt", () => {
	it("instructs verbatim Markdown, LaTeX math, structure, [illegible], no commentary", () => {
		assert.match(TRANSCRIPTION_PROMPT, /VERBATIM as Markdown/i);
		assert.match(TRANSCRIPTION_PROMPT, /LaTeX/i);
		assert.match(TRANSCRIPTION_PROMPT, /\$.*\$.*\$\$.*\$\$/s); // inline + display math
		assert.match(TRANSCRIPTION_PROMPT, /headings|lists|structure/i);
		assert.match(TRANSCRIPTION_PROMPT, /\[illegible\]/);
		assert.match(TRANSCRIPTION_PROMPT, /no commentary|no preamble|ONLY the transcribed/i);
	});
});

describe("planTranscriptionCap (page cap)", () => {
	it("caps at the default and reports the skipped remainder", () => {
		const pages = Array.from({ length: DEFAULT_TRANSCRIPTION_PAGE_CAP + 5 }, (_, i) => i + 1);
		const plan = planTranscriptionCap(pages);
		assert.equal(plan.toTranscribe.length, DEFAULT_TRANSCRIPTION_PAGE_CAP);
		assert.deepEqual(plan.toTranscribe, pages.slice(0, DEFAULT_TRANSCRIPTION_PAGE_CAP));
		assert.deepEqual(plan.skipped, pages.slice(DEFAULT_TRANSCRIPTION_PAGE_CAP));
	});

	it("under the cap transcribes all, skips none", () => {
		const plan = planTranscriptionCap([3, 1, 2], 20);
		assert.deepEqual(plan.toTranscribe, [1, 2, 3]); // sorted
		assert.deepEqual(plan.skipped, []);
	});

	it("honors a custom cap and preserves order", () => {
		const plan = planTranscriptionCap([5, 2, 1, 4, 3], 2);
		assert.deepEqual(plan.toTranscribe, [1, 2]);
		assert.deepEqual(plan.skipped, [3, 4, 5]);
	});
});

describe("mergeTranscribed (text + transcribed pages → one Markdown)", () => {
	it("text pages keep their markdown; image-only pages get the transcription", () => {
		const pages = [
			{ kind: "text" as const, number: 1, markdown: "# Lecture\n\nIntro paragraph." },
			{ kind: "image-only" as const, number: 2 },
			{ kind: "text" as const, number: 3, markdown: "More text." },
		];
		const transcriptions = new Map([[2, "Handwritten notes for page 2."]]);
		const merged = mergeTranscribed(pages, transcriptions);
		assert.equal(
			merged.text,
			[
				"--- Page 1 ---\n\n# Lecture\n\nIntro paragraph.",
				"--- Page 2 ---\n\nHandwritten notes for page 2.",
				"--- Page 3 ---\n\nMore text.",
			].join("\n\n"),
		);
		assert.match(merged.notice, /Transcribed 1 handwritten\/scanned page with vision\./);
	});

	it("uses joinPages' exact heading convention (--- Page N ---\\n\\n<md>, \\n\\n-joined)", () => {
		const pages = [
			{ kind: "text" as const, number: 1, markdown: "A" },
			{ kind: "image-only" as const, number: 2 },
		];
		const merged = mergeTranscribed(pages, new Map([[2, "B"]]));
		assert.equal(merged.text, "--- Page 1 ---\n\nA\n\n--- Page 2 ---\n\nB");
	});

	it("omits image-only pages with no transcription (no empty heading)", () => {
		const pages = [
			{ kind: "text" as const, number: 1, markdown: "A" },
			{ kind: "image-only" as const, number: 2 }, // no transcription
		];
		const merged = mergeTranscribed(pages, new Map());
		assert.equal(merged.text, "--- Page 1 ---\n\nA");
		assert.equal(merged.notice, ""); // nothing transcribed
	});

	it("omits empty text pages and empty transcriptions", () => {
		const pages = [
			{ kind: "text" as const, number: 1, markdown: "   " }, // whitespace-only
			{ kind: "image-only" as const, number: 2 },
			{ kind: "text" as const, number: 3, markdown: "C" },
		];
		const merged = mergeTranscribed(pages, new Map([[2, "  \n  "]])); // blank transcription
		assert.equal(merged.text, "--- Page 3 ---\n\nC");
		assert.equal(merged.notice, "");
	});

	it("skipped (cap) pages appear in the notice, not the text", () => {
		const pages = [
			{ kind: "image-only" as const, number: 1 },
			{ kind: "image-only" as const, number: 2 },
		];
		// Only page 1 transcribed; page 2 skipped past the cap.
		const merged = mergeTranscribed(pages, new Map([[1, "p1 notes"]]), [2]);
		assert.equal(merged.text, "--- Page 1 ---\n\np1 notes");
		assert.match(merged.notice, /Transcribed 1 handwritten\/scanned page with vision\./);
		assert.match(merged.notice, /1 handwritten\/scanned page beyond the 20-page transcription cap was skipped/);
	});

	it("pluralizes page/pages correctly in the skip notice", () => {
		const pages = [
			{ kind: "image-only" as const, number: 1 },
			{ kind: "image-only" as const, number: 2 },
			{ kind: "image-only" as const, number: 3 },
		];
		const merged = mergeTranscribed(pages, new Map([[1, "p1"]]), [2, 3]);
		assert.match(merged.notice, /2 handwritten\/scanned pages beyond the 20-page transcription cap were skipped/);
	});

	it("empty pages are omitted as before", () => {
		const pages = [
			{ kind: "empty" as const, number: 1 },
			{ kind: "text" as const, number: 2, markdown: "real" },
		];
		const merged = mergeTranscribed(pages, new Map());
		assert.equal(merged.text, "--- Page 2 ---\n\nreal");
		assert.equal(merged.notice, "");
	});
});

describe("transcribePages (injected transcription, no network/PDF)", () => {
	const headless = fakeHeadless();

	it("miss → transcribe → write; re-run is a cache HIT (stub called once per page)", async () => {
		const calls: number[] = [];
		const transcribe = async (_png: Buffer, page: number) => {
			calls.push(page);
			return `Transcription of page ${page}.`;
		};
		// Isolate the cache dir for this file's bytes by using unique bytes.
		const bytes = new Uint8Array([42, 42, 42]);
		const r1 = await transcribePages("ignored-by-fake.pdf", [1, 2], {
			headless,
			transcribe,
			pdfBytes: bytes,
		});
		assert.deepEqual(r1, [
			{ page: 1, markdown: "Transcription of page 1." },
			{ page: 2, markdown: "Transcription of page 2." },
		]);
		assert.deepEqual(calls, [1, 2]);

		// Second run: the cache serves both — the stub is NOT called again.
		const r2 = await transcribePages("ignored-by-fake.pdf", [1, 2], {
			headless,
			transcribe,
			pdfBytes: bytes,
		});
		assert.deepEqual(r2, r1);
		assert.deepEqual(calls, [1, 2], "the stub was not called on the cache hit");
	});

	it("corrupt cache falls back to a fresh transcription (no throw)", async () => {
		const bytes = new Uint8Array([7, 7, 7]);
		// Seed a corrupt cache file for page 1 under the real cache dir.
		const key = transcriptionCacheKey(bytes, 1);
		const dir = transcriptionCacheDir();
		await fs.promises.mkdir(dir, { recursive: true });
		await fs.promises.writeFile(path.join(dir, key), "garbage", "utf8");

		const transcribe = async (_png: Buffer, page: number) => `Fresh ${page}`;
		const r = await transcribePages("ignored-by-fake.pdf", [1], {
			headless,
			transcribe,
			pdfBytes: bytes,
		});
		assert.deepEqual(r, [{ page: 1, markdown: "Fresh 1" }]);
		// The corrupt file was overwritten with the valid transcription.
		const hit = await readCachedTranscription(bytes, 1);
		assert.equal(hit!.markdown, "Fresh 1");
	});

	it("a page that renders nothing is skipped (not crashed, not cached)", async () => {
		const bytes = new Uint8Array([13]);
		const emptyHeadless = {
			...headless,
			renderPdfPages: async () => [], // renderer returns no PNG
		};
		const transcribe = async () => "should not be called";
		const r = await transcribePages("ignored.pdf", [1, 2], {
			headless: emptyHeadless,
			transcribe,
			pdfBytes: bytes,
		});
		assert.deepEqual(r, []);
	});

	it("passes the rendered PNG to the transcription stub", async () => {
		const bytes = new Uint8Array([99]);
		let seenPng: Buffer | null = null;
		const transcribe = async (png: Buffer, _page: number) => {
			seenPng = png;
			return "ok";
		};
		await transcribePages("ignored.pdf", [1], { headless, transcribe, pdfBytes: bytes });
		assert.deepEqual(seenPng, Buffer.from("png-1"));
	});
});

describe("transcribePages respects page order and dedupes", () => {
	it("returns pages in the requested order", async () => {
		const headless = fakeHeadless();
		const bytes = new Uint8Array([55]);
		const transcribe = async (_png: Buffer, page: number) => `p${page}`;
		const r = await transcribePages("ignored.pdf", [3, 1, 2], { headless, transcribe, pdfBytes: bytes });
		assert.deepEqual(r.map((x) => x.page), [3, 1, 2]);
		assert.deepEqual(r.map((x) => x.markdown), ["p3", "p1", "p2"]);
	});
});
