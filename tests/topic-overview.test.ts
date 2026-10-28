/**
 * THE TOPIC OVERVIEW BUILDER (topics v1 + topic-aware planning, personal
 * fork) — the server-side text the topic_overview tool returns, pinned:
 *
 * 1. THE HEADER + SECTIONS: topic-name header, member sessions (title +
 *    id, insertion order), propositions (name — statement, name-sorted).
 * 2. THE CAPS: 200 proposition lines / 50 session lines, each with an
 *    honest omission note (the memory-block pattern: truncate AND say so).
 * 3. HONESTY: an empty topic says so; a vanished topic resolves to null
 *    (the tool's fallback answers); unresolvable member ids fall back to
 *    "(untitled session)" instead of vanishing.
 *
 * Pure over fakes (the graph-tools.test.ts fixture shape) — no LH_DATA_DIR
 * seam needed: the builder reads narrow slices handed to it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTopicOverview, TOPIC_OVERVIEW_PROPOSITION_CAP, TOPIC_OVERVIEW_SESSION_CAP } from "../src/server/topic-overview.ts";
import type { ChatStore, GraphStore } from "../src/core/ports.ts";
import type { GraphNode, Topic } from "../src/core/contracts.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

const pt = (chatId: string, messageId = "m1") => ({ chatId, messageId });
const node = (id: string, name: string, statement: string, chatIds: string[]): GraphNode => ({
	id,
	name,
	statement,
	aliases: [],
	createdAt: "2026-10-01T00:00:00.000Z",
	provenance: chatIds.map((chatId) => pt(chatId)),
});

function fakeStores(
	nodes: GraphNode[],
	chats: Array<{ id: string; title: string }> = [],
): { chatStore: ChatStore; graphStore: GraphStore } {
	const graphStore: GraphStore = {
		readNodes: () => nodes,
	} as unknown as GraphStore;
	const chatStore: ChatStore = {
		getChat: (id: string) => chats.find((c) => c.id === id) as never,
	} as unknown as ChatStore;
	return { chatStore, graphStore };
}

const topic = (id: string, name: string, sessionIds: string[]): Topic => ({
	id,
	name,
	sessionIds,
	createdAt: "2026-10-01T00:00:00.000Z",
});

// ─── the happy path ──────────────────────────────────────────────────────────

describe("buildTopicOverview — the shape", () => {
	const nodes = [
		node("n1", "Water cycle", "Water circulates through evaporation and precipitation.", ["c2", "c1"]),
		node("n2", "Evaporation", "Evaporation is the sun-driven phase change at the surface.", ["c1"]),
		node("n3", "Nietzsche's will to power", "The will to power is Nietzsche's central drive.", ["c-other"]),
	];
	const { chatStore, graphStore } = fakeStores(nodes, [
		{ id: "c1", title: "First lesson" },
		{ id: "c2", title: "Follow-up seminar" },
	]);
	const deps = { chatStore, graphStore, topics: () => [topic("top_1", "Climate basics", ["c1", "c2"])] };

	it("topic-name header, member sessions with titles + ids, held propositions name-sorted", () => {
		const out = buildTopicOverview(deps, "top_1")!;
		assert.match(out, /^Topic overview — Climate basics\n/);
		assert.match(out, /Member sessions \(2\):/);
		assert.match(out, /- First lesson — id: c1/);
		assert.match(out, /- Follow-up seminar — id: c2/);
		assert.match(out, /Propositions the topic holds \(2 total\):/);
		// The derived membership: only the topic's sessions' nodes — and
		// the STATEMENT text shows (the documented deviation from the
		// names-only map ruling; the tool comment carries the why).
		assert.ok(!out.includes("will to power"), "the other topic's nodes stay out");
		assert.match(out, /- Evaporation — Evaporation is the sun-driven phase change at the surface\./);
		// Name-sorted: Evaporation before Water cycle.
		assert.ok(out.indexOf("- Evaporation —") < out.indexOf("- Water cycle —"));
	});

	it("a node born in several member sessions lists once; curation order holds for sessions", () => {
		const out = buildTopicOverview(deps, "top_1")!;
		assert.equal(out.split("- Water cycle —").length - 1, 1);
		// sessionIds order (c1 assigned before c2 in the fixture) is kept.
		assert.ok(out.indexOf("- First lesson —") < out.indexOf("- Follow-up seminar —"));
	});

	it("the unresolvable member id falls back honestly, not silently", () => {
		const { chatStore: cs, graphStore: gs } = fakeStores([], [{ id: "c1", title: "First lesson" }]);
		const out = buildTopicOverview({ chatStore: cs, graphStore: gs, topics: () => [topic("top_2", "T", ["c1", "gone"])], }, "top_2")!;
		assert.match(out, /- First lesson — id: c1/);
		assert.match(out, /- \(untitled session\) — id: gone/);
	});
});

// ─── the caps + the honest omissions ────────────────────────────────────────

describe("buildTopicOverview — the caps", () => {
	it("propositions cap at 200 with an honest omission note", () => {
		const nodes = Array.from({ length: TOPIC_OVERVIEW_PROPOSITION_CAP + 30 }, (_, i) =>
			node(`n${i}`, `Prop ${String(i).padStart(4, "0")}`, `statement ${i}`, ["c1"]),
		);
		const { chatStore, graphStore } = fakeStores(nodes);
		const out = buildTopicOverview(
			{ chatStore, graphStore, topics: () => [topic("top_1", "Big", ["c1"])] },
			"top_1",
		)!;
		assert.match(out, /Propositions the topic holds \(230 total, showing first 200\):/);
		assert.equal(out.split("\n- ").filter((l) => l.startsWith("Prop ")).length, TOPIC_OVERVIEW_PROPOSITION_CAP);
		assert.match(out, /\(… 30 more propositions not listed\.\)/);
		// Name-sorted across the cap: the first line is the lowest name.
		assert.match(out, /- Prop 0000 — statement 0/);
		assert.ok(!out.includes("Prop 0229"), "beyond-cap lines stay out");
	});

	it("sessions cap at 50 with an honest omission note", () => {
		const { chatStore, graphStore } = fakeStores([]);
		const ids = Array.from({ length: TOPIC_OVERVIEW_SESSION_CAP + 7 }, (_, i) => `c${i}`);
		const out = buildTopicOverview({ chatStore, graphStore, topics: () => [topic("top_1", "Wide", ids)] }, "top_1")!;
		assert.match(out, /Member sessions \(57, showing first 50\):/);
		assert.match(out, /\(… 7 more sessions not listed\.\)/);
		assert.ok(!out.includes("— id: c56"), "beyond-cap sessions stay out");
	});
});

// ─── honesty ────────────────────────────────────────────────────────────────

describe("buildTopicOverview — honesty", () => {
	it("an empty topic says so in both sections", () => {
		const { chatStore, graphStore } = fakeStores([]);
		const out = buildTopicOverview({ chatStore, graphStore, topics: () => [topic("top_1", "Fresh", [])] }, "top_1")!;
		assert.match(out, /Member sessions \(0\): none yet\./);
		assert.match(out, /Propositions the topic holds \(0\): none yet/);
	});

	it("a topic whose id no longer resolves → null (the tool's fallback answers)", () => {
		const { chatStore, graphStore } = fakeStores([]);
		assert.equal(buildTopicOverview({ chatStore, graphStore, topics: () => [] }, "top_gone"), null);
	});
});
