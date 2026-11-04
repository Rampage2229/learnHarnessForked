/**
 * THE ASSISTANT AGENT (assistant wave, personal fork): the prompt
 * composition (its own directory + the CURATED shared four — no teaching
 * base, no question/confidence/file mechanics), the registry shape (fs
 * reads + ask + research/pdf + save_file + session_summaries — NO
 * quiz/explain/plan/probe), and the save_file/session_summaries tool
 * contracts against injected wiring (never the network, never the disk
 * outside a tmp home).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-assistant-"));
process.env.LH_DATA_DIR = TMP;
// save_file resolves against the LEARNER'S home (os.homedir → HOME env on
// POSIX) — point the process there so writes land in the tmp dir.
const REAL_HOME = process.env.HOME;
process.env.HOME = TMP;

after(() => {
	if (REAL_HOME !== undefined) process.env.HOME = REAL_HOME;
	fs.rmSync(TMP, { recursive: true, force: true });
});

const { saveFileTool } = await import("../src/agent/tools/save-file.ts");
const { sessionSummariesToolFor } = await import("../src/agent/tools/session-summaries.ts");
const { createAssistantTools } = await import("../src/agent/tools.ts");
const { composeInstructions, createAssistantAgent } = await import("../src/agent/teacher-agent.ts");
const { listSourceSegments } = await import("../src/agent/prompt-segments.ts");

// ── save_file ────────────────────────────────────────────────────────────────

describe("save_file (the first write into the learner's disk)", () => {
	it("writes a new file home-anchored, creating parents, and reports bytes", async () => {
		const result = (await saveFileTool.execute!("call_1", { path: "~/guides/relativity/notes.md", content: "# Notes\n\nE = mc^2" })).details as string;
		assert.match(result, /Wrote .*notes\.md/);
		const written = fs.readFileSync(path.join(TMP, "guides/relativity/notes.md"), "utf-8");
		assert.equal(written, "# Notes\n\nE = mc^2");
	});

	it("refuses to overwrite an existing file without the explicit flag", async () => {
		fs.writeFileSync(path.join(TMP, "exists.md"), "the learner's own edit");
		await assert.rejects(
			saveFileTool.execute!("call_2", { path: "exists.md", content: "clobber" }),
			/already exists.*overwrite: true/s,
		);
		// The learner's file is untouched.
		assert.equal(fs.readFileSync(path.join(TMP, "exists.md"), "utf-8"), "the learner's own edit");
	});

	it("overwrites only with overwrite: true", async () => {
		const result = (await saveFileTool.execute!("call_3", { path: "exists.md", content: "replaced", overwrite: true })).details as string;
		assert.match(result, /Overwrote/);
		assert.equal(fs.readFileSync(path.join(TMP, "exists.md"), "utf-8"), "replaced");
	});

	it("refuses a directory target and a filesystem root", async () => {
		fs.mkdirSync(path.join(TMP, "a-dir"));
		await assert.rejects(saveFileTool.execute!("call_4", { path: "a-dir", content: "x" }), /is a directory/);
		await assert.rejects(saveFileTool.execute!("call_5", { path: "/", content: "x" }), /filesystem root/);
	});
});

// ── session_summaries ────────────────────────────────────────────────────────

/** A compaction-marker message shape (the store's marker rides the record). */
const compactionMarker = (summary: string) => ({
	id: `m_${Math.random().toString(36).slice(2)}`,
	role: "custom",
	customType: "compaction",
	content: `[SESSION HISTORY COMPACTED] The transcript before this point was summarized to fit the context window; the summary below replaces it. Everything after this message is the verbatim recent transcript.\n\n${summary}`,
	display: true,
	details: { firstKeptMessageId: "m_first" },
	timestamp: 0,
});

function summariesCtx(members: Record<string, { title: string; messages: unknown[] } | null>, currentChatId: string) {
	return {
		currentChatId,
		topicIdOf: () => "t1",
		readTopics: () => [{ id: "t1", name: "Thermodynamics", sessionIds: Object.keys(members).concat([currentChatId]) }],
		getChat: (id: string) => (id in members ? (members[id] ?? null) : null),
	};
}

describe("session_summaries (the topic-history window)", () => {
	it("lists member sessions with their compaction summaries, excluding the current chat", async () => {
		const tool = sessionSummariesToolFor(
			summariesCtx(
				{
					c1: { title: "First law", messages: [compactionMarker("Learner covered heat vs work; solid on sign conventions.")] },
					c2: { title: "Entropy intro", messages: [{ id: "m1", role: "user", content: "what is entropy" }] },
				},
				"c3",
			),
		);
		const text = (await tool.execute!("call_1", {})).details as string;
		assert.match(text, /Thermodynamics/);
		assert.match(text, /First law/);
		assert.match(text, /heat vs work; solid on sign conventions/);
		// Not-compacted session reports honestly.
		assert.match(text, /Entropy intro/);
		assert.match(text, /no summary yet/);
		// The current chat never lists itself.
		assert.ok(!text.includes("(id: c3)"));
	});

	it("empty topic and unassigned sessions report honestly", async () => {
		const solo = sessionSummariesToolFor(summariesCtx({}, "c3"));
		assert.match((await solo.execute!("call_2", {})).details as string, /no other member sessions/);

		const unassigned = sessionSummariesToolFor({ currentChatId: "c3", topicIdOf: () => undefined, readTopics: () => [], getChat: () => null });
		assert.match((await unassigned.execute!("call_3", {})).details as string, /no topic assigned/);
	});

	it("unresolvable member ids say so instead of vanishing", async () => {
		const tool = sessionSummariesToolFor(summariesCtx({ c_gone: null }, "c3"));
		const out = (await tool.execute!("call_4", {})).details as string;
		assert.match(out, /unresolvable session c_gone/);
	});
});

// ── the registry + composition ───────────────────────────────────────────────

describe("createAssistantTools (the chatbox registry)", () => {
	it("carries the fs reads, ask, research/pdf, save_file, session_summaries — and NO lesson machinery", async () => {
		const tools = createAssistantTools({
			chatId: "c3",
			chatStore: { getChat: () => null } as never,
			jobStore: {} as never,
			spawn: () => {},
			sessionSummaries: summariesCtx({}, "c3"),
		});
		const names = Object.keys(tools);
		for (const must of ["read", "ls", "find", "grep", "ask_user_question", "research", "pdf", "save_file", "session_summaries"]) {
			assert.ok(names.includes(must), `missing ${must}`);
		}
		for (const banned of ["quiz", "explain", "probe", "probe_done", "plan_init", "problem", "conclude", "save_tree"]) {
			assert.ok(!names.includes(banned), `assistant must not carry ${banned}`);
		}
	});

	it("graphStore wiring adds the map readers; absent wiring omits them", async () => {
		const plain = Object.keys(createAssistantTools({ chatId: "c", chatStore: null as never, jobStore: null as never, spawn: () => {} }));
		assert.ok(!plain.includes("list_sessions"));
	});
});

describe("assistant prompt composition", () => {
	it("composes its own directory + the curated shared four — no teaching base", () => {
		const segments = listSourceSegments("assistant");
		const paths = segments.map((s) => s.path);
		assert.ok(paths.includes("assistant/00-base.md"));
		assert.ok(paths.includes("assistant/10-doctrine.md"));
		assert.ok(!paths.includes("system-prompt.md"), "the teaching base contradicts the assistant doctrine");
		assert.ok(paths.includes("shared/10-voice.md"));
		assert.ok(paths.includes("shared/40-formatting.md"));
		assert.ok(!paths.includes("shared/20-question-tools.md"));
		const text = composeInstructions("assistant");
		assert.match(text, /free-form study desk/);
		assert.match(text, /save_file/);
		assert.match(text, /LaTeX|latex/); // the formatting fragment rides
	});

	it("createAssistantAgent builds with the assistant identity", () => {
		const agent = createAssistantAgent(
			{ chatId: "c", chatStore: null as never, jobStore: null as never, spawn: () => {} },
			{
			// baseAgentOptions needs an engine — the faux never-streamed one
			// (practice-agents' smoke pattern).
			engine: {
				model: { api: "faux", provider: "faux", id: "faux-model", contextWindow: 8192 } as never,
				streamFn: (async () => {
					throw new Error("not streamed in this test");
				}) as never,
			},
		},
		);
		assert.ok(agent);
	});
});
