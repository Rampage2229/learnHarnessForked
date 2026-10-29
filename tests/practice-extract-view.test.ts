/**
 * Practice-mode extraction view (personal fork, stage 3) — the validated-only
 * doctrine's projection. A practice session proves what the learner
 * DEMONSTRATED: the view carries problem statement + committed model
 * solution + the conclude verdict, labeled with the message id (the same
 * anchor law as the teacher-prose view). The extractor's instructions then
 * enforce validated-only (solved/solvedWithHints only).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const core = await import("../src/core/practice-extract-view.ts");
const { practiceViewLines, practiceView } = core;

function msg(m: Record<string, unknown>) {
	return m as never;
}

const failed = new Set<string>();

describe("practiceViewLines", () => {
	it("renders problem + solution + conclude for clean calls", () => {
		const m = msg({
			role: "assistant",
			id: "m1",
			content: [
				{ type: "toolCall", id: "p1", name: "problem", arguments: { statement: "Solve x", target: ["n1"], modelSolution: "x = 2" } },
				{ type: "toolCall", id: "c1", name: "conclude", arguments: { outcome: "solved", verdict: "clean", rung: null } },
			],
		});
		const lines = practiceViewLines(m, "m1", failed);
		assert.deepEqual(lines, [
			"PROBLEM [m1] Solve x (targets: n1)",
			"SOLUTION [m1] x = 2",
			"CONCLUDE [m1] outcome=solved — clean",
		]);
	});

	it("skips failed calls and non-practice tool calls", () => {
		const m = msg({
			role: "assistant",
			id: "m2",
			content: [
				{ type: "toolCall", id: "p1", name: "problem", arguments: { statement: "x" } },
				{ type: "toolCall", id: "quiz1", name: "quiz", arguments: { nodeId: "n1" } },
			],
		});
		const lines = practiceViewLines(m, "m2", new Set(["p1"]));
		assert.deepEqual(lines, []);
	});

	it("practiceView joins lines with blank lines and a title head", () => {
		const messages = [
			msg({ role: "assistant", id: "m1", content: [{ type: "toolCall", id: "p1", name: "problem", arguments: { statement: "A", modelSolution: "B" } }] }),
			msg({ role: "assistant", id: "m2", content: [{ type: "toolCall", id: "c1", name: "conclude", arguments: { outcome: "solved" } }] }),
		];
		const view = practiceView(messages, "Linear Algebra");
		assert.ok(view.startsWith("# Linear Algebra\n\n"));
		assert.ok(view.includes("PROBLEM [m1] A"));
		assert.ok(view.includes("CONCLUDE [m2] outcome=solved"));
	});
});