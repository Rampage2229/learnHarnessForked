/**
 * MASTERY PER TOPIC (mastery summary, personal fork): pure tests over
 * core/mastery.ts — no stores, no fs, no wall clock (the folds take their
 * `now` as a parameter, the same convention as dueNodeIds/todaySummary).
 * The states come from the review ledger's own fold (foldReviewStates) so
 * the fixtures speak the real shape: wrong/dontKnow accumulate into
 * wrongCount, the SM-2-lite ladder decides due-ness.
 *
 * The SSR render test pins MasteryList statically (React.createElement —
 * the .test.ts precedent, tests/katex-security.test.ts: tsx ignores the
 * tsconfig `jsx` field and uses the CLASSIC transform, so `React` must be
 * a resolvable global for renderToStaticMarkup).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { foldReviewStates, type ReviewEntry } from "../src/core/reviews.ts";
import {
	masteryByTopic,
	overallMastery,
	WEAKEST_CAP,
	type MasteryTopic,
} from "../src/core/mastery.ts";
import { MasteryList } from "../components/mastery-panel.tsx";

(globalThis as Record<string, unknown>).React = React;

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

describe("mastery fold — empty states", () => {
	it("an empty ledger and an empty graph render every topic at 0 / empty", () => {
		const rows = masteryByTopic(foldReviewStates([]), [], topics, NOW);
		assert.equal(rows.length, 2);
		for (const r of rows) {
			assert.equal(r.total, 0);
			assert.equal(r.solid, 0);
			assert.equal(r.shaky, 0);
			assert.equal(r.unseen, 0);
			assert.equal(r.masteryPct, 0);
			assert.deepEqual(r.weakest, []);
		}
	});

	it("topics with no matching nodes still emit (the panel shows every topic)", () => {
		const rows = masteryByTopic(foldReviewStates([]), [node("l1", "l1", ["chat-logic"])], topics, NOW);
		assert.deepEqual(rows.map((r) => r.topicId), ["top_logic", "top_ethics"]);
		assert.equal(rows[0]!.total, 1);
		assert.equal(rows[1]!.total, 0, "the topic with no matching nodes emits at 0");
		assert.equal(rows[1]!.masteryPct, 0, "total 0 → masteryPct 0, never NaN");
		assert.deepEqual(rows[1]!.weakest, []);
	});

	it("an unassigned node (no topic claims its provenance) counts nowhere per-topic", () => {
		const states = foldReviewStates([review("u1", daysAgo(0), "wrong")]);
		const rows = masteryByTopic(states, [node("u1", "u1", ["chat-nowhere"])], topics, NOW);
		for (const r of rows) {
			assert.equal(r.total, 0);
			assert.equal(r.shaky, 0);
			assert.deepEqual(r.weakest, []);
		}
	});
});

describe("mastery fold — all solid", () => {
	it("every node last correct + fresh → 100% mastery, empty weakest", () => {
		const states = foldReviewStates([
			review("l1", daysAgo(0), "correct"),
			review("l2", daysAgo(0), "correct"),
		]);
		const nodes = [node("l1", "l1", ["chat-logic"]), node("l2", "l2", ["chat-logic"])];
		const rows = masteryByTopic(states, nodes, topics, NOW);
		const logic = rows[0]!;
		assert.equal(logic.total, 2);
		assert.equal(logic.solid, 2);
		assert.equal(logic.shaky, 0);
		assert.equal(logic.unseen, 0);
		assert.equal(logic.masteryPct, 100);
		assert.deepEqual(logic.weakest, [], "all solid → no weakest links");
	});
});

describe("mastery fold — mixed states classify correctly", () => {
	it("solid = correct + fresh; shaky = wrong/dontKnow or correct-but-due; unseen = no state or seen", () => {
		const states = foldReviewStates([
			review("solid", daysAgo(0), "correct"), // fresh correct → solid
			review("wrong", daysAgo(0), "wrong"), // wrong → shaky
			review("dontKnow", daysAgo(0), "dontKnow"), // dontKnow → shaky
			review("due", daysAgo(10), "correct"), // correct-but-overdue → shaky
			review("seen", daysAgo(0), "seen"), // seen → unseen
			// "fresh" below has no ledger state → unseen
		]);
		const nodes = [
			node("solid", "s", ["chat-logic"]),
			node("wrong", "w", ["chat-logic"]),
			node("dontKnow", "d", ["chat-logic"]),
			node("due", "du", ["chat-logic"]),
			node("seen", "se", ["chat-logic"]),
			node("fresh", "f", ["chat-logic"]), // never reviewed → unseen
		];
		const logic = masteryByTopic(states, nodes, topics, NOW)[0]!;
		assert.equal(logic.total, 6);
		assert.equal(logic.solid, 1);
		assert.equal(logic.shaky, 3, "wrong + dontKnow + correct-but-due");
		assert.equal(logic.unseen, 2, "no state + seen");
	});

	it("a 'seen' node is unseen EVEN when the scheduler would decay it into due", () => {
		const states = foldReviewStates([review("stale-seen", daysAgo(5), "seen")]);
		const nodes = [node("stale-seen", "s", ["chat-logic"])];
		const logic = masteryByTopic(states, nodes, topics, NOW)[0]!;
		assert.equal(logic.unseen, 1, "seen is unseen to mastery regardless of schedule");
		assert.equal(logic.shaky, 0, "the retention-wave due-ness does not make a seen node shaky");
		assert.equal(logic.solid, 0);
	});
});

describe("mastery fold — per-topic membership (first-match law)", () => {
	it("a node whose provenance spans two topics counts for its FIRST topic only", () => {
		const states = foldReviewStates([
			review("shared", daysAgo(0), "correct"),
			review("e1", daysAgo(0), "correct"),
		]);
		const nodes = [
			node("shared", "shared", ["chat-ethics", "chat-logic"]), // both topics → first wins (Logic)
			node("e1", "e1", ["chat-ethics"]),
		];
		const rows = masteryByTopic(states, nodes, topics, NOW);
		const logic = rows[0]!;
		const ethics = rows[1]!;
		assert.equal(logic.total, 1, "the shared node belongs to Logic (first match)");
		assert.equal(logic.solid, 1);
		assert.equal(ethics.total, 1, "the shared node does NOT double-count for Ethics");
		assert.equal(ethics.solid, 1);
	});

	it("membership reuses topicOfNode — a node with empty provenance is unassigned", () => {
		const states = foldReviewStates([review("noproof", daysAgo(0), "correct")]);
		const rows = masteryByTopic(states, [node("noproof", "s", [])], topics, NOW);
		for (const r of rows) assert.equal(r.total, 0);
	});
});

describe("mastery fold — weakest ordering", () => {
	it("worst first: wrong → due-correct → unseen; stable on ties (nodes-list order)", () => {
		const states = foldReviewStates([
			review("wrong", daysAgo(0), "wrong"), // rank 0
			review("due", daysAgo(10), "correct"), // rank 1 (correct-but-due)
			// "unseen1" + "unseen2" have no ledger state → rank 2
			review("wrong2", daysAgo(0), "dontKnow"), // rank 0 (dontKnow counts as wrong)
		]);
		const nodes = [
			node("wrong", "w1", ["chat-logic"]),
			node("due", "du", ["chat-logic"]),
			node("unseen1", "u1", ["chat-logic"]),
			node("unseen2", "u2", ["chat-logic"]),
			node("wrong2", "w2", ["chat-logic"]),
		];
		const logic = masteryByTopic(states, nodes, topics, NOW)[0]!;
		// ranks: w1=0, du=1, u1=2, u2=2, w2=0 → sort: w1(0), w2(0), du(1), u1(2), u2(2)
		// w1 before w2 by nodes-list order (stable tiebreak); capped at WEAKEST_CAP=3.
		assert.deepEqual(
			logic.weakest.map((w) => w.nodeId),
			["wrong", "wrong2", "due"],
		);
	});

	it("capped at WEAKEST_CAP — the worst three survive, ties keep nodes-list order", () => {
		// Six wrong nodes (all rank 0) → only the first three by node order.
		const states = foldReviewStates(Array.from({ length: 6 }, (_, i) => review(`w${i}`, daysAgo(0), "wrong")));
		const nodes = Array.from({ length: 6 }, (_, i) => node(`w${i}`, `s${i}`, ["chat-logic"]));
		const logic = masteryByTopic(states, nodes, topics, NOW)[0]!;
		assert.equal(WEAKEST_CAP, 3);
		assert.equal(logic.weakest.length, WEAKEST_CAP);
		assert.deepEqual(logic.weakest.map((w) => w.nodeId), ["w0", "w1", "w2"]);
	});

	it("solid nodes never enter the weakest list", () => {
		const states = foldReviewStates([review("solid", daysAgo(0), "correct"), review("wrong", daysAgo(0), "wrong")]);
		const nodes = [node("solid", "s", ["chat-logic"]), node("wrong", "w", ["chat-logic"])];
		const logic = masteryByTopic(states, nodes, topics, NOW)[0]!;
		assert.deepEqual(logic.weakest.map((w) => w.nodeId), ["wrong"]);
		assert.ok(!logic.weakest.some((w) => w.nodeId === "solid"));
	});

	it("the weakest statement is the identity anchor (never the name)", () => {
		const states = foldReviewStates([review("n1", daysAgo(0), "wrong")]);
		const nodes = [node("n1", "the real statement", ["chat-logic"])];
		const logic = masteryByTopic(states, nodes, topics, NOW)[0]!;
		assert.equal(logic.weakest[0]!.statement, "the real statement");
	});

	it("a topic with all-solid nodes has an empty weakest list", () => {
		const states = foldReviewStates([
			review("a", daysAgo(0), "correct"),
			review("b", daysAgo(0), "correct"),
		]);
		const nodes = [node("a", "a", ["chat-logic"]), node("b", "b", ["chat-logic"])];
		const logic = masteryByTopic(states, nodes, topics, NOW)[0]!;
		assert.deepEqual(logic.weakest, []);
	});
});

describe("mastery fold — percent rounding", () => {
	it("round(100 * solid / total) — 1 of 3 → 33, 2 of 3 → 67", () => {
		const states = foldReviewStates([
			review("solid1", daysAgo(0), "correct"),
			review("wrong1", daysAgo(0), "wrong"),
			review("wrong2", daysAgo(0), "wrong"),
		]);
		const nodes = [node("solid1", "s", ["chat-logic"]), node("wrong1", "w", ["chat-logic"]), node("wrong2", "w", ["chat-logic"])];
		const one = masteryByTopic(states, nodes, topics, NOW)[0]!;
		assert.equal(one.masteryPct, 33, "1/3 rounds to 33");

		const states2 = foldReviewStates([
			review("solid1", daysAgo(0), "correct"),
			review("solid2", daysAgo(0), "correct"),
			review("wrong1", daysAgo(0), "wrong"),
		]);
		const nodes2 = [node("solid1", "s", ["chat-logic"]), node("solid2", "s", ["chat-logic"]), node("wrong1", "w", ["chat-logic"])];
		const two = masteryByTopic(states2, nodes2, topics, NOW)[0]!;
		assert.equal(two.masteryPct, 67, "2/3 rounds to 67");
	});

	it("masteryPct is 0 (never NaN) when total is 0", () => {
		const rows = masteryByTopic(foldReviewStates([]), [], topics, NOW);
		for (const r of rows) assert.equal(r.masteryPct, 0);
	});
});

describe("overallMastery", () => {
	it("rolls up solid/total across every topic's nodes (first-match, no double-count)", () => {
		const states = foldReviewStates([
			review("l1", daysAgo(0), "correct"), // Logic — solid
			review("e1", daysAgo(0), "wrong"), // Ethics — shaky
			review("shared", daysAgo(0), "correct"), // both → first (Logic) — solid, counted once
		]);
		const nodes = [
			node("l1", "l1", ["chat-logic"]),
			node("e1", "e1", ["chat-ethics"]),
			node("shared", "shared", ["chat-ethics", "chat-logic"]),
			node("u1", "u1", ["chat-nowhere"]), // unassigned — excluded
		];
		const overall = overallMastery(states, nodes, topics, NOW);
		assert.equal(overall.total, 3, "l1 + e1 + shared (shared counted once, unassigned excluded)");
		assert.equal(overall.solid, 2, "l1 + shared");
		assert.equal(overall.masteryPct, 67, "2/3 → 67");
	});

	it("overall is 0/0 when no node belongs to any topic (never NaN)", () => {
		const states = foldReviewStates([review("u1", daysAgo(0), "correct")]);
		const overall = overallMastery(states, [node("u1", "u1", ["chat-nowhere"])], topics, NOW);
		assert.equal(overall.total, 0);
		assert.equal(overall.solid, 0);
		assert.equal(overall.masteryPct, 0);
	});

	it("overall counts a node whose first topic is the SECOND topic correctly", () => {
		const states = foldReviewStates([review("e1", daysAgo(0), "correct")]);
		const overall = overallMastery(states, [node("e1", "e1", ["chat-ethics"])], topics, NOW);
		assert.equal(overall.total, 1);
		assert.equal(overall.solid, 1);
		assert.equal(overall.masteryPct, 100);
	});
});

describe("MasteryList render (SSR)", () => {
	it("renders nothing when there are no topics (the panel hides before any topic)", () => {
		const html = renderToStaticMarkup(
			React.createElement(MasteryList, { topics: [], overall: { masteryPct: 0, solid: 0, total: 0 } }),
		);
		assert.equal(html, "");
	});

	it("renders the panel root, per-topic rows, the progress bar, counts, and weakest links", () => {
		const topics: MasteryTopic[] = [
			{
				topicId: "top_logic",
				name: "Logic",
				total: 4,
				solid: 3,
				shaky: 1,
				unseen: 0,
				masteryPct: 75,
				weakest: [{ nodeId: "n1", statement: "Modus ponens fails here" }],
			},
			{
				topicId: "top_ethics",
				name: "Ethics",
				total: 0,
				solid: 0,
				shaky: 0,
				unseen: 0,
				masteryPct: 0,
				weakest: [],
			},
		];
		const html = renderToStaticMarkup(
			React.createElement(MasteryList, { topics, overall: { masteryPct: 67, solid: 2, total: 3 } }),
		);
		assert.match(html, /data-testid="mastery-panel"/);
		// The overall roll-up line.
		assert.match(html, /data-testid="mastery-overall"[^>]*>2\/3 solid · 67% mastery/);
		// Two topic rows.
		const topicRows = html.match(/data-testid="mastery-topic"/g) ?? [];
		assert.equal(topicRows.length, 2);
		// The Logic row: name, counts (3/4), bar width, and the weakest link.
		assert.match(html, /data-testid="mastery-topic-name"[^>]*>Logic/);
		assert.match(html, /data-testid="mastery-topic-counts"[^>]*>3\/4/);
		assert.match(html, /style="width:75%"/, "the progress bar width follows masteryPct");
		assert.match(html, /data-testid="mastery-topic-weakest"/);
		assert.match(html, /Modus ponens fails here/);
		// The Ethics row has no weakest list (all-empty topic → no weakest).
		const ethics = html.split("Ethics")[1] ?? "";
		assert.doesNotMatch(ethics, /data-testid="mastery-topic-weakest"/, "an empty topic has no weakest list");
	});

	it("the progress bar carries the ARIA progressbar role with the value", () => {
		const topics: MasteryTopic[] = [
			{ topicId: "t", name: "T", total: 2, solid: 1, shaky: 1, unseen: 0, masteryPct: 50, weakest: [] },
		];
		const html = renderToStaticMarkup(
			React.createElement(MasteryList, { topics, overall: { masteryPct: 50, solid: 1, total: 2 } }),
		);
		assert.match(html, /role="progressbar"/);
		assert.match(html, /aria-valuenow="50"/);
		assert.match(html, /aria-valuemin="0"/);
		assert.match(html, /aria-valuemax="100"/);
	});
});
