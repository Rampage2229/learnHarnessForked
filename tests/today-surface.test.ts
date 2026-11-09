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
	capToday,
	reviewTarget,
	DAILY_REVIEW_TARGET_DEFAULT,
	DAILY_REVIEW_TARGET_MIN,
	DAILY_REVIEW_TARGET_MAX,
	rankDueNodes,
	todaySummary,
	type TodaySummary,
	type TodayDueNode,
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
	it("wrong is immediately due; stale correct + stale seen are due; fresh correct and fresh seen are not", () => {
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
		// wrong, stale1, stale3, dontKnow + stale-seen (seen-decay: past the
		// 1-day base interval, seen re-surfaces — retention wave)
		assert.equal(t.dueCount, 5);
		assert.equal(t.minutesEstimate, MIN_REVIEW_MINUTES, "5 due is still at the 5-minute floor");
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

/** A TodaySummary with a fixed dueCount + minutesEstimate — the cap's
 *  inputs are the two headline numbers, so a hand-built summary pins the
 *  cap behavior without the scheduler. */
const summaryOf = (dueCount: number, minutesEstimate: number): TodaySummary => ({
	dueCount,
	dueByTopic: [],
	struggling: [],
	minutesEstimate,
});

describe("capToday — the daily review target cap", () => {
	it("UNDER the target: the count + minutes pass through unchanged (no cap applied)", () => {
		const t = capToday(summaryOf(7, 7), 20);
		assert.equal(t.startCount, 7);
		assert.equal(t.startMinutes, 7);
	});

	it("OVER the target: both headline numbers cap at the target (a 256-node backlog becomes a livable 20)", () => {
		const t = capToday(summaryOf(256, 256), 20);
		assert.equal(t.startCount, 20, "the count caps at the target");
		assert.equal(t.startMinutes, 20, "the minutes cap at the target too");
	});

	it("EQUAL to the target: min(n, target) keeps the count (the boundary is inclusive)", () => {
		const t = capToday(summaryOf(20, 20), 20);
		assert.equal(t.startCount, 20);
		assert.equal(t.startMinutes, 20);
	});

	it("minutes scale independently of the count: a 3-node day keeps the 5-min floor (under target), a 100-node day caps both at target", () => {
		// under target: the minutes floor (5) is what the band shows even
		// though only 3 nodes are due — the cap passes it through.
		const few = capToday(summaryOf(3, MIN_REVIEW_MINUTES), 20);
		assert.equal(few.startCount, 3);
		assert.equal(few.startMinutes, MIN_REVIEW_MINUTES, "the 5-min floor rides under the target");
		// over target: both headline numbers are capped by the SAME target,
		// so a 100-node/100-min day becomes 20/20.
		const many = capToday(summaryOf(100, 100), 20);
		assert.equal(many.startCount, 20);
		assert.equal(many.startMinutes, 20);
	});

	it("the fold's existing fields keep their full-backlog meaning — the cap is a SIBLING view, not a mutation", () => {
		const full = summaryOf(256, 256);
		const capped = capToday(full, 20);
		assert.equal(full.dueCount, 256, "the summary is read-only");
		assert.equal(full.minutesEstimate, 256);
		assert.equal(capped.startCount, 20);
		assert.equal(capped.startMinutes, 20);
	});
});

describe("reviewTarget — the pure settings resolver", () => {
	it("absent / null / undefined → the 20 default (the resting state)", () => {
		assert.equal(reviewTarget(undefined), DAILY_REVIEW_TARGET_DEFAULT);
		assert.equal(reviewTarget(null), DAILY_REVIEW_TARGET_DEFAULT);
		assert.equal(reviewTarget({}), DAILY_REVIEW_TARGET_DEFAULT);
	});

	it("an in-range integer passes through", () => {
		assert.equal(reviewTarget({ dailyReviewTarget: 5 }), 5);
		assert.equal(reviewTarget({ dailyReviewTarget: 20 }), 20);
		assert.equal(reviewTarget({ dailyReviewTarget: 100 }), 100);
	});

	it("out-of-range clamps into 5–100 (a hand-edited value resolves inside the bounds, never a nonsense target)", () => {
		assert.equal(reviewTarget({ dailyReviewTarget: 1 }), DAILY_REVIEW_TARGET_MIN);
		assert.equal(reviewTarget({ dailyReviewTarget: 0 }), DAILY_REVIEW_TARGET_MIN);
		assert.equal(reviewTarget({ dailyReviewTarget: 256 }), DAILY_REVIEW_TARGET_MAX);
		assert.equal(reviewTarget({ dailyReviewTarget: 9999 }), DAILY_REVIEW_TARGET_MAX);
	});

	it("non-integer / non-finite / wrong-type → the 20 default (never a fractional or NaN target)", () => {
		assert.equal(reviewTarget({ dailyReviewTarget: 20.5 }), 21, "fractions round");
		assert.equal(reviewTarget({ dailyReviewTarget: NaN }), DAILY_REVIEW_TARGET_DEFAULT);
		assert.equal(reviewTarget({ dailyReviewTarget: Infinity }), DAILY_REVIEW_TARGET_DEFAULT);
		// wrong types (the sanitizer drops these; reviewTarget defends too)
		assert.equal(reviewTarget({ dailyReviewTarget: "20" as unknown as number }), DAILY_REVIEW_TARGET_DEFAULT);
		assert.equal(reviewTarget({ dailyReviewTarget: true as unknown as number }), DAILY_REVIEW_TARGET_DEFAULT);
	});
});

describe("rankDueNodes — review only the worst", () => {
	it("orders mixed due nodes wrong → overdue → stale (the bucket priority)", () => {
		// One of each due path. wrong is the worst bucket (re-learn first),
		// overdue is next (correct-but-fading), stale is last (never graded).
		const states = foldReviewStates([
			review("w", daysAgo(1), "wrong"), // wrong — bucket (a)
			review("o", daysAgo(2), "correct"), // overdue — bucket (b), past the 1-day interval
			review("s", daysAgo(5), "seen"), // stale — bucket (c), past the 1-day base interval
		]);
		const nodes = [node("w", "stmt-w", ["chat-logic"]), node("o", "stmt-o", ["chat-logic"]), node("s", "stmt-s", ["chat-logic"])];
		const ranked = rankDueNodes(states, nodes, 10, NOW);
		assert.deepEqual(
			ranked.map((r) => ({ id: r.id, reason: r.reason })),
			[
				{ id: "w", reason: "wrong" },
				{ id: "o", reason: "overdue" },
				{ id: "s", reason: "stale" },
			],
		);
		// dontKnow sits in the same "wrong" bucket as wrong (both re-learn).
		assert.deepEqual(
			ranked.map((r) => r.statement),
			["stmt-w", "stmt-o", "stmt-s"],
			"the statement rides along, never the name",
		);
	});

	it("inside the wrong bucket, most wrongCount desc — the broken models re-learn first", () => {
		// Three wrong nodes with wrongCount 2 / 4 / 3. `wrongs` places the
		// most recent review at daysAgo(1) for every count, so lastAt is held
		// constant and the wrongCount is the only varying signal.
		const states = foldReviewStates([...wrongs("a", 2), ...wrongs("b", 4), ...wrongs("c", 3)]);
		const nodes = [node("a", "statement-a", ["chat-logic"]), node("b", "statement-b", ["chat-logic"]), node("c", "statement-c", ["chat-logic"])];
		const ranked = rankDueNodes(states, nodes, 10, NOW);
		assert.deepEqual(
			ranked.map((r) => ({ id: r.id, reason: r.reason, wrongCount: r.wrongCount })),
			[
				{ id: "b", reason: "wrong", wrongCount: 4 },
				{ id: "c", reason: "wrong", wrongCount: 3 },
				{ id: "a", reason: "wrong", wrongCount: 2 },
			],
		);
	});

	it("inside the wrong bucket, a tied wrongCount breaks to oldest lastAt first (the older wrong is more forgotten)", () => {
		// Two wrong nodes, both wrongCount 1, but one was graded a day ago
		// and the other ten days ago — the older one ranks first within the
		// bucket (a shared wrongCount falls back to oldest-first).
		const states = foldReviewStates([review("recent", daysAgo(1), "wrong"), review("old", daysAgo(10), "wrong")]);
		const nodes = [node("recent", "r", ["chat-logic"]), node("old", "o", ["chat-logic"])];
		const ranked = rankDueNodes(states, nodes, 10, NOW);
		assert.deepEqual(
			ranked.map((r) => r.id),
			["old", "recent"],
		);
	});

	it("inside the overdue bucket, oldest lastAt first (the longest-forgotten correct slips most)", () => {
		// Two correct-and-overdue nodes (correctCount 1 → 1-day interval);
		// 10 days ago is older than 2 days ago, so it ranks first in the bucket.
		const states = foldReviewStates([review("soon", daysAgo(2), "correct"), review("long", daysAgo(10), "correct")]);
		const nodes = [node("soon", "s", ["chat-logic"]), node("long", "l", ["chat-logic"])];
		const ranked = rankDueNodes(states, nodes, 10, NOW);
		assert.deepEqual(
			ranked.map((r) => r.id),
			["long", "soon"],
		);
	});

	it("inside the stale bucket, oldest lastAt first (the never-graded material that sat longest re-surfaces first)", () => {
		// Two seen-past-interval nodes (the 1-day base interval); 10 days
		// ago is older than 5 days ago, so it ranks first in the bucket.
		const states = foldReviewStates([review("fresh", daysAgo(5), "seen"), review("dust", daysAgo(10), "seen")]);
		const nodes = [node("fresh", "f", ["chat-logic"]), node("dust", "d", ["chat-logic"])];
		const ranked = rankDueNodes(states, nodes, 10, NOW);
		assert.deepEqual(
			ranked.map((r) => ({ id: r.id, reason: r.reason })),
			[
				{ id: "dust", reason: "stale" },
				{ id: "fresh", reason: "stale" },
			],
		);
	});

	it("the worst bucket always precedes the next regardless of count: a 1-wrong beats a 10-overdue", () => {
		// A single-wrong node is still a broken model (re-learn) and ranks
		// above a deeply-overdue correct node — the bucket priority is the
		// first key, wrongCount only orders WITHIN the wrong bucket.
		const states = foldReviewStates([
			review("oneWrong", daysAgo(1), "wrong"),
			review("bigOverdue", daysAgo(30), "correct"), // very overdue correct
		]);
		const nodes = [node("oneWrong", "w", ["chat-logic"]), node("bigOverdue", "o", ["chat-logic"])];
		const ranked = rankDueNodes(states, nodes, 10, NOW);
		assert.deepEqual(
			ranked.map((r) => ({ id: r.id, reason: r.reason })),
			[
				{ id: "oneWrong", reason: "wrong" },
				{ id: "bigOverdue", reason: "overdue" },
			],
		);
	});

	it("limit caps the list at the worst N (the daily review target) — the rest stay unselected", () => {
		// Five due nodes (worst-first: 5-wrong, 3-wrong, 2-wrong, overdue, stale);
		// a limit of 3 keeps the three worst and drops the overdue + stale.
		const states = foldReviewStates([
			...wrongs("w5", 5),
			...wrongs("w3", 3),
			...wrongs("w2", 2),
			review("o", daysAgo(2), "correct"),
			review("s", daysAgo(5), "seen"),
		]);
		const nodes = [node("w5", "5", ["chat-logic"]), node("w3", "3", ["chat-logic"]), node("w2", "2", ["chat-logic"]), node("o", "o", ["chat-logic"]), node("s", "s", ["chat-logic"])];
		const ranked = rankDueNodes(states, nodes, 3, NOW);
		assert.equal(ranked.length, 3);
		assert.deepEqual(
			ranked.map((r) => r.id),
			["w5", "w3", "w2"],
			"the worst three (all wrong-bucket) survive; overdue + stale drop",
		);
		// a limit of 0 / negative yields nothing (never an open empty select).
		assert.deepEqual(rankDueNodes(states, nodes, 0, NOW), []);
		assert.deepEqual(rankDueNodes(states, nodes, -1, NOW), []);
	});

	it("empty when nothing is due — fresh correct, fresh seen, and healthy nodes never appear", () => {
		const states = foldReviewStates([
			review("fresh", daysAgo(0), "correct"), // within its 1-day interval → not due
			review("seenNow", daysAgo(0), "seen"), // within the base interval → not due
		]);
		const nodes = [node("fresh", "f", ["chat-logic"]), node("seenNow", "s", ["chat-logic"])];
		const ranked = rankDueNodes(states, nodes, 10, NOW);
		assert.deepEqual(ranked, []);
		// and an empty ledger / empty graph is empty too.
		assert.deepEqual(rankDueNodes(foldReviewStates([]), [], 10, NOW), []);
	});

	it("a node with no ledger state never appears (it is never due), and a state for a deleted node is dropped", () => {
		// `never` has a graph node but no review ledger entry — neutral,
		// never due (dueNodeIds only ranks states). `ghost` has a wrong
		// state but no graph node (deleted) — dropped, no statement to show,
		// the graph-view's resolution law (the same as todaySummary's dueCount).
		const states = foldReviewStates([...wrongs("ghost", 4), review("ghost", daysAgo(0), "wrong")]);
		const nodes = [node("never", "n", ["chat-logic"])];
		const ranked = rankDueNodes(states, nodes, 10, NOW);
		assert.deepEqual(ranked, [], "the no-state node is not due; the deleted node's state is not selectable");

		// When `never` finally gets a wrong review it appears (and is the
		// only ranked entry — ghost stays dropped).
		const states2 = foldReviewStates([...wrongs("ghost", 4), review("ghost", daysAgo(0), "wrong"), review("never", daysAgo(0), "wrong")]);
		const ranked2 = rankDueNodes(states2, nodes, 10, NOW) as TodayDueNode[];
		assert.equal(ranked2.length, 1);
		assert.equal(ranked2[0]!.id, "never");
		assert.equal(ranked2[0]!.reason, "wrong");
		assert.equal(ranked2[0]!.wrongCount, 1);
	});
});
