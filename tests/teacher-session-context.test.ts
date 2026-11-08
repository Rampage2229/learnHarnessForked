/**
 * Teacher topic-history access (feature ⑥, assistant-wave parity):
 *
 *  - createTeacherTools registers session_summaries + read_session exactly
 *    when the ctx carries the sessionSummaries wiring — the assistant
 *    registry's presence gate (same seam style as memorySave/topicTools).
 *  - Without the wiring both are absent: old call sites see today's set,
 *    changed by exactly those two keys.
 *
 * Registry-keys only: the tools' behavior is the shared session-summaries
 * module's (covered by the assistant-wave tests). Construction reads
 * nothing (every factory just closes over its ctx), so `null as never`
 * stubs suffice for the required ctx fields this test never invokes.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTeacherTools, type TeacherToolContext } from "../src/agent/tools.ts";
import type { SessionSummariesWiring } from "../src/agent/tools/session-summaries.ts";

/** Presence-gate stub: the registry keys off PRESENCE only — the stub
 *  never executes. */
const wiring: SessionSummariesWiring = {
	currentChatId: "current",
	topicIdOf: () => undefined,
	readTopics: () => [],
	getChat: () => null,
};

function baseCtx(): TeacherToolContext {
	return { chatId: "current", chatStore: null as never, jobStore: null as never, spawn: () => {} };
}

describe("createTeacherTools: the topic-history pair (feature ⑥, assistant-wave parity)", () => {
	it("with sessionSummaries wiring: session_summaries + read_session register", () => {
		const tools = createTeacherTools({ ...baseCtx(), sessionSummaries: wiring });
		assert.ok(tools.session_summaries, "session_summaries registered");
		assert.ok(tools.read_session, "read_session registered");
	});

	it("without the wiring: neither registers", () => {
		const tools = createTeacherTools(baseCtx());
		assert.equal(tools.session_summaries, undefined);
		assert.equal(tools.read_session, undefined);
	});

	it("the wiring changes exactly those two keys — the rest of the set is untouched", () => {
		const withPair = Object.keys(createTeacherTools({ ...baseCtx(), sessionSummaries: wiring })).sort();
		const without = Object.keys(createTeacherTools(baseCtx())).sort();
		assert.deepEqual(
			withPair.filter((key) => !without.includes(key)),
			["read_session", "session_summaries"],
		);
		assert.deepEqual(without, withPair.filter((key) => key !== "read_session" && key !== "session_summaries"));
	});
});
