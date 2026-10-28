/**
 * Topics v1 (personal fork): the whole vertical, hermetic under an
 * isolated LH_DATA_DIR (the memory.test.ts discipline — the seam is set
 * BEFORE any config-loading import, every app-module import is dynamic):
 *
 *   - the store (src/store/topics.ts): CRUD, assign/remove, the 120-char
 *     name gate, findTopicBySession, hostile-file safety;
 *   - the pure derivation (core/topics.ts): topicOfNode / topicOfChat +
 *     the stats fold;
 *   - the routes (app/api/topics, app/api/topics/[id]) driven directly
 *     with Request objects (the custom-providers.test.ts precedent);
 *   - session creation (POST /api/chats): the topicId stamps the record,
 *     an unknown topic 400s before anything exists, and the injected
 *     graph context PREFERs the topic's propositions (topic-first under
 *     the same 64 cap) — against the REAL stores under the tmp dir (the
 *     chat-birth-stamp pattern: no mocking, just a relocated data dir).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-topics-"));
process.env.LH_DATA_DIR = TMP;

const { topicStore, MAX_TOPIC_NAME } = await import("../src/store/topics.ts");
const { topicOfChat, topicOfNode, topicNodeGroups, withTopicStats } = await import("../src/core/topics.ts");
const { PATHS } = await import("../config.ts");
const topicsRoute = await import("../app/api/topics/route.ts");
const topicItemRoute = await import("../app/api/topics/[id]/route.ts");
const chatsRoute = await import("../app/api/chats/route.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { subscribe } = await import("../src/core/events.ts");
import type { GraphNode, Topic } from "../src/core/contracts.ts";

after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

function jsonRequest(method: string, url: string, body?: unknown): Request {
	return new Request(url, {
		method,
		headers: body !== undefined ? { "content-type": "application/json" } : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
}

/** A blank slate: every describe controls its own starting state. */
function clearAll(): void {
	for (const t of topicStore.readTopics()) topicStore.deleteTopic(t.id);
}

/** One provenance-carrying graph node, appended to the real ledger. */
function appendNode(id: string, name: string, chatIds: string[]): GraphNode {
	const node: GraphNode = {
		id,
		name,
		statement: `Statement of ${name}.`,
		aliases: [],
		createdAt: new Date().toISOString(),
		provenance: chatIds.map((chatId) => ({ chatId, messageId: `${id}-m1` })),
	};
	graphStore.appendNode(node);
	return node;
}

describe("the store file seam", () => {
	it("PATHS.topics resolves inside LH_DATA_DIR; missing file reads []", () => {
		assert.equal(PATHS.topics, path.join(TMP, "topics.json"));
		clearAll();
		assert.deepEqual(topicStore.readTopics(), []);
	});
});

describe("store CRUD + assignment", () => {
	it("create → read → rename → assign → delete", () => {
		clearAll();
		const created = topicStore.createTopic("  Chinese  ");
		assert.match(created.id, /^top_[0-9a-f]{12}$/);
		assert.equal(created.name, "Chinese", "trimmed");
		assert.ok(!Number.isNaN(Date.parse(created.createdAt)), "ISO createdAt");
		assert.deepEqual(created.sessionIds, []);

		assert.deepEqual(topicStore.readTopics(), [created]);

		const renamed = topicStore.renameTopic(created.id, "Mandarin");
		assert.equal(renamed.name, "Mandarin");
		assert.equal(renamed.createdAt, created.createdAt, "createdAt stays put");
		assert.deepEqual(topicStore.readTopics(), [renamed]);

		const assigned = topicStore.assignSessions(renamed.id, { add: ["chat_a", "chat_b", "chat_a"] });
		assert.deepEqual(assigned.sessionIds, ["chat_a", "chat_b"], "deduped, insertion order kept");
		const removed = topicStore.assignSessions(renamed.id, { remove: ["chat_a"] });
		assert.deepEqual(removed.sessionIds, ["chat_b"]);
		assert.deepEqual(topicStore.assignSessions(renamed.id, {}).sessionIds, ["chat_b"], "empty change is a no-op");

		assert.ok(topicStore.deleteTopic(renamed.id), "delete of a known id");
		assert.deepEqual(topicStore.readTopics(), []);
		assert.ok(!topicStore.deleteTopic(renamed.id), "unknown id → false (the route's 404)");
	});

	it("the name gates: empty-after-trim and >120 chars reject with thrown Errors", () => {
		assert.throws(() => topicStore.createTopic("   "), /empty/);
		assert.throws(() => topicStore.createTopic("x".repeat(MAX_TOPIC_NAME + 1)), /limited to 120/);
		assert.throws(() => topicStore.renameTopic("top_000000000000", "x"), /Unknown topic/);
		assert.throws(() => topicStore.assignSessions("top_000000000000", { add: ["chat_x"] }), /Unknown topic/);
		// exactly at the ceiling passes (the gate is exclusive)
		const atCeiling = topicStore.createTopic("y".repeat(MAX_TOPIC_NAME));
		assert.equal(atCeiling.name.length, MAX_TOPIC_NAME);
		topicStore.deleteTopic(atCeiling.id);
	});

	it("deleteTopic removes the GROUP only — the store never touches chats or the graph", () => {
		clearAll();
		const chat = chatStore.createChat("Doomed-topic member");
		const t = topicStore.createTopic("Doomed");
		topicStore.assignSessions(t.id, { add: [chat.id] });
		appendNode("n_doomed", "Doomed node", [chat.id]);
		assert.ok(topicStore.deleteTopic(t.id));
		assert.ok(chatStore.getChat(chat.id), "the session record survives");
		assert.ok(graphStore.readNodes().some((n) => n.id === "n_doomed"), "the graph node survives");
	});

	it("findTopicBySession: FIRST match in creation order; null when unassigned", () => {
		clearAll();
		const first = topicStore.createTopic("First");
		const second = topicStore.createTopic("Second");
		topicStore.assignSessions(second.id, { add: ["chat_shared"] });
		topicStore.assignSessions(first.id, { add: ["chat_shared", "chat_only_first"] });
		assert.equal(topicStore.findTopicBySession("chat_shared")?.id, first.id, "first topic wins");
		assert.equal(topicStore.findTopicBySession("chat_only_first")?.id, first.id);
		assert.equal(topicStore.findTopicBySession("chat_nobody"), null);
	});

	it("sanitize safety — a hostile file never throws, never lies", () => {
		clearAll();
		fs.writeFileSync(PATHS.topics, "{not json", "utf-8");
		assert.deepEqual(topicStore.readTopics(), []);

		fs.writeFileSync(PATHS.topics, JSON.stringify([1, 2, 3]), "utf-8");
		assert.deepEqual(topicStore.readTopics(), [], "a top-level array is not a topics file");

		fs.writeFileSync(
			PATHS.topics,
			JSON.stringify({ version: 99, topics: [{ id: "top_aaaaaaaaaaaa", name: "from the future", sessionIds: [], createdAt: "2026-01-01T00:00:00.000Z" }] }),
			"utf-8",
		);
		assert.deepEqual(topicStore.readTopics(), [], "a NEWER format stamp is refused (the chats.ts precedent)");

		fs.writeFileSync(
			PATHS.topics,
			JSON.stringify({
				version: 1,
				topics: [
					{ id: "top_bbbbbbbbbbbb", name: "kept", sessionIds: ["chat_ok"], createdAt: "2026-01-02T00:00:00.000Z" },
					{ id: "top_cccccccccccc", name: "bad sessions", sessionIds: ["chat_ok", 7], createdAt: "2026-01-02T00:00:00.000Z" },
					"junk string",
					42,
					{ id: 7, name: "no" },
					{ name: "no id" },
				],
			}),
			"utf-8",
		);
		const kept = topicStore.readTopics();
		assert.equal(kept.length, 1, "malformed topics are filtered, the rest survives");
		assert.equal(kept[0]!.name, "kept");
		assert.deepEqual(kept[0]!.sessionIds, ["chat_ok"]);
		assert.equal(topicStore.deleteTopic(kept[0]!.id), true, "the store still writes sanely after a hostile read");
	});
});

describe("the pure derivation (core/topics.ts)", () => {
	const topics: Topic[] = [
		{ id: "top_1", name: "Chinese", sessionIds: ["chat_cn", "chat_src1"], createdAt: "2026-01-01T00:00:00.000Z" },
		{ id: "top_2", name: "Logic", sessionIds: ["chat_logic"], createdAt: "2026-01-02T00:00:00.000Z" },
	];
	// A provenance-point builder: topicOfNode's parameter is structural
	// ({chatId}); building through a fn keeps the object literals out of
	// excess-property checks while staying ProvenancePoint-honest.
	const prov = (chatId: string) => ({ chatId, messageId: "m" });

	it("topicOfNode: first topic whose sessions intersect the provenance", () => {
		assert.equal(topicOfNode({ provenance: [prov("chat_cn")] }, topics)?.id, "top_1");
		assert.equal(topicOfNode({ provenance: [prov("chat_x"), prov("chat_logic")] }, topics)?.id, "top_2");
		assert.equal(topicOfNode({ provenance: [] }, topics), null);
		assert.equal(topicOfNode({ provenance: [prov("chat_none")] }, topics), null);
		// notes-source ids are birth sessions too — they assign like chats
		assert.equal(topicOfNode({ provenance: [prov("chat_src1")] }, topics)?.id, "top_1");
	});

	it("topicOfChat: first containing topic; null when unassigned", () => {
		assert.equal(topicOfChat("chat_logic", topics)?.id, "top_2");
		assert.equal(topicOfChat("chat_cn", topics)?.id, "top_1");
		assert.equal(topicOfChat("chat_none", topics), null);
	});

	it("withTopicStats: one pass, a shared node counts for EVERY topic it belongs to", () => {
		const nodes = [
			{ provenance: [{ chatId: "chat_cn", messageId: "m" }] },
			{ provenance: [{ chatId: "chat_cn", messageId: "m" }, { chatId: "chat_logic", messageId: "m" }] },
			{ provenance: [{ chatId: "chat_logic", messageId: "m" }] },
			{ provenance: [{ chatId: "chat_none", messageId: "m" }] },
		];
		const stats = withTopicStats(topics, nodes);
		assert.deepEqual(
			stats.map((s) => ({ id: s.id, sessionCount: s.sessionCount, nodeCount: s.nodeCount })),
			[
				{ id: "top_1", sessionCount: 2, nodeCount: 2 },
				{ id: "top_2", sessionCount: 1, nodeCount: 2 },
			],
		);
		assert.deepEqual(withTopicStats([], nodes), []);
	});

	it("topicNodeGroups: the layout engine's fold — per topic, the nodes whose provenance touches it", () => {
		const nodes = [
			{ id: "n_cn1", provenance: [prov("chat_cn")] },
			{ id: "n_cn2", provenance: [prov("chat_cn"), prov("chat_logic")] }, // shared → FIRST topic only
			{ id: "n_logic", provenance: [prov("chat_logic")] },
			{ id: "n_none", provenance: [prov("chat_none")] }, // unassigned session
			{ id: "n_bare", provenance: [] }, // no provenance at all
		];
		// Group order is TOPIC order (positional, regardless of which
		// topic's nodes appeared first in the node list).
		assert.deepEqual(topicNodeGroups(topics, nodes), [
			{ id: "top_1", nodeIds: ["n_cn1", "n_cn2"] },
			{ id: "top_2", nodeIds: ["n_logic"] },
		]);
		// Topics without matching nodes drop out; empty topics → no groups.
		assert.deepEqual(topicNodeGroups([{ id: "top_x", name: "X", sessionIds: ["chat_nowhere"], createdAt: "" }], nodes), []);
		assert.deepEqual(topicNodeGroups([], nodes), []);
		// The nodeIds feed the sim force directly — no dedupe needed, but
		// a shared node must appear EXACTLY once (first-match law).
		const groups = topicNodeGroups(topics, nodes);
		assert.equal(groups.flatMap((g) => g.nodeIds).filter((id) => id === "n_cn2").length, 1);
	});
});

describe("route handlers (app/api/topics)", () => {
	it("GET carries the derived stats; POST 201s a topic; bad bodies are 400s", async () => {
		clearAll();
		const created = await topicsRoute.POST(jsonRequest("POST", "http://localhost/api/topics", { name: "  Chinese  " }));
		assert.equal(created.status, 201);
		const saved = (await created.json()) as { topic: Topic };
		assert.equal(saved.topic.name, "Chinese", "trimmed");
		assert.match(saved.topic.id, /^top_[0-9a-f]{12}$/);

		// Graph provenance: one node in-topic (chat_cn), one out (chat_out).
		appendNode("n_in", "In-topic", ["chat_cn"]);
		appendNode("n_out", "Out-of-topic", ["chat_out"]);
		topicStore.assignSessions(saved.topic.id, { add: ["chat_cn", "chat_cn2"] });

		const get = await topicsRoute.GET();
		assert.equal(get.status, 200);
		const list = (await get.json()) as { topics: Array<{ id: string; name: string; sessionCount: number; nodeCount: number }> };
		assert.equal(list.topics.length, 1);
		assert.equal(list.topics[0]!.sessionCount, 2);
		assert.equal(list.topics[0]!.nodeCount, 1, "only the in-topic provenance counts");

		const empty = await topicsRoute.POST(jsonRequest("POST", "http://localhost/api/topics", { name: "   " }));
		assert.equal(empty.status, 400);
		const oversized = await topicsRoute.POST(jsonRequest("POST", "http://localhost/api/topics", { name: "x".repeat(MAX_TOPIC_NAME + 1) }));
		assert.equal(oversized.status, 400);
		const wrongShape = await topicsRoute.POST(jsonRequest("POST", "http://localhost/api/topics", { name: 5 }));
		assert.equal(wrongShape.status, 400);
		const badJson = await topicsRoute.POST(new Request("http://localhost/api/topics", { method: "POST", body: "{", headers: { "content-type": "application/json" } }));
		assert.equal(badJson.status, 400);
		assert.equal(topicStore.readTopics().length, 1, "rejections wrote nothing");
	});

	it("PUT renames and re-assigns; 404 unknown; 400 malformed; DELETE is group-only", async () => {
		clearAll();
		const { topic } = (await (await topicsRoute.POST(jsonRequest("POST", "http://localhost/api/topics", { name: "Chinese" }))).json()) as { topic: Topic };

		const put = await topicItemRoute.PUT(
			jsonRequest("PUT", `http://localhost/api/topics/${topic.id}`, { name: " Mandarin ", addSessionIds: ["chat_a", "chat_b"] }),
			{ params: Promise.resolve({ id: topic.id }) },
		);
		assert.equal(put.status, 200);
		const updated = (await put.json()) as { topic: Topic };
		assert.equal(updated.topic.name, "Mandarin", "renamed");
		assert.deepEqual(updated.topic.sessionIds, ["chat_a", "chat_b"], "assigned");

		const remove = await topicItemRoute.PUT(
			jsonRequest("PUT", `http://localhost/api/topics/${topic.id}`, { removeSessionIds: ["chat_a"] }),
			{ params: Promise.resolve({ id: topic.id }) },
		);
		assert.deepEqual(((await remove.json()) as { topic: Topic }).topic.sessionIds, ["chat_b"], "removed");

		const missing = await topicItemRoute.PUT(
			jsonRequest("PUT", "http://localhost/api/topics/top_000000000000", { name: "x" }),
			{ params: Promise.resolve({ id: "top_000000000000" }) },
		);
		assert.equal(missing.status, 404);
		const badList = await topicItemRoute.PUT(
			jsonRequest("PUT", `http://localhost/api/topics/${topic.id}`, { addSessionIds: ["chat_a", 7] }),
			{ params: Promise.resolve({ id: topic.id }) },
		);
		assert.equal(badList.status, 400);
		const badName = await topicItemRoute.PUT(
			jsonRequest("PUT", `http://localhost/api/topics/${topic.id}`, { name: 9 }),
			{ params: Promise.resolve({ id: topic.id }) },
		);
		assert.equal(badName.status, 400);
		const badJson = await topicItemRoute.PUT(
			new Request(`http://localhost/api/topics/${topic.id}`, { method: "PUT", body: "{", headers: { "content-type": "application/json" } }),
			{ params: Promise.resolve({ id: topic.id }) },
		);
		assert.equal(badJson.status, 400);

		// DELETE: group only — the assigned chat record + its graph node stay.
		const chat = chatStore.createChat("Deletion survivor");
		topicStore.assignSessions(topic.id, { add: [chat.id] });
		appendNode("n_survivor", "Survivor", [chat.id]);
		const del = await topicItemRoute.DELETE(
			new Request(`http://localhost/api/topics/${topic.id}`, { method: "DELETE" }),
			{ params: Promise.resolve({ id: topic.id }) },
		);
		assert.equal(del.status, 200);
		assert.deepEqual(await del.json(), {});
		assert.deepEqual(topicStore.readTopics(), []);
		assert.ok(chatStore.getChat(chat.id), "the session record is untouched");
		assert.ok(graphStore.readNodes().some((n) => n.id === "n_survivor"), "the graph node is untouched");

		const missingDel = await topicItemRoute.DELETE(
			new Request(`http://localhost/api/topics/${topic.id}`, { method: "DELETE" }),
			{ params: Promise.resolve({ id: topic.id }) },
		);
		assert.equal(missingDel.status, 404);
	});
});

describe("setChatTopic — the chat record's topic stamp (the in-session tools' write-through)", () => {
	it("stamps, null removes the field, announces post-write, no-ops unknown ids", () => {
		clearAll();
		const chat = chatStore.createChat("Topic stamp fixture");
		const t = topicStore.createTopic("Stamped");
		let announces = 0;
		const off = subscribe((e) => {
			if (e.type === "chats-changed") announces++;
		});

		const before = chatStore.getChat(chat.id)!;
		const stamped = chatStore.setChatTopic(chat.id, t.id);
		assert.ok(stamped);
		assert.equal(stamped.topicId, t.id);
		assert.equal(stamped.updatedAt, before.updatedAt, "NOT conversation activity — sidebar order never churns");
		assert.equal(chatStore.getChat(chat.id)?.topicId, t.id, "durable");
		assert.equal(announces, 1, "a list-visible write announces (the topic rides the list payload)");

		const cleared = chatStore.setChatTopic(chat.id, null);
		assert.ok(cleared);
		assert.equal("topicId" in cleared, false, "null REMOVES the field — absence reads as unassigned");
		assert.equal(announces, 2);

		assert.equal(chatStore.setChatTopic("chat_nope", t.id), null, "unknown id — the honest no-op");
		assert.equal(announces, 2, "nothing was written — nothing announced");
		off();
	});
});

describe("session creation with a topic (POST /api/chats)", () => {
	it("stamps the record and PREFERS the topic's propositions in the injected context", async () => {
		clearAll();
		const { topic } = (await (await topicsRoute.POST(jsonRequest("POST", "http://localhost/api/topics", { name: "Chinese" }))).json()) as { topic: Topic };
		const inTopic = chatStore.createChat("Chinese grammar");
		const other = chatStore.createChat("Unrelated");
		topicStore.assignSessions(topic.id, { add: [inTopic.id] });
		appendNode("n_ba", "把-construction", [inTopic.id]);
		appendNode("n_pythagoras", "Pythagoras", [other.id]);

		// The learner picks ONLY the out-of-topic node; the topic's own
		// propositions must still LEAD the injected context.
		const res = await chatsRoute.POST(
			jsonRequest("POST", "http://localhost/api/chats", {
				title: "teach me 把",
				topicId: topic.id,
				graphContext: { propositions: [{ id: "n_pythagoras", name: "Pythagoras", statement: "Statement of Pythagoras." }] },
			}),
		);
		assert.equal(res.status, 200);
		const { id } = (await res.json()) as { id: string };
		const record = chatStore.getChat(id);
		assert.ok(record);
		assert.equal(record.topicId, topic.id, "the record carries the topic stamp");

		const marker = record.messages[0] as { customType?: string; details?: { propositions?: { id: string }[] } } | undefined;
		assert.ok(marker && marker.customType === "graph-context", "message[0] is the graph-context marker");
		assert.deepEqual(
			marker!.details!.propositions!.map((p) => p.id),
			["n_ba", "n_pythagoras"],
			"topic propositions seed the picks BEFORE the learner's own",
		);
		assert.match(marker && typeof marker === "object" && "content" in marker ? String((marker as { content?: unknown }).content) : "", /把-construction/);

		// No client picks at all: the topic's propositions alone open the map context.
		const res2 = await chatsRoute.POST(jsonRequest("POST", "http://localhost/api/chats", { title: "继续", topicId: topic.id }));
		assert.equal(res2.status, 200);
		const { id: id2 } = (await res2.json()) as { id: string };
		const record2 = chatStore.getChat(id2)!;
		assert.equal(record2.topicId, topic.id);
		const marker2 = record2.messages[0] as { customType?: string; details?: { propositions?: { id: string }[] } };
		assert.deepEqual(marker2.details!.propositions!.map((p) => p.id), ["n_ba"], "the topic seeds alone");

		// A topicless creation stays pickless — byte-identical pre-topics behavior.
		const res3 = await chatsRoute.POST(jsonRequest("POST", "http://localhost/api/chats", { title: "no topic" }));
		const record3 = chatStore.getChat(((await res3.json()) as { id: string }).id)!;
		assert.equal(record3.topicId, undefined);
		assert.equal(record3.messages.length, 0, "no graph context injected");
	});

	it("an unknown topicId is a clean 400 BEFORE the record exists", async () => {
		const before = chatStore.listChats().length;
		const res = await chatsRoute.POST(jsonRequest("POST", "http://localhost/api/chats", { title: "ghost", topicId: "top_000000000000" }));
		assert.equal(res.status, 400);
		assert.equal(chatStore.listChats().length, before, "nothing was created");
	});
});
