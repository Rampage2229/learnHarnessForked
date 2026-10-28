/**
 * User memory (memory v1, personal fork): store CRUD round-trips + the
 * 200-entry cap + the 2000-char gate, the prompt-block renderer (null when
 * empty, newest-first bullets, the capped truncation note), and the API
 * routes driven directly with Request objects (the custom-providers.test.ts
 * precedent). Hermetic: LH_DATA_DIR relocates to a fresh tmp dir BEFORE any
 * module import (the server-keys.test.ts discipline — config.ts is
 * module-load bound).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-memory-"));
process.env.LH_DATA_DIR = TMP;

const { memoryStore, MAX_MEMORY_ENTRIES, MAX_MEMORY_TEXT } = await import("../src/store/memory.ts");
const { renderMemoryBlock, MEMORY_BLOCK_MAX_CHARS } = await import("../src/server/memory.ts");
const { PATHS } = await import("../config.ts");
const memoryRoute = await import("../app/api/memory/route.ts");
const memoryItemRoute = await import("../app/api/memory/[id]/route.ts");

function jsonRequest(method: string, url: string, body?: unknown): Request {
	return new Request(url, {
		method,
		headers: body !== undefined ? { "content-type": "application/json" } : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
}

/** A blank slate: every describe below controls its own starting state. */
function clearAll(): void {
	for (const e of memoryStore.readMemory()) memoryStore.deleteMemoryEntry(e.id);
}

after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

describe("the store file seam", () => {
	it("PATHS.memory resolves inside LH_DATA_DIR; missing file reads []", () => {
		assert.equal(PATHS.memory, path.join(TMP, "memory.json"));
		assert.deepEqual(memoryStore.readMemory(), []);
		assert.equal(renderMemoryBlock(), null, "no memories → no prompt block");
	});
});

describe("renderMemoryBlock", () => {
	it("bullets every entry, NEWEST FIRST, under the header", () => {
		clearAll();
		const a = memoryStore.addMemoryEntry("my mandarin files are in ~/docs/mandarin");
		const b = memoryStore.addMemoryEntry("the thesis draft lives in ~/writing/thesis");
		const block = renderMemoryBlock();
		assert.ok(block, "populated → a block");
		assert.ok(block.startsWith("USER MEMORY — standing context the learner asked you to keep in mind:\n"));
		assert.ok(block.includes(`- ${a.text}`));
		assert.ok(block.includes(`- ${b.text}`));
		assert.ok(block.indexOf(`- ${b.text}`) < block.indexOf(`- ${a.text}`), "newest first");
	});

	it("capped: the block fits, the newest survive, the oldest drop WITH a note", () => {
		clearAll();
		const oldest = memoryStore.addMemoryEntry(`oldest-marker ${"a".repeat(MAX_MEMORY_TEXT - 14)}`);
		memoryStore.addMemoryEntry(`middle-marker ${"b".repeat(MAX_MEMORY_TEXT - 14)}`);
		const newest = memoryStore.addMemoryEntry(`newest-marker ${"c".repeat(MAX_MEMORY_TEXT - 15)}`);
		const block = renderMemoryBlock();
		assert.ok(block);
		assert.ok(block.length <= MEMORY_BLOCK_MAX_CHARS, `capped at ${MEMORY_BLOCK_MAX_CHARS}`);
		assert.ok(/older entries? omitted/.test(block), "the truncation is noted");
		assert.ok(block.includes(newest.text), "the newest entry survives the cap");
		assert.ok(!block.includes(oldest.text), "the oldest entry is what drops");
	});
});

describe("store CRUD round-trip", () => {
	it("add → read → update → delete", () => {
		clearAll();
		const added = memoryStore.addMemoryEntry("  my mandarin files are in ~/docs/mandarin  ");
		assert.match(added.id, /^mem_[0-9a-f]{12}$/);
		assert.equal(added.text, "my mandarin files are in ~/docs/mandarin", "trimmed");
		assert.ok(!Number.isNaN(Date.parse(added.createdAt)), "ISO createdAt");
		assert.equal(added.updatedAt, added.createdAt);

		assert.deepEqual(memoryStore.readMemory(), [added], "newest-last: the single entry");
		const before = memoryStore.readMemory()[0]!;
		const updated = memoryStore.updateMemoryEntry(added.id, "moved to ~/audio/mandarin");
		assert.equal(updated.text, "moved to ~/audio/mandarin");
		assert.equal(updated.createdAt, before.createdAt, "createdAt — and so the order — stays put");
		assert.ok(!Number.isNaN(Date.parse(updated.updatedAt)));
		assert.deepEqual(memoryStore.readMemory(), [updated]);
		assert.ok(memoryStore.deleteMemoryEntry(added.id), "delete of a known id");
		assert.deepEqual(memoryStore.readMemory(), []);
		assert.ok(!memoryStore.deleteMemoryEntry(added.id), "unknown id → false (the route's 404)");
	});

	it("the text gates: empty-after-trim and >2000 chars reject with thrown Errors", () => {
		assert.throws(() => memoryStore.addMemoryEntry("   "), /empty/);
		assert.throws(() => memoryStore.addMemoryEntry("x".repeat(MAX_MEMORY_TEXT + 1)), /limited to 2000/);
		assert.throws(() => memoryStore.updateMemoryEntry("mem_000000000000", "x"), /Unknown memory entry/);
		// exactly at the ceiling passes (the gate is exclusive)
		const atCeiling = memoryStore.addMemoryEntry("y".repeat(MAX_MEMORY_TEXT));
		assert.equal(atCeiling.text.length, MAX_MEMORY_TEXT);
		memoryStore.deleteMemoryEntry(atCeiling.id);
	});
});

describe("the 200-entry cap", () => {
	it("add beyond the cap evicts the OLDEST", () => {
		clearAll();
		for (let i = 0; i <= MAX_MEMORY_ENTRIES; i++) {
			memoryStore.addMemoryEntry(`m-${String(i).padStart(3, "0")}`);
		}
		const entries = memoryStore.readMemory();
		assert.equal(entries.length, MAX_MEMORY_ENTRIES);
		assert.equal(entries[0]!.text, "m-001", "m-000 (the oldest) was evicted");
		assert.equal(entries[entries.length - 1]!.text, `m-${String(MAX_MEMORY_ENTRIES).padStart(3, "0")}`, "newest-last");
	});
});

describe("route handlers", () => {
	it("GET is newest-first; POST 201s the trimmed entry; bad bodies are 400s", async () => {
		clearAll();
		await memoryRoute.POST(jsonRequest("POST", "http://localhost/api/memory", { text: "first note" }));
		const second = await memoryRoute.POST(jsonRequest("POST", "http://localhost/api/memory", { text: "  second note  " }));
		assert.equal(second.status, 201);
		const saved = (await second.json()) as { entry: { id: string; text: string } };
		assert.equal(saved.entry.text, "second note", "trimmed");
		assert.match(saved.entry.id, /^mem_[0-9a-f]{12}$/);

		const get = await memoryRoute.GET();
		assert.equal(get.status, 200);
		const list = (await get.json()) as { entries: Array<{ id: string; text: string }> };
		assert.equal(list.entries.length, 2);
		assert.equal(list.entries[0]!.text, "second note", "newest-first for the UI");
		assert.equal(list.entries[1]!.text, "first note");

		const empty = await memoryRoute.POST(jsonRequest("POST", "http://localhost/api/memory", { text: "   " }));
		assert.equal(empty.status, 400);
		const oversized = await memoryRoute.POST(jsonRequest("POST", "http://localhost/api/memory", { text: "x".repeat(MAX_MEMORY_TEXT + 1) }));
		assert.equal(oversized.status, 400);
		const wrongShape = await memoryRoute.POST(jsonRequest("POST", "http://localhost/api/memory", { text: 5 }));
		assert.equal(wrongShape.status, 400);
		const badJson = await memoryRoute.POST(new Request("http://localhost/api/memory", { method: "POST", body: "{", headers: { "content-type": "application/json" } }));
		assert.equal(badJson.status, 400);
		assert.equal(memoryStore.readMemory().length, 2, "rejections wrote nothing");
	});

	it("DELETE: 200 {} for a known id, 404 for an unknown one", async () => {
		clearAll();
		const added = memoryStore.addMemoryEntry("doomed note");
		const del = await memoryItemRoute.DELETE(
			new Request(`http://localhost/api/memory/${added.id}`, { method: "DELETE" }),
			{ params: Promise.resolve({ id: added.id }) },
		);
		assert.equal(del.status, 200);
		assert.deepEqual(await del.json(), {});
		assert.deepEqual(memoryStore.readMemory(), []);
		const missing = await memoryItemRoute.DELETE(
			new Request("http://localhost/api/memory/mem_000000000000", { method: "DELETE" }),
			{ params: Promise.resolve({ id: "mem_000000000000" }) },
		);
		assert.equal(missing.status, 404);
	});
});

describe("sanitize safety — a hostile file never throws, never lies", () => {
	it("corrupt JSON, wrong shapes, and a future version all read []", () => {
		fs.writeFileSync(PATHS.memory, "{not json", "utf-8");
		assert.deepEqual(memoryStore.readMemory(), []);
		assert.equal(renderMemoryBlock(), null);

		fs.writeFileSync(PATHS.memory, JSON.stringify([1, 2, 3]), "utf-8");
		assert.deepEqual(memoryStore.readMemory(), [], "a top-level array is not a memory file");

		fs.writeFileSync(
			PATHS.memory,
			JSON.stringify({ version: 99, entries: [{ id: "mem_aaaaaaaaaaaa", text: "from the future", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }] }),
			"utf-8",
		);
		assert.deepEqual(memoryStore.readMemory(), [], "a NEWER format stamp is refused (the chats.ts precedent)");

		fs.writeFileSync(
			PATHS.memory,
			JSON.stringify({
				entries: [
					{ id: "mem_bbbbbbbbbbbb", text: "kept", createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
					"junk string",
					42,
					{ id: 7, text: "no" },
					{ text: "no id" },
				],
			}),
			"utf-8",
		);
		const kept = memoryStore.readMemory();
		assert.equal(kept.length, 1, "malformed entries are filtered, the rest survives");
		assert.equal(kept[0]!.text, "kept");
		assert.equal(memoryStore.deleteMemoryEntry(kept[0]!.id), true, "the store still writes sanely after a hostile read");
	});
});
