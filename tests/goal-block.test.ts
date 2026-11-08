/**
 * The learner's GOAL block (goals v1, agent half): the pure prompt-block
 * renderer and the store-free disk reader (src/server/goal-block.ts reads
 * the goals record straight off disk — src/store/goals.ts is built in
 * parallel and MUST be allowed to be absent; that absence is itself a
 * pinned behavior here). Hermetic: LH_DATA_DIR is pointed at a tmp dir
 * BEFORE the config-anchored modules load (the reviews.test.ts pattern).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-goal-block-"));
process.env.LH_DATA_DIR = TMP;

const { renderGoalBlock, activeGoalFromDisk } = await import("../src/server/goal-block.ts");

after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

// The reader's path is PATHS.data + "goals.json", and PATHS.data resolved
// to TMP at config-import time — the test seeds exactly that file.
const GOALS_FILE = path.join(TMP, "goals.json");

const SERVING_LAW =
	"Every plan and every step serves reaching it: prefer the minimum structure that gets them there, and say plainly when a step is off-goal. Progress is measured against this goal.";

describe("renderGoalBlock", () => {
	it("null → null (no goal: byte-identical pre-goal prompt)", () => {
		assert.equal(renderGoalBlock(null), null);
	});

	it("title only — the dash frame closes after the title", () => {
		assert.equal(
			renderGoalBlock({ title: "Understand linear algebra" }),
			`THE LEARNER'S GOAL — Understand linear algebra. ${SERVING_LAW}`,
		);
	});

	it("title + detail — the detail rides inside the dash frame", () => {
		assert.equal(
			renderGoalBlock({ title: "Pass the bar", detail: "July sitting, essays first" }),
			`THE LEARNER'S GOAL — Pass the bar — July sitting, essays first. ${SERVING_LAW}`,
		);
	});

	it("long detail passes through untruncated", () => {
		const detail = "x".repeat(5000); // whitespace-free: trim must be a no-op on it
		const block = renderGoalBlock({ title: "T", detail })!;
		assert.ok(block.startsWith("THE LEARNER'S GOAL — T — "));
		assert.ok(block.endsWith(`. ${SERVING_LAW}`));
		assert.ok(block.includes(detail), "the full detail reaches the model");
	});

	it("blank/whitespace title is not a goal", () => {
		assert.equal(renderGoalBlock({ title: "   " }), null);
	});

	it("absent or blank detail composes as title-only", () => {
		const expected = `THE LEARNER'S GOAL — T. ${SERVING_LAW}`;
		assert.equal(renderGoalBlock({ title: "T" }), expected);
		assert.equal(renderGoalBlock({ title: "T", detail: "  " }), expected);
	});
});

describe("activeGoalFromDisk", () => {
	it("missing goals.json → null (the store has not landed — the build holds)", () => {
		assert.equal(activeGoalFromDisk(), null);
	});

	it("corrupt JSON → null, never a throw", () => {
		fs.writeFileSync(GOALS_FILE, "{ not json at all");
		assert.equal(activeGoalFromDisk(), null);
	});

	it("picks the NEWEST active goal; done/archived never win", () => {
		fs.writeFileSync(
			GOALS_FILE,
			JSON.stringify({
				version: 1,
				goals: [
					{ id: "g1", title: "Old active", createdAt: "2026-01-01T00:00:00.000Z", status: "active" },
					{ id: "g2", title: "Done but newer", createdAt: "2026-02-01T00:00:00.000Z", status: "done" },
					{
						id: "g3",
						title: "Newest active",
						detail: "the real one",
						createdAt: "2026-03-01T00:00:00.000Z",
						status: "active",
					},
					{ id: "g4", title: "Archived newest of all", createdAt: "2026-04-01T00:00:00.000Z", status: "archived" },
				],
			}),
		);
		assert.deepEqual(activeGoalFromDisk(), { title: "Newest active", detail: "the real one" });
	});

	it("several ACTIVE goals → newest createdAt wins", () => {
		fs.writeFileSync(
			GOALS_FILE,
			JSON.stringify({
				version: 1,
				goals: [
					{ id: "a", title: "First", createdAt: "2026-01-01T00:00:00.000Z", status: "active" },
					{ id: "b", title: "Second", createdAt: "2026-06-01T00:00:00.000Z", status: "active" },
				],
			}),
		);
		assert.deepEqual(activeGoalFromDisk(), { title: "Second" });
	});

	it("no active goal (all done/archived) → null", () => {
		fs.writeFileSync(
			GOALS_FILE,
			JSON.stringify({
				version: 1,
				goals: [{ id: "g", title: "Finished", createdAt: "2026-01-01T00:00:00.000Z", status: "done" }],
			}),
		);
		assert.equal(activeGoalFromDisk(), null);
	});

	it("the store-convention blob is not the only shape read — a bare array works too", () => {
		fs.writeFileSync(
			GOALS_FILE,
			JSON.stringify([{ id: "g", title: "Solo", createdAt: "2026-01-01T00:00:00.000Z", status: "active" }]),
		);
		assert.deepEqual(activeGoalFromDisk(), { title: "Solo" });
	});

	it("malformed entries are filtered, never fatal for the file", () => {
		fs.writeFileSync(
			GOALS_FILE,
			JSON.stringify({
				version: 1,
				goals: [
					{ title: "no id", createdAt: "2026-01-01T00:00:00.000Z", status: "active" },
					{ id: "g", title: 7, createdAt: "2026-01-01T00:00:00.000Z", status: "active" },
					{ id: "g", title: "bad status", createdAt: "2026-01-01T00:00:00.000Z", status: "paused" },
					{ id: "g", title: "Good", createdAt: "2026-01-01T00:00:00.000Z", status: "active" },
				],
			}),
		);
		assert.deepEqual(activeGoalFromDisk(), { title: "Good" });
	});

	it("an empty detail key composes as title-only (no dangling dash)", () => {
		fs.writeFileSync(
			GOALS_FILE,
			JSON.stringify({
				version: 1,
				goals: [{ id: "g", title: "T", detail: "", createdAt: "2026-01-01T00:00:00.000Z", status: "active" }],
			}),
		);
		assert.deepEqual(activeGoalFromDisk(), { title: "T" });
	});
});
