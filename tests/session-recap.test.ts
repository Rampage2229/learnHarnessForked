/**
 * Session recap (feature ⑤, personal fork): GET /api/chats/[id]/recap +
 * the transcript's recap card. The route test drives the REAL handler
 * (framework-free Request/Response) under an isolated LH_DATA_DIR —
 * seeded with a chat record, graph nodes (incl. a link-append union and
 * a foreign-chat node), chain assertions (incl. a second-session
 * re-assertion of the same argument) and a review ledger — pinning the
 * response shape, the provenance scoping, the chain merge, the fresh
 * ledger read, and the 404. Then the card: SSR of <SessionRecapCard>
 * (the pure seam) plus the empty render of the fetch wrapper. Same
 * seam discipline as chat-birth-stamp.test.ts: LH_DATA_DIR is set
 * BEFORE the first import that transitively loads config.ts, so every
 * app-module import is dynamic.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-session-recap-"));
process.env.LH_DATA_DIR = TMP;

const { GET } = await import("../app/api/chats/[id]/recap/route.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { appendReview } = await import("../src/store/reviews.ts");
const { SessionRecap, SessionRecapCard } = await import("../components/session-recap.tsx");
type SessionRecapData = import("../components/session-recap.tsx").SessionRecapData;

after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();
type Proposition = { id: string; statement: string; outcome: string | null; due: boolean };
type RecapBody = { propositions: Proposition[]; chainCount: number };

// ── the seed: one session's graph contribution + its review history ─────────
const chat = chatStore.createChat("Recap session");
const id = chat.id;
const provenance = (messageId: string) => [{ chatId: id, messageId }];

function node(nodeId: string, statement: string, points: { chatId: string; messageId: string }[]): void {
	graphStore.appendNode({ id: nodeId, name: nodeId, statement, aliases: [], createdAt: "2026-01-01T00:00:00.000Z", provenance: points });
}

// Two nodes taught in this session, one reviewed solid, one wrong.
node("n_solid", "Solid statement", provenance("m1"));
node("n_shaky", "Shaky statement", provenance("m2"));
node("n_seen", "Seen statement", provenance("m3"));
// A link-append: the node was BORN elsewhere, this session re-encountered
// it — provenance unions, so it counts for this chat; the first line's
// statement stands.
node("n_link", "Original statement", [{ chatId: "chat_other", messageId: "m0" }]);
node("n_link", "Later phrasing", provenance("m4"));
// A foreign node: never touched by this chat — must not appear.
node("n_foreign", "Foreign statement", [{ chatId: "chat_other", messageId: "m9" }]);

// The session's argument (n_solid + n_shaky ⟹ n_seen), asserted once here
// and once by another session (a re-assertion LINE, not a new chain).
graphStore.appendChain({ id: "arg_1", premises: ["n_solid", "n_shaky"], conclusion: "n_seen", provenance: provenance("m5"), createdAt: "2026-01-02T00:00:00.000Z" });
graphStore.appendChain({ id: "arg_1b", premises: ["n_solid", "n_shaky"], conclusion: "n_seen", provenance: [{ chatId: "chat_other", messageId: "m1" }], createdAt: "2026-01-03T00:00:00.000Z" });
// A chain over foreign members only — no participation, no count.
graphStore.appendChain({ id: "arg_foreign", premises: ["n_foreign"], conclusion: "n_madeup", provenance: [{ chatId: "chat_other", messageId: "m2" }], createdAt: "2026-01-04T00:00:00.000Z" });

appendReview({ nodeId: "n_solid", chatId: id, at: hoursAgo(6), outcome: "correct", source: "quiz" });
appendReview({ nodeId: "n_shaky", chatId: id, at: hoursAgo(48), outcome: "wrong", source: "quiz" });
appendReview({ nodeId: "n_seen", chatId: id, at: hoursAgo(24), outcome: "seen", source: "probe" });
// n_link: never reviewed → outcome null, never due.

function get(chatId: string): Promise<Response> {
	return GET(new Request(`http://test/api/chats/${chatId}/recap`), { params: Promise.resolve({ id: chatId }) });
}

describe("GET /api/chats/[id]/recap", () => {
	it("returns the session's propositions with fresh review states + the merged chain count", async () => {
		const res = await get(id);
		assert.equal(res.status, 200);
		const body = (await res.json()) as RecapBody;
		// Provenance-scoped: n_foreign absent; n_link present (provenance
		// union) with its BIRTH statement; deterministic id order.
		assert.deepEqual(
			body.propositions.map((p) => ({ id: p.id, statement: p.statement })),
			[
				{ id: "n_link", statement: "Original statement" },
				{ id: "n_seen", statement: "Seen statement" },
				{ id: "n_shaky", statement: "Shaky statement" },
				{ id: "n_solid", statement: "Solid statement" },
			],
		);
		const byId = new Map(body.propositions.map((p) => [p.id, p]));
		assert.equal(byId.get("n_solid")!.outcome, "correct");
		assert.equal(byId.get("n_solid")!.due, false, "correct 6h ago — within the first interval");
		assert.equal(byId.get("n_shaky")!.outcome, "wrong");
		assert.equal(byId.get("n_shaky")!.due, true, "last wrong → immediately due");
		assert.equal(byId.get("n_seen")!.outcome, "seen");
		assert.equal(byId.get("n_seen")!.due, false, "seen is ungraded — never due");
		assert.equal(byId.get("n_link")!.outcome, null, "no ledger verdict — null");
		assert.equal(byId.get("n_link")!.due, false);
		// arg_1 and arg_1b are ONE logical chain (re-assertion merge);
		// arg_foreign does not participate.
		assert.equal(body.chainCount, 1);
	});

	it("404 on an unknown chat", async () => {
		const res = await get("chat_nope");
		assert.equal(res.status, 404);
	});

	it("reads the ledger fresh — a review recorded after one GET shows in the next", async () => {
		const before = (await (await get(id)).json()) as RecapBody;
		assert.equal(before.propositions.find((p) => p.id === "n_seen")!.outcome, "seen");
		appendReview({ nodeId: "n_seen", chatId: id, at: new Date().toISOString(), outcome: "wrong", source: "quiz" });
		const after = (await (await get(id)).json()) as RecapBody;
		const seen = after.propositions.find((p) => p.id === "n_seen")!;
		assert.equal(seen.outcome, "wrong");
		assert.equal(seen.due, true);
	});

	it("dontKnow folds to wrong (the wrongCount discipline), never its own outcome", async () => {
		appendReview({ nodeId: "n_link", chatId: id, at: new Date().toISOString(), outcome: "dontKnow", source: "recall" });
		const body = (await (await get(id)).json()) as RecapBody;
		const link = body.propositions.find((p) => p.id === "n_link")!;
		assert.equal(link.outcome, "wrong");
		assert.equal(link.due, true);
	});
});

describe("SessionRecapCard (SSR)", () => {
	const data: SessionRecapData = {
		propositions: [
			{ id: "a", statement: "The chain rule differentiates compositions.", outcome: "correct", due: false },
			{ id: "b", statement: "The wrong one", outcome: "wrong", due: true },
			{ id: "c", statement: "The overdue one", outcome: "correct", due: true },
			{ id: "d", statement: "The untouched one", outcome: null, due: false },
		],
		chainCount: 2,
	};

	it("renders the count line + one row per proposition with the state badge", () => {
		const html = renderToStaticMarkup(React.createElement(SessionRecapCard, { data }));
		assert.ok(html.includes('data-testid="session-recap"'));
		assert.ok(html.includes("Session recap — you built 4 propositions across 2 chains"));
		assert.ok(html.includes("The chain rule differentiates compositions."));
		assert.equal((html.match(/>Solid</g) ?? []).length, 1);
		assert.equal((html.match(/>Shaky</g) ?? []).length, 1);
		assert.equal((html.match(/>Due</g) ?? []).length, 1);
		assert.equal((html.match(/>New</g) ?? []).length, 1);
		// Badge priority pinned by row order: wrong reads Shaky even while
		// due; the overdue correct reads Due.
		const order = ["Solid", "Shaky", "Due", "New"].map((label) => html.indexOf(`>${label}<`));
		assert.ok(order.every((i) => i >= 0), "all four badges present");
		assert.deepEqual([...order].sort((a, b) => a - b), order);
	});

	it("singular nouns: 1 proposition across 1 chain", () => {
		const html = renderToStaticMarkup(
			React.createElement(SessionRecapCard, {
				data: { propositions: [{ id: "a", statement: "s", outcome: "correct", due: false }], chainCount: 1 },
			}),
		);
		assert.ok(html.includes("you built 1 proposition across 1 chain"));
	});

	it("long statements are clamped with an ellipsis, never the full text", () => {
		const html = renderToStaticMarkup(
			React.createElement(SessionRecapCard, {
				data: {
					propositions: [{ id: "a", statement: "x".repeat(150) + "TAIL", outcome: null, due: false }],
					chainCount: 0,
				},
			}),
		);
		assert.ok(html.includes("…"), "the clamp ellipsis");
		assert.ok(!html.includes("TAIL"), "the tail never reaches the DOM");
	});

	it("the fetch wrapper renders NOTHING before data arrives (mount-gated, honest render)", () => {
		const html = renderToStaticMarkup(React.createElement(SessionRecap, { chatId: "chat_any" }));
		assert.equal(html, "");
	});
});
