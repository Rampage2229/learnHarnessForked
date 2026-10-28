/**
 * AUTO TOPIC ASSIGNMENT (topics v1, personal fork) — the whole vertical,
 * hermetic under an isolated LH_DATA_DIR (the memory.test.ts discipline —
 * the seam is set BEFORE any config-loading import, every app-module
 * import is dynamic):
 *
 *   1. THE CLASSIFIER (classifyTopicAssignment): a FAKE modelCall + a fake
 *      catalog — assign/create/none, prose-wrapped JSON, garbage → none,
 *      unknown assign id → none, empty/oversized create name → none, a
 *      failing model → none, over the 50-topic cap → none (model never
 *      called). The prompt carries the opening verbatim + each topic's
 *      name, member-session titles, and sample proposition names.
 *   2. THE PRODUCTION DEPS (makeTopicAssignmentDeps): hermetic failure
 *      envelope — no cheap slot → modelCall rejects; a slot naming a
 *      model the catalog lacks → rejects. No network anywhere. listTopics
 *      folds the REAL stores (session titles + provenance-filtered node
 *      names).
 *   3. THE ROUTE (POST /api/chats, "agent" mode): the deps factory
 *      swapped for a stub — assign stamps the newborn record, create
 *      makes the topic and stamps, a classifier failure still creates
 *      (unassigned), ask mode / short openings / explicit topicIds never
 *      call the classifier.
 *   4. THE IN-SESSION TOOLS: the registration gate (present wiring = the
 *      trio in the TEACHER's registry) + the wiring's double-write
 *      semantics against the REAL stores (topic sessionIds AND the chat
 *      record's stamp, honest rejections).
 *   5. THE TEACHER'S TOPIC-MODE BLOCK (topicModeBlockFor).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-topic-assignment-"));
process.env.LH_DATA_DIR = TMP;

const {
	classifyTopicAssignment,
	buildAssignmentPrompt,
	makeTopicAssignmentDeps,
	setTopicAssignmentDepsFactory,
	topicModeBlockFor,
	TOPIC_ASSIGNMENT_TOPIC_CAP,
} = await import("../src/server/topic-assignment.ts");
const { topicStore } = await import("../src/store/topics.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const chatsRoute = await import("../app/api/chats/route.ts");
const { createTeacherTools } = await import("../src/agent/tools.ts");
const { topicToolsWiring } = await import("../src/server/chat-handler.ts");
import type { JobStore } from "../src/core/ports.ts";
import type { GraphNode } from "../src/core/contracts.ts";
import type { TopicAssignmentDeps } from "../src/server/topic-assignment.ts";

after(() => {
	setTopicAssignmentDepsFactory(null);
	fs.rmSync(TMP, { recursive: true, force: true });
});

function jsonRequest(method: string, url: string, body?: unknown): Request {
	return new Request(url, {
		method,
		headers: body !== undefined ? { "content-type": "application/json" } : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
}

/** One provenance-carrying graph node, appended to the real ledger (the
 *  topics.test.ts helper). */
function appendNode(id: string, name: string, chatIds: string[]): void {
	const node: GraphNode = {
		id,
		name,
		statement: `Statement of ${name}.`,
		aliases: [],
		createdAt: new Date().toISOString(),
		provenance: chatIds.map((chatId) => ({ chatId, messageId: `${id}-m1` })),
	};
	graphStore.appendNode(node);
}

function clearTopics(): void {
	for (const t of topicStore.readTopics()) topicStore.deleteTopic(t.id);
}

/** The classifier's fake catalog — Mandarin has content, Logic is empty. */
const catalog = [
	{
		id: "top_aaaaaaaaaaaa",
		name: "Mandarin",
		sessionTitles: ["HSK3 grammar drills", "把-construction practice"],
		samplePropositions: ["把-construction", "Tone sandhi rules"],
	},
	{ id: "top_bbbbbbbbbbbb", name: "Logic", sessionTitles: [], samplePropositions: [] },
];

/** A deps pair: the model's canned reply + a call log, over the fake
 *  catalog. */
function fakeDeps(reply: string | Error, listed: typeof catalog = catalog): { deps: TopicAssignmentDeps; calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		deps: {
			modelCall: async (prompt: string) => {
				calls.push(prompt);
				if (reply instanceof Error) throw reply;
				return reply;
			},
			listTopics: () => listed,
		},
	};
}

// ─── 1. the classifier ───────────────────────────────────────────────────────

describe("classifyTopicAssignment (fake modelCall, hermetic)", () => {
	it("assign: a clean reply resolves to the topic it named", async () => {
		const { deps } = fakeDeps('{"action":"assign","topicId":"top_aaaaaaaaaaaa"}');
		assert.deepEqual(await classifyTopicAssignment(deps, "continue my mandarin grammar practice"), {
			action: "assign",
			topicId: "top_aaaaaaaaaaaa",
		});
	});

	it("assign survives prose around the JSON object (the first {...} wins)", async () => {
		const { deps } = fakeDeps('Sure! Here is my answer:\n```json\n{"action":"assign","topicId":"top_bbbbbbbbbbbb"}\n```');
		assert.deepEqual(await classifyTopicAssignment(deps, "teach me propositional logic"), {
			action: "assign",
			topicId: "top_bbbbbbbbbbbb",
		});
	});

	it("create: the name arrives trimmed and intact", async () => {
		const { deps } = fakeDeps('{"action":"create","name":"  Spanish verbs  "}');
		assert.deepEqual(await classifyTopicAssignment(deps, "let's start conjugating regular spanish verbs"), {
			action: "create",
			name: "Spanish verbs",
		});
	});

	it("none: the explicit verdict, garbage, and unknown shapes all degrade to none", async () => {
		for (const reply of [
			'{"action":"none"}',
			"no json in sight",
			"{broken json",
			"[]",
			'{"action":"drink","tea":true}',
			'{"action":123}',
			'{"action":"assign"}',
			'{"action":"assign","topicId":42}',
			'{"action":"assign","topicId":"top_noooooooooooo"}',
			'{"action":"create"}',
			'{"action":"create","name":"   "}',
			`{"action":"create","name":"${"x".repeat(121)}"}`,
		]) {
			const { deps } = fakeDeps(reply);
			assert.deepEqual(await classifyTopicAssignment(deps, "anything at all"), { action: "none" }, reply);
		}
	});

	it("a failing model call degrades to none — never throws", async () => {
		const { deps } = fakeDeps(new Error("provider exploded"));
		assert.deepEqual(await classifyTopicAssignment(deps, "continue my mandarin"), { action: "none" });
	});

	it("over the topic cap → none, and the model is never called", async () => {
		const many = Array.from({ length: TOPIC_ASSIGNMENT_TOPIC_CAP + 1 }, (_, i) => ({
			id: `top_${String(i).padStart(12, "0")}`,
			name: `Topic ${i}`,
			sessionTitles: [],
			samplePropositions: [],
		}));
		const { deps, calls } = fakeDeps('{"action":"none"}', many);
		assert.deepEqual(await classifyTopicAssignment(deps, "a long enough opening prompt here"), { action: "none" });
		assert.equal(calls.length, 0, "the cap short-circuits before the spend");
	});

	it("the prompt carries the opening verbatim + the topics' names, sessions, and propositions", async () => {
		const { deps, calls } = fakeDeps('{"action":"none"}');
		const opening = "continue my mandarin grammar practice\nwith 把 sentences please";
		await classifyTopicAssignment(deps, opening);
		assert.equal(calls.length, 1);
		const prompt = calls[0]!;
		assert.ok(prompt.includes(opening), "the opening, verbatim");
		assert.ok(prompt.includes("Existing topics:"), "the catalog header");
		assert.ok(
			prompt.includes("- Mandarin — id: top_aaaaaaaaaaaa (2 sessions; member sessions: HSK3 grammar drills, 把-construction practice; propositions: 把-construction, Tone sandhi rules)"),
			"the topic line: name, session count, member-session titles, sample propositions",
		);
		assert.ok(prompt.includes("- Logic — id: top_bbbbbbbbbbbb (0 sessions; member sessions: no member sessions yet; propositions: no propositions yet)"), "the honest empty-topic line");
		assert.ok(prompt.includes('{"action":"none"}'), "the none instruction");
		assert.ok(prompt.includes("at most 60 characters"), "the create-name bound");
	});

	it("an empty catalog is stated honestly, not omitted", () => {
		const prompt = buildAssignmentPrompt("hello there", []);
		assert.ok(prompt.includes("(none — the learner has no topics yet)"));
		assert.ok(prompt.includes("hello there"));
	});
});

// ─── 2. the production deps (hermetic parts) ────────────────────────────────

describe("makeTopicAssignmentDeps — the failure envelope + the store fold", () => {
	it("no cheap slot configured → modelCall rejects (nothing to run)", async () => {
		writeSettings({ version: 1 });
		const deps = makeTopicAssignmentDeps();
		await assert.rejects(() => deps.modelCall("any prompt"));
	});

	it("a cheap slot naming a model the catalog lacks → modelCall rejects (no network)", async () => {
		writeSettings({ version: 1, models: { cheap: { model: { provider: "no-such-provider-xyz", id: "m" } } } });
		const deps = makeTopicAssignmentDeps();
		await assert.rejects(() => deps.modelCall("any prompt"));
	});

	it("listTopics folds the REAL stores: session titles + provenance-filtered proposition names", () => {
		clearTopics();
		const member = chatStore.createChat("Mandarin member session");
		const other = chatStore.createChat("Out-of-topic session");
		const t = topicStore.createTopic("Mandarin");
		topicStore.assignSessions(t.id, { add: [member.id] });
		appendNode("n_ba", "把-construction", [member.id]);
		appendNode("n_out", "Out-of-topic node", [other.id]);

		const deps = makeTopicAssignmentDeps();
		const listed = deps.listTopics().find((x) => x.id === t.id)!;
		assert.equal(listed.name, "Mandarin");
		assert.deepEqual(listed.sessionTitles, ["Mandarin member session"]);
		assert.deepEqual(listed.samplePropositions, ["把-construction"], "only the topic's own provenance");
	});
});

// ─── 3. the route (POST /api/chats, agent mode) ─────────────────────────────

describe("POST /api/chats — the agent-mode classifier", () => {
	it("an assign verdict stamps the newborn record at creation", async () => {
		clearTopics();
		writeSettings({ version: 1 });
		const mandarin = topicStore.createTopic("Mandarin");
		const calls: string[] = [];
		setTopicAssignmentDepsFactory(() => ({
			modelCall: async (prompt) => {
				calls.push(prompt);
				return JSON.stringify({ action: "assign", topicId: mandarin.id });
			},
			listTopics: () => [{ id: mandarin.id, name: "Mandarin", sessionTitles: [], samplePropositions: [] }],
		}));

		const res = await chatsRoute.POST(
			jsonRequest("POST", "http://localhost/api/chats", { title: "continue my mandarin grammar practice" }),
		);
		assert.equal(res.status, 200);
		const { id } = (await res.json()) as { id: string };
		const record = chatStore.getChat(id);
		assert.ok(record);
		assert.equal(record.topicId, mandarin.id, "born stamped");
		assert.equal(calls.length, 1);
		assert.ok(calls[0]!.includes("mandarin grammar practice"), "the opening rode the prompt");
		chatStore.deleteChat(id);
	});

	it("a create verdict makes the topic and stamps the record with it", async () => {
		clearTopics();
		setTopicAssignmentDepsFactory(() => ({
			modelCall: async () => JSON.stringify({ action: "create", name: "Spanish" }),
			listTopics: () => [],
		}));
		const res = await chatsRoute.POST(
			jsonRequest("POST", "http://localhost/api/chats", { title: "conjugate regular spanish verbs with me" }),
		);
		assert.equal(res.status, 200);
		const { id } = (await res.json()) as { id: string };
		const record = chatStore.getChat(id)!;
		const created = topicStore.readTopics().find((t) => t.id === record.topicId);
		assert.ok(created, "the topic exists");
		assert.equal(created.name, "Spanish");
		assert.ok(topicStore.readTopics().some((t) => t.name === "Spanish"), "the store holds it");
		chatStore.deleteChat(id);
	});

	it("a failing classifier still creates the chat — unassigned, 200", async () => {
		clearTopics();
		setTopicAssignmentDepsFactory(() => ({
			modelCall: async () => {
				throw new Error("no network in tests");
			},
			listTopics: () => [],
		}));
		const res = await chatsRoute.POST(
			jsonRequest("POST", "http://localhost/api/chats", { title: "teach me the chain rule please" }),
		);
		assert.equal(res.status, 200);
		const { id } = (await res.json()) as { id: string };
		assert.equal(chatStore.getChat(id)?.topicId, undefined, "unassigned, not failed");
		chatStore.deleteChat(id);
	});

	it("ask mode, short openings, and explicit topicIds never call the classifier", async () => {
		clearTopics();
		const t = topicStore.createTopic("Mandarin");
		let calls = 0;
		setTopicAssignmentDepsFactory(() => ({
			modelCall: async () => {
				calls++;
				return '{"action":"none"}';
			},
			listTopics: () => [],
		}));

		// Short opening (≤ 12 chars) in agent mode.
		writeSettings({ version: 1 });
		let res = await chatsRoute.POST(jsonRequest("POST", "http://localhost/api/chats", { title: "hi there" }));
		assert.equal(((await res.json()) as { id: string }).id.length > 0, true);
		assert.equal(calls, 0, "short opening — no call");

		// Explicit topicId in agent mode.
		res = await chatsRoute.POST(
			jsonRequest("POST", "http://localhost/api/chats", { title: "continue my mandarin grammar practice", topicId: t.id }),
		);
		const explicit = (await res.json()) as { id: string };
		assert.equal(chatStore.getChat(explicit.id)?.topicId, t.id, "the explicit path still wins");
		assert.equal(calls, 0, "explicit topicId — no call");
		chatStore.deleteChat(explicit.id);

		// Ask mode: no creation-time call at all.
		writeSettings({ version: 1, agent: { topicAssignment: "ask" } });
		res = await chatsRoute.POST(
			jsonRequest("POST", "http://localhost/api/chats", { title: "continue my mandarin grammar practice" }),
		);
		const asked = (await res.json()) as { id: string };
		assert.equal(chatStore.getChat(asked.id)?.topicId, undefined, "ask mode leaves it unassigned");
		assert.equal(calls, 0, "ask mode — no call");
		chatStore.deleteChat(asked.id);
	});
});

// ─── 4. the in-session topic tools ──────────────────────────────────────────

const stubJobStore = {
	createJob: (() => ({})) as never,
	getJob: (() => undefined) as never,
	listJobs: (() => []) as never,
	updateJob: (() => {}) as never,
} as unknown as JobStore;

const baseCtx = {
	chatId: "c1",
	jobStore: stubJobStore,
	spawn: () => {},
};

describe("the teacher's topic tools — registration + wiring", () => {
	it("no topicTools in the teacher context → the trio is absent (the seam decides)", () => {
		const tools = createTeacherTools({ ...baseCtx, chatStore: {} as never });
		for (const name of ["list_topics", "assign_topic", "create_topic"]) {
			assert.equal(name in tools, false, name);
		}
	});

	it("topicTools present → all three join the teacher registry", () => {
		const tools = createTeacherTools({
			...baseCtx,
			chatStore: {} as never,
			topicTools: { list: () => [], assign: () => ({ ok: true }), create: () => ({ ok: true }) },
		});
		for (const name of ["list_topics", "assign_topic", "create_topic"]) {
			assert.equal(name in tools, true, name);
		}
	});

	it("the wiring: list reflects the real store; assign double-writes (topic + record stamp)", () => {
		clearTopics();
		const chat = chatStore.createChat("Wiring fixture");
		const wiring = topicToolsWiring(chat.id);
		const t = topicStore.createTopic("Mandarin");
		topicStore.createTopic("Empty");

		assert.deepEqual(
			wiring.list().map((x) => ({ id: x.id, name: x.name, sessionCount: x.sessionCount })),
			[
				{ id: t.id, name: "Mandarin", sessionCount: 0 },
				{ id: topicStore.readTopics()[1]!.id, name: "Empty", sessionCount: 0 },
			],
		);

		const assigned = wiring.assign(t.id);
		assert.deepEqual(assigned, { ok: true });
		assert.deepEqual(topicStore.readTopics().find((x) => x.id === t.id)?.sessionIds, [chat.id], "the topic holds the session");
		assert.equal(chatStore.getChat(chat.id)?.topicId, t.id, "the record is stamped");

		const unknown = wiring.assign("top_000000000000");
		assert.equal(unknown.ok, false);
		assert.match(unknown.error ?? "", /Unknown topic/);
	});

	it("the wiring: create makes the group AND stamps the record; the name gate is the error result", () => {
		clearTopics();
		const chat = chatStore.createChat("Create fixture");
		const wiring = topicToolsWiring(chat.id);

		const created = wiring.create("  Spanish  ");
		assert.equal(created.ok, true);
		const topic = topicStore.readTopics().find((x) => x.id === created.topicId);
		assert.equal(topic?.name, "Spanish", "trimmed");
		assert.deepEqual(topic?.sessionIds, [chat.id]);
		assert.equal(chatStore.getChat(chat.id)?.topicId, created.topicId, "the record is stamped");

		const empty = wiring.create("   ");
		assert.equal(empty.ok, false);
		assert.match(empty.error ?? "", /empty/);
		const oversized = wiring.create("x".repeat(121));
		assert.equal(oversized.ok, false);
		assert.match(oversized.error ?? "", /limited to 120/);
		assert.equal(topicStore.readTopics().filter((t) => t.name === "Spanish").length, 1, "the rejections wrote nothing");
	});

	it("tool executes: list renders ids; a rejected call returns the error as the RESULT (never throws)", async () => {
		clearTopics();
		const chat = chatStore.createChat("Execute fixture");
		const wiring = topicToolsWiring(chat.id);
		const t = topicStore.createTopic("Mandarin");
		const tools = createTeacherTools({ ...baseCtx, chatStore: {} as never, topicTools: wiring });

		const listed = (await tools.list_topics!.execute!("tc", {})).details as string;
		assert.ok(listed.includes(`- Mandarin (0 sessions) — id: ${t.id}`), listed);

		const bad = (await tools.assign_topic!.execute!("tc", { topicId: "top_000000000000" })).details as string;
		assert.match(bad, /Unknown topic/);

		const ok = (await tools.assign_topic!.execute!("tc", { topicId: t.id })).details as string;
		assert.equal(ok, "Assigned this session to the topic.");
		assert.equal(chatStore.getChat(chat.id)?.topicId, t.id);

		const made = (await tools.create_topic!.execute!("tc", { name: "Spanish" })).details as string;
		assert.equal(made, "Created the topic and assigned this session to it.");
		const spanish = topicStore.readTopics().find((x) => x.name === "Spanish");
		assert.ok(spanish);
		assert.deepEqual(spanish.sessionIds, [chat.id], "the new group holds the session");
		assert.equal(chatStore.getChat(chat.id)?.topicId, spanish.id, "the record rides the newest assignment");

		const schema = (tools.create_topic!.parameters as { properties: { name: { maxLength?: number } } }).properties.name;
		assert.equal(schema.maxLength, 120, "the schema mirrors the store's gate");
	});
});

// ─── 5. the teacher's topic-mode block ──────────────────────────────────────

describe("topicModeBlockFor — the per-session prompt line", () => {
	it("an assigned session names its topic; a vanished id renders nothing", () => {
		clearTopics();
		const t = topicStore.createTopic("Mandarin");
		assert.equal(topicModeBlockFor({ topicId: t.id }, "ask"), 'This session belongs to the topic "Mandarin".');
		assert.equal(topicModeBlockFor({ topicId: t.id }, "agent"), 'This session belongs to the topic "Mandarin".');
		assert.equal(topicModeBlockFor({ topicId: "top_000000000000" }, "agent"), null, "the deleted-topic case");
	});

	it("an unassigned session gets its mode's doctrine line", () => {
		const ask = topicModeBlockFor({}, "ask")!;
		assert.ok(ask.includes("TOPIC ASSIGNMENT (ask mode)"));
		assert.ok(ask.includes("ask_user_question"), "the ask-first mechanism");
		assert.ok(ask.includes("Never assign without asking"));
		const agent = topicModeBlockFor({}, "agent")!;
		assert.ok(agent.includes("TOPIC ASSIGNMENT (agent mode)"));
		assert.ok(agent.includes("classifier chose not to assign it at creation"));
	});
});
