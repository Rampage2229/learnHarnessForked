/**
 * THE TODAY FOLD (feature ①, the Today retention surface): pure tests
 * over core/today.ts — no stores, no fs, no wall clock (the fold takes
 * its `now` as a parameter, the same convention as dueNodeIds). The
 * states come from the review ledger's own fold (foldReviewStates) so
 * the fixtures speak the real shape: wrong/dontKnow accumulate into
 * wrongCount, the SM-2-lite ladder decides due-ness.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { foldReviewStates, type ReviewEntry } from "../src/core/reviews.ts";
import {
	MIN_REVIEW_MINUTES,
	STRUGGLING_CAP,
	STRUGGLING_MIN_WRONG,
	todaySummary,
	type TodaySummary,
} from "../src/core/today.ts";

const NOW = new Date("2026-10-29T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 3600 * 1000).toISOString();

/** A proposition node — only the fields the fold reads (the structural
 *  contract: id + statement + provenance). */
const node = (id: string, statement: string, chatIds: string[] = []) => ({
	id,
	statement,
	provenance: chatIds.map((chatId) => ({ chatId, messageId: `${chatId}-m1` })),
});

const topics = [
	{ id: "top_logic", name: "Logic", sessionIds: ["chat-logic"], createdAt: daysAgo(30) },
	{ id: "top_ethics", name: "Ethics", sessionIds: ["chat-ethics"], createdAt: daysAgo(20) },
];

const review = (nodeId: string, at: string, outcome: ReviewEntry["outcome"]): ReviewEntry => ({
	nodeId,
	chatId: "c1",
	at,
	outcome,
	source: "quiz",
});

/** n wrong reviews on one node (distinct timestamps — counts accumulate). */
const wrongs = (nodeId: string, n: number): ReviewEntry[] =>
	Array.from({ length: n }, (_, i) => review(nodeId, daysAgo(i + 1), "wrong"));

describe("today fold — empty states", () => {
	it("an empty ledger and an empty graph render an empty, floored Today", () => {
		const t = todaySummary(foldReviewStates([]), [], topics, NOW);
		assert.equal(t.dueCount, 0);
		assert.deepEqual(t.dueByTopic, []);
		assert.deepEqual(t.struggling, []);
		assert.equal(t.minutesEstimate, MIN_REVIEW_MINUTES);
	});

	it("reviews for nodes the graph no longer has count nowhere — not due, not struggling", () => {
		const states = foldReviewStates([...wrongs("ghost", 4), review("ghost", daysAgo(0), "wrong")]);
		const t = todaySummary(states, [], topics, NOW);
		assert.equal(t.dueCount, 0, "a deleted node's state is not selectable → not counted");
		assert.deepEqual(t.dueByTopic, []);
		assert.deepEqual(t.struggling, [], "no statement to show for a deleted node");
	});

	it("a reviewed-but-healthy graph renders nothing (the band hides)", () => {
		const states = foldReviewStates([
			review("fresh", daysAgo(0), "correct"), // within its 1-day interval
			review("seen", daysAgo(0), "seen"), // ungraded — no verdict yet
		]);
		const nodes = [node("fresh", "f", ["chat-logic"]), node("seen", "s", ["chat-logic"])];
		const t = todaySummary(states, nodes, topics, NOW);
		assert.equal(t.dueCount, 0);
		assert.deepEqual(t.dueByTopic, []);
		assert.deepEqual(t.struggling, []);
		assert.equal(t.minutesEstimate, MIN_REVIEW_MINUTES);
	});
});

describe("today fold — due counting", () => {
	it("wrong is immediately due; stale correct is due; fresh correct and seen are not", () => {
		const states = foldReviewStates([
			review("wrong", daysAgo(0), "wrong"),
			review("fresh1", daysAgo(0), "correct"),
			review("stale1", daysAgo(2), "correct"), // past the 1-day first interval
			review("stale3", daysAgo(10), "correct"),
			review("dontKnow", daysAgo(0), "dontKnow"),
			review("seen", daysAgo(5), "seen"),
		]);
		const nodes = ["wrong", "fresh1", "stale1", "stale3", "dontKnow", "seen"].map((id) => node(id, id, ["chat-logic"]));
		const t = todaySummary(states, nodes, topics, NOW);
		assert.equal(t.dueCount, 4); // wrong, stale1, stale3, dontKnow
		assert.equal(t.minutesEstimate, MIN_REVIEW_MINUTES, "4 due is still under the 5-minute floor");
	});

	it("dueByTopic: first-match topic membership, the sum law, the Unassigned bucket", () => {
		const states = foldReviewStates([
			review("l1", daysAgo(0), "wrong"),
			review("l2", daysAgo(2), "correct"),
			review("shared", daysAgo(0), "wrong"), // provenance in BOTH topics → first topic wins
			review("e1", daysAgo(10), "correct"),
			review("u1", daysAgo(0), "wrong"), // no topic claims its provenance
		]);
		const nodes = [
			node("l1", "l1", ["chat-logic"]),
			node("l2", "l2", ["chat-logic"]),
			node("shared", "shared", ["chat-ethics", "chat-logic"]),
			node("e1", "e1", ["chat-ethics"]),
			node("u1", "u1", ["chat-nowhere"]),
		];
		const t = todaySummary(states, nodes, topics, NOW);
		assert.equal(t.dueCount, 5);
		assert.deepEqual(t.dueByTopic, [
			{ topicId: "top_logic", name: "Logic", count: 3 }, // l1, l2, shared (first match)
			{ topicId: "top_ethics", name: "Ethics", count: 1 },
			{ topicId: "", name: "Unassigned", count: 1 }, // the breakdown still sums to dueCount
		]);
	});

	it("dueByTopic sorts count-desc and omits empty topics entirely", () => {
		const states = foldReviewStates([
			review("e1", daysAgo(10), "correct"),
			review("e2", daysAgo(10), "correct"),
			review("l1", daysAgo(0), "wrong"),
		]);
		const nodes = [
			node("e1", "e1", ["chat-ethics"]),
			node("e2", "e2", ["chat-ethics"]),
			node("l1", "l1", ["chat-logic"]),
			node("quiet", "quiet", []), // a due node would land here; none is
		];
		const t = todaySummary(states, nodes, topics, NOW);
		assert.deepEqual(t.dueByTopic, [{ topicId: "top_ethics", name: "Ethics", count: 2 }, { topicId: "top_logic", name: "Logic", count: 1 }]);
	});
});

describe("today fold — struggling", () => {
	it("the threshold is STRUGGLING_MIN_WRONG wrongs — one wrong is noise, dontKnow counts", () => {
		const states = foldReviewStates([
			...wrongs("noise", 1),
			review("edge", daysAgo(4), "dontKnow"),
			review("edge", daysAgo(3), "dontKnow"),
		]);
		const nodes = [node("noise", "n", ["chat-logic"]), node("edge", "e", ["chat-logic"])];
		const t = todaySummary(states, nodes, topics, NOW);
		assert.deepEqual(t.struggling, [{ nodeId: "edge", statement: "e", wrongCount: STRUGGLING_MIN_WRONG }]);
	});

	it("sorted worst-first; the statement rides along, never the name", () => {
		const states = foldReviewStates([...wrongs("a", 2), ...wrongs("b", 4), ...wrongs("c", 3)]);
		const nodes = [node("a", "statement-a", ["chat-logic"]), node("b", "statement-b", ["chat-logic"]), node("c", "statement-c", ["chat-logic"])];
		const t = todaySummary(states, nodes, topics, NOW);
		assert.deepEqual(t.struggling, [
			{ nodeId: "b", statement: "statement-b", wrongCount: 4 },
			{ nodeId: "c", statement: "statement-c", wrongCount: 3 },
			{ nodeId: "a", statement: "statement-a", wrongCount: 2 },
		]);
	});

	it("capped at STRUGGLING_CAP — the worst five survive, the sixth-worst drops", () => {
		const wrongCounts = [1, 2, 3, 4, 5, 6, 7];
		const states = foldReviewStates(wrongCounts.flatMap((n) => wrongs(`n${n}`, n)));
		const nodes = wrongCounts.map((n) => node(`n${n}`, `statement-${n}`, ["chat-logic"]));
		const t: TodaySummary = todaySummary(states, nodes, topics, NOW);
		assert.equal(STRUGGLING_CAP, 5);
		assert.equal(t.struggling.length, STRUGGLING_CAP);
		assert.deepEqual(
			t.struggling.map((s) => s.wrongCount),
			[7, 6, 5, 4, 3],
		);
		assert.ok(!t.struggling.some((s) => s.nodeId === "n2"), "the sixth-worst (wrongCount 2) dropped");
	});

	it("ties keep the nodes-list order (a stable sort)", () => {
		const states = foldReviewStates([...wrongs("first", 2), ...wrongs("second", 2)]);
		const nodes = [node("first", "f", ["chat-logic"]), node("second", "s", ["chat-logic"])];
		const t = todaySummary(states, nodes, topics, NOW);
		assert.deepEqual(
			t.struggling.map((s) => s.nodeId),
			["first", "second"],
		);
	});
});

describe("today fold — minutes estimate", () => {
	it("max(5, dueCount): the floor holds at zero due, the count wins above it", () => {
		const empty = todaySummary(foldReviewStates([]), [], topics, NOW);
		assert.equal(empty.minutesEstimate, MIN_REVIEW_MINUTES);
		const states = foldReviewStates(Array.from({ length: 7 }, (_, i) => review(`n${i}`, daysAgo(0), "wrong")));
		const nodes = Array.from({ length: 7 }, (_, i) => node(`n${i}`, `s${i}`, ["chat-logic"]));
		assert.equal(todaySummary(states, nodes, topics, NOW).minutesEstimate, 7);
	});
});
