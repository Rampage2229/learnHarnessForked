/**
 * THE AGENT-WRITTEN MEMORY TOOL (memory v2, personal fork) — pinned
 * behaviors:
 * 1. REGISTRATION: save_memory joins BOTH teaching registries (prober +
 *    teacher) ONLY when the composition root wires memorySave — the
 *    searchAvailable seam style (present = registered, absent = not;
 *    tests drive it), mirroring the graph-tools gating test.
 * 2. SEMANTICS: a clean save answers "Saved to memory."; a rejected save
 *    returns the wiring's error string as the RESULT (the model
 *    self-corrects — execute never throws, the graph tools' honesty rule).
 * 3. THE HANDLER WIRING: memorySaveWiring (the composition root's
 *    write-through) writes through the REAL memoryStore under a temp
 *    LH_DATA_DIR (the memory.test.ts discipline — the seam is set BEFORE
 *    any config-loading import, every app-module import is dynamic) and
 *    surfaces the store's rejection messages verbatim.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-memory-tool-"));
process.env.LH_DATA_DIR = TMP;

const { createProberTools, createTeacherTools } = await import("../src/agent/tools.ts");
const { memorySaveWiring } = await import("../src/server/chat-handler.ts");
const { memoryStore, MAX_MEMORY_TEXT } = await import("../src/store/memory.ts");
const { PATHS } = await import("../config.ts");
import type { JobStore } from "../src/core/ports.ts";

after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

// ─── fixtures (the graph-tools.test.ts shape) ────────────────────────────────

const stubJobStore = {
	createJob: (() => ({})) as never,
	getJob: (() => undefined) as never,
	listJobs: (() => []) as never,
	updateJob: (() => {}) as never,
} as unknown as JobStore;

const baseCtx = {
	chatId: "c1",
	deliver: () => {},
	jobStore: stubJobStore,
	spawn: () => {},
};

const saved: string[] = [];
const okSave = (text: string) => {
	saved.push(text);
	return { ok: true } as const;
};

// ─── registration (the factory gate) ────────────────────────────────────────

describe("save_memory — registration", () => {
	it("no memorySave in the prober context → the tool is absent (the seam decides)", () => {
		const tools = createProberTools({ ...baseCtx, chatStore: {} as never });
		assert.equal("save_memory" in tools, false);
	});

	it("no memorySave in the teacher context → the tool is absent", () => {
		const tools = createTeacherTools({ ...baseCtx, chatStore: {} as never });
		assert.equal("save_memory" in tools, false);
	});

	it("memorySave present → save_memory joins the prober registry beside the usual set", () => {
		const tools = createProberTools({ ...baseCtx, chatStore: {} as never, memorySave: okSave });
		assert.equal("save_memory" in tools, true);
	});

	it("memorySave present → save_memory joins the teacher registry beside the usual set", () => {
		const tools = createTeacherTools({ ...baseCtx, chatStore: {} as never, memorySave: okSave });
		assert.equal("save_memory" in tools, true);
	});
});

// ─── semantics ───────────────────────────────────────────────────────────────

describe("save_memory — execute", () => {
	it("a clean save returns the ack and the wiring saw the text", async () => {
		const tools = createProberTools({ ...baseCtx, chatStore: {} as never, memorySave: okSave });
		const out = (await tools.save_memory!.execute!("tc", { text: "the thesis draft lives in ~/writing/thesis" }))
			.details as string;
		assert.equal(out, "Saved to memory.");
		assert.deepEqual(saved, ["the thesis draft lives in ~/writing/thesis"]);
	});

	it("a rejected save returns the error string as the result — never a throw", async () => {
		const tools = createTeacherTools({
			...baseCtx,
			chatStore: {} as never,
			memorySave: () => ({ ok: false, error: "Memory text is limited to 2000 characters." }),
		});
		const out = (await tools.save_memory!.execute!("tc", { text: "anything at all" })).details as string;
		assert.equal(out, "Memory text is limited to 2000 characters.");
	});

	it("the schema bounds mirror the store's gates (3..2000 chars)", () => {
		const tools = createProberTools({ ...baseCtx, chatStore: {} as never, memorySave: okSave });
		const text = (tools.save_memory!.parameters as { properties: { text: { minLength?: number; maxLength?: number } } })
			.properties.text;
		assert.equal(text.minLength, 3);
		assert.equal(text.maxLength, 2000);
	});
});

// ─── the handler's write-through (real store, temp LH_DATA_DIR) ──────────────

describe("memorySaveWiring — the composition root's write-through", () => {
	it("PATHS.memory resolves inside the temp dir; a clean save writes through memoryStore", () => {
		assert.equal(PATHS.memory, path.join(TMP, "memory.json"));
		const save = memorySaveWiring();
		const res = save("my mandarin audio lives in ~/docs/mandarin");
		assert.deepEqual(res, { ok: true });
		assert.deepEqual(
			memoryStore.readMemory().map((e) => e.text),
			["my mandarin audio lives in ~/docs/mandarin"],
		);
	});

	it("the store's rejections surface as { ok: false, error } — empty and oversized text", () => {
		const save = memorySaveWiring();
		const empty = save("   ");
		assert.equal(empty.ok, false);
		assert.match(empty.error ?? "", /empty/);
		const oversized = save("x".repeat(MAX_MEMORY_TEXT + 1));
		assert.equal(oversized.ok, false);
		assert.match(oversized.error ?? "", /limited to 2000/);
		// The rejections wrote nothing.
		assert.equal(memoryStore.readMemory().length, 1);
	});
});
