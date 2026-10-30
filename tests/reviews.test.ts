/**
 * Review ledger (review v1, personal fork): the pure folds — fold states,
 * the SM-2-lite due ladder, staleness color mapping — plus the store
 * append/read round-trip and the transcript→review extraction. Hermetic:
 * LH_DATA_DIR is pointed at a tmp dir BEFORE the store modules load.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-reviews-"));
process.env.LH_DATA_DIR = TMP;

const core = await import("../src/core/reviews.ts");
const { appendReview, reviewStates, dueNodeIds } = await import("../src/store/reviews.ts");
const { reviewEntriesFromMessages } = await import("../src/server/review-record.ts");

after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

const NOW = new Date("2026-10-29T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 3600 * 1000).toISOString();

describe("core/reviews folds", () => {
	it("foldReviewStates keeps lastAt/lastOutcome and accumulates counts", () => {
		const states = core.foldReviewStates([
			{ nodeId: "n1", chatId: "c1", at: daysAgo(2), outcome: "correct", source: "quiz" },
			{ nodeId: "n1", chatId: "c1", at: daysAgo(1), outcome: "wrong", source: "explain" },
			{ nodeId: "n2", chatId: "c1", at: daysAgo(3), outcome: "seen", source: "practice" },
		]);
		const s1 = states.get("n1")!;
		assert.equal(s1.lastOutcome, "wrong");
		assert.equal(s1.correctCount, 1);
		assert.equal(s1.wrongCount, 1);
		assert.equal(states.get("n2")!.seenCount, 1);
	});

	it("due ladder: wrong is immediately due; correct follows the streak intervals", () => {
		const states = core.foldReviewStates([
			{ nodeId: "wrong", chatId: "c", at: daysAgo(0), outcome: "wrong", source: "quiz" },
			{ nodeId: "fresh1", chatId: "c", at: daysAgo(0), outcome: "correct", source: "quiz" },
			{ nodeId: "stale1", chatId: "c", at: daysAgo(2), outcome: "correct", source: "quiz" },
			{ nodeId: "stale3", chatId: "c", at: daysAgo(10), outcome: "correct", source: "quiz" },
		]);
		const due = dueNodeIds(states, NOW);
		assert.ok(due.includes("wrong"));
		assert.ok(!due.includes("fresh1"), "first correct due after 1 day");
		assert.ok(due.includes("stale1"), "2 days old → past the 1-day first interval");
		assert.ok(due.includes("stale3"));
	});

	it("never-reviewed nodes are never due (neutral)", () => {
		assert.equal(dueNodeIds(new Map(), NOW).length, 0);
	});

	it("reviewNodeColor: neutral / red / amber mapping", () => {
		assert.equal(core.reviewNodeColor(undefined, NOW), null);
		const wrong = { nodeId: "n", lastAt: daysAgo(0), lastOutcome: "wrong" as const, correctCount: 0, wrongCount: 1, seenCount: 0 };
		assert.match(core.reviewNodeColor(wrong, NOW)!, /hsla\(0, 70%, 55%/);
		const fresh = { nodeId: "n", lastAt: daysAgo(0), lastOutcome: "correct" as const, correctCount: 1, wrongCount: 0, seenCount: 0 };
		assert.equal(core.reviewNodeColor(fresh, NOW), null);
		const overdue = { nodeId: "n", lastAt: daysAgo(2), lastOutcome: "correct" as const, correctCount: 1, wrongCount: 0, seenCount: 0 };
		assert.match(core.reviewNodeColor(overdue, NOW)!, /hsla\(38, 85%, 52%/);
	});
});

describe("store/reviews", () => {
	it("appends and reads back (skipping torn/malformed lines)", () => {
		appendReview({ nodeId: "n1", chatId: "c1", at: NOW.toISOString(), outcome: "correct", source: "quiz" });
		fs.appendFileSync(path.join(TMP, "reviews.jsonl"), "not-json\n");
		const states = reviewStates();
		assert.equal(states.get("n1")!.correctCount, 1);
	});
});

describe("core/reviews stats + confusion", () => {
	it("reviewStats folds due/broken/fresh/correctRate", () => {
		const states = core.foldReviewStates([
			{ nodeId: "a", chatId: "c", at: daysAgo(0), outcome: "correct", source: "quiz" },
			{ nodeId: "b", chatId: "c", at: daysAgo(0), outcome: "wrong", source: "quiz", wrongPicks: ["Option B"] },
			{ nodeId: "c", chatId: "c", at: daysAgo(10), outcome: "correct", source: "quiz" },
		]);
		const stats = core.reviewStats(states, NOW);
		assert.equal(stats.reviewed, 3);
		assert.equal(stats.broken, 1);
		assert.equal(stats.due, 2); // b (wrong) + c (10-day-old correct)
		assert.equal(stats.correctRate, 2 / 3);
	});

	it("parseReviewLine keeps wrongPicks (string list only)", () => {
		const e = core.parseReviewLine(JSON.stringify({ nodeId: "n", chatId: "c", at: NOW.toISOString(), outcome: "wrong", source: "quiz", wrongPicks: ["A", 7, "B"] }));
		assert.deepEqual(e?.wrongPicks, ["A", "B"]);
	});
});

describe("server/review-record extraction", () => {
	const mk = (m: Record<string, unknown>) => m as never;

	it("extracts quiz answers with nodeId + correctness", () => {
		const messages = [
			mk({ role: "assistant", content: [{ type: "toolCall", id: "call1", name: "quiz", arguments: { nodeId: "n1" } }] }),
			mk({ role: "toolResult", toolCallId: "call1", toolName: "quiz", isError: false, details: { correct: true, confidence: 4 } }),
			mk({ role: "toolResult", toolCallId: "call1", toolName: "quiz", isError: false, details: { dismissed: true } }),
		];
		const entries = reviewEntriesFromMessages(messages, "c1", NOW);
		assert.equal(entries.length, 1);
		assert.equal(entries[0]!.nodeId, "n1");
		assert.equal(entries[0]!.outcome, "correct");
		assert.equal(entries[0]!.source, "quiz");
	});

	it("extracts practice problems across their target ids; skipped/dismissed → nothing", () => {
		const messages = [
			mk({ role: "assistant", content: [{ type: "toolCall", id: "p1", name: "problem", arguments: { target: ["n1", "n2"] } }] }),
			mk({ role: "toolResult", toolCallId: "p1", toolName: "problem", isError: false, details: { correct: false } }),
		];
		const entries = reviewEntriesFromMessages(messages, "c1", NOW);
		assert.equal(entries.length, 2);
		assert.ok(entries.every((e) => e.source === "practice" && e.outcome === "wrong"));
	});

	it("probe/recall (no nodeId) and ungraded explain → seen or skipped", () => {
		const messages = [
			mk({ role: "assistant", content: [{ type: "toolCall", id: "e1", name: "explain", arguments: { nodeId: "n1" } }] }),
			mk({ role: "toolResult", toolCallId: "e1", toolName: "explain", isError: false, details: {} }),
			mk({ role: "assistant", content: [{ type: "toolCall", id: "pr1", name: "probe", arguments: {} }] }),
			mk({ role: "toolResult", toolCallId: "pr1", toolName: "probe", isError: false, details: { correct: true } }),
		];
		const entries = reviewEntriesFromMessages(messages, "c1", NOW);
		assert.equal(entries.length, 1, "probe carries no nodeId → skipped");
		assert.equal(entries[0]!.outcome, "seen");
	});
});


describe("createdAt backfill (the reviews route)", () => {
	it("seeds never-reviewed nodes from their teaching time; real reviews win", async () => {
		// NOTE: the data dir was captured at config-import time (config.ts),
		// so this test writes its nodes into the OUTER hermetic dir instead
		// of relocating mid-process.
		fs.mkdirSync(path.join(TMP, "graph"), { recursive: true });
		const nodes = [
			{ id: "n_old_bf", name: "Old", statement: "s", aliases: [], createdAt: "2026-09-01T00:00:00Z", provenance: [] },
			{ id: "n_new_bf", name: "New", statement: "s", aliases: [], createdAt: "2026-10-29T00:00:00Z", provenance: [] },
		];
		fs.writeFileSync(path.join(TMP, "graph", "nodes.jsonl"), nodes.map((n) => JSON.stringify(n)).join("\n") + "\n");
		const { appendReview } = await import("../src/store/reviews.ts");
		appendReview({ nodeId: "n_new_bf", chatId: "c1", at: NOW.toISOString(), outcome: "correct", source: "quiz" });

		const route = await import("../app/api/graph/reviews/route.ts");
		const res = await route.GET();
		const body = (await res.json()) as { states: Array<{ nodeId: string; lastAt: string; correctCount: number }>; due: string[] };
		const oldState = body.states.find((s) => s.nodeId === "n_old_bf");
		const newState = body.states.find((s) => s.nodeId === "n_new_bf");
		assert.ok(oldState, "the backfilled node appears");
		assert.equal(oldState.lastAt, "2026-09-01T00:00:00Z", "backfilled from createdAt");
		assert.equal(oldState.correctCount, 1);
		assert.ok(body.due.includes("n_old_bf"), "taught long ago → due");
		assert.ok(newState, "the reviewed node appears");
		assert.equal(newState.lastAt, NOW.toISOString(), "the real review wins over the backfill");
		// NOTE: due-ness for n_new_bf depends on the REAL clock vs its fixed
		// NOW timestamp — not assertable hermetically, so it is not pinned.
	});
});
