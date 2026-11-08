/**
 * Flow mode (flow wave, personal fork): the teaching-rhythm toggle's
 * composition seam — the settings chain (sanitize → parse → resolve),
 * the UI's pure writer, and the flow block the server hands the teacher
 * agent. The block's TEXT lives in src/agent/prompts/teacher-flow.md,
 * outside the scanned fragment dirs (a teacher/ fragment would compose
 * for every teacher unconditionally — flow is a runtime mode).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { composeTeachingRhythm } = await import("../components/settings/agent-section.tsx");
const { flowBlockText } = await import("../src/agent/prompt-segments.ts");
const { resolveSettings } = await import("../src/core/settings-resolution.ts");
const { sanitizeUserSettings } = await import("../src/core/settings.ts");

describe("flow mode — the teaching rhythm chain", () => {
	it("the settings chain carries flowMode end to end", () => {
		// sanitize keeps only the two rhythms
		assert.equal(sanitizeUserSettings({ version: 1, agent: { flowMode: "flow" } })?.agent?.flowMode, "flow");
		// resolution makes it CONCRETE (absent = guided)
		assert.equal(resolveSettings({ version: 1, agent: { flowMode: "flow" } }).agent.flowMode, "flow");
		assert.equal(resolveSettings({ version: 1 }).agent.flowMode, "guided");
	});

	it("the UI writer writes flowMode-ONLY (the composeX law)", () => {
		const agent = { questionMode: "teacher", flowMode: "guided" } as const;
		const next = composeTeachingRhythm(agent as never, "flow");
		assert.equal(next.flowMode, "flow");
		assert.equal(next.questionMode, "teacher", "sibling keys ride untouched");
	});

	it("the flow block loads from its file and carries the run doctrine", () => {
		const block = flowBlockText();
		assert.ok(block.length > 200, "a real doctrine, not an empty fallback");
		assert.match(block, /Flow rhythm/);
		assert.match(block, /Three to six steps per turn/);
		assert.match(block, /One check per turn, covering the run/);
		// the repair law survives the pace change
		assert.match(block, /repairs before advancing/);
	});
});
