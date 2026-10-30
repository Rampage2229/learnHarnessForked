/**
 * Nextcloud sync (personal fork): the pure planner (the decision core),
 * the config/state store, and the route's password redaction. Hermetic —
 * LH_DATA_DIR set before the store loads; the planner needs no seam.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-"));
process.env.LH_DATA_DIR = TMP;

const { planSync } = await import("../src/core/sync-plan.ts");
const { readSyncConfig, writeSyncConfig } = await import("../src/store/sync.ts");
const route = await import("../app/api/sync/route.ts");

after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

const L = (path: string, mtimeMs: number, size = 10, kind: "json" | "jsonl" = "json") => ({ path, mtimeMs, size, kind });
const R = (path: string, mtimeMs: number, size = 10, kind: "json" | "jsonl" = "json") => ({ path, mtimeMs, size, kind });
const S = (path: string, lm: number, ls: number, rm: number, rs: number) => ({ [path]: { local: { mtimeMs: lm, size: ls }, remote: { mtimeMs: rm, size: rs } } });

describe("planSync", () => {
	it("new local → upload; new remote → download", () => {
		const actions = planSync({
			local: [L("a.json", 100)],
			remote: [R("b.json", 100)],
			state: {},
		});
		assert.deepEqual(actions, [
			{ path: "a.json", type: "upload" },
			{ path: "b.json", type: "download" },
		]);
	});

	it("changed sides propagate; unchanged skip", () => {
		const actions = planSync({
			local: [L("x.json", 200, 11), L("y.json", 500, 10)],
			remote: [R("x.json", 100, 10), R("y.json", 600, 12)],
			state: { ...S("x.json", 100, 10, 100, 10), ...S("y.json", 500, 10, 500, 10) },
		});
		assert.deepEqual(actions, [
			{ path: "x.json", type: "upload" },
			{ path: "y.json", type: "download" },
		]);
	});

	it("both-changed jsonl merges; both-changed json resolves by mtime", () => {
		const actions = planSync({
			local: [L("g.jsonl", 300, 10, "jsonl"), L("a.json", 300, 10)],
			remote: [R("g.jsonl", 200, 10, "jsonl"), R("a.json", 400, 10)],
			state: { ...S("g.jsonl", 100, 10, 100, 10), ...S("a.json", 100, 10, 100, 10) },
		});
		assert.deepEqual(actions, [
			{ path: "g.jsonl", type: "mergeJsonl" },
			{ path: "a.json", type: "conflictKeepRemote" }, // remote mtime 400 > local 300
		]);
	});

	it("deletions propagate unless the other side edited (edit wins over delete)", () => {
		const actions = planSync({
			local: [L("gone.json", 100), L("kept.json", 200, 12)],
			remote: [R("kept.json", 100, 10)],
			state: {
				...S("gone.json", 100, 10, 100, 10), // remote deleted? no — gone is LOCAL present, remote missing, unchanged → deleteLocal
				...S("kept.json", 100, 10, 100, 10),
			},
		});
		// gone.json: local present, remote missing, local unchanged → deleteLocal
		// kept.json: local changed (200/12), remote unchanged → upload
		assert.deepEqual(actions, [
			{ path: "gone.json", type: "deleteLocal" },
			{ path: "kept.json", type: "upload" },
		]);
	});

	it("local deleted + remote unchanged → deleteRemote; remote edited → download", () => {
		const actions = planSync({
			local: [L("edited.json", 300, 12)],
			remote: [R("plain.json", 100, 10), R("edited.json", 100, 10)],
			state: {
				...S("plain.json", 100, 10, 100, 10), // local missing, remote present+unchanged → deleteRemote
				...S("edited.json", 100, 10, 100, 10), // remote unchanged; local present+changed → upload
			},
		});
		assert.deepEqual(actions, [
			{ path: "edited.json", type: "upload" },
			{ path: "plain.json", type: "deleteRemote" },
		]);
	});
});

describe("store/sync config", () => {
	it("round-trips the config including the password; hostile file → default", () => {
		writeSyncConfig({ serverUrl: "https://cloud.example.com", username: "me", password: "secret", enabled: true, autoSyncMinutes: 0 });
		const cfg = readSyncConfig();
		assert.equal(cfg.serverUrl, "https://cloud.example.com");
		assert.equal(cfg.password, "secret");
		assert.equal(cfg.enabled, true);
	});
});

describe("GET /api/sync redaction", () => {
	it("never returns the password; exposes hasPassword", async () => {
		writeSyncConfig({ serverUrl: "https://cloud.example.com", username: "me", password: "hunter2", enabled: false, autoSyncMinutes: 0 });
		const res = await route.GET();
		const body = (await res.json()) as Record<string, unknown>;
		assert.equal(body.password, undefined);
		assert.equal(body.hasPassword, true);
		assert.equal(body.username, "me");
	});
});
describe("sync-plan degenerate-listing interlock", () => {
	it("refuses to plan when tracked files are missing from BOTH listings", () => {
		const actions = planSync({
			local: [], // listing came back EMPTY (throttled server)
			remote: [],
			state: { ...S("chats/a.json", 100, 10, 100, 10), ...S("graph/nodes.jsonl", 100, 10, 100, 10) },
		});
		assert.equal(actions.length, 1);
		assert.equal(actions[0]!.type, "deleteLocal");
		assert.match(actions[0]!.path, /refusing to plan/);
	});

	it("still plans normally when the listings are healthy", () => {
		const actions = planSync({
			local: [L("chats/a.json", 200, 12)],
			remote: [R("chats/a.json", 100, 10)],
			state: S("chats/a.json", 100, 10, 100, 10),
		});
		assert.deepEqual(actions, [{ path: "chats/a.json", type: "upload" }]);
	});
});
