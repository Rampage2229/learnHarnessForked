/**
 * THE LEARNER'S GOAL PROMPT BLOCK (goals v1, agent half, personal fork) —
 * the server seam between the goals record and the teaching agents, on the
 * memory.ts pattern: src/agent must never import src/store (the import
 * law), so the chat-handler renders the block HERE fresh per turn and
 * threads it into AgentBuildOptions.goalBlock, where baseAgentOptions
 * appends it after the flow rhythm and before the learner's memory
 * (base → flow → goal → memory → topic).
 *
 * DELIBERATELY STORE-FREE (the parallel-build contract): src/store/goals.ts
 * is being built separately and may not exist when this module loads — the
 * reader therefore reads the goals record STRAIGHT OFF DISK
 * (path.join(PATHS.data, "goals.json"), the file the store serializes) with
 * a try/catch that returns null on ANY failure: absent file, corrupt JSON,
 * wrong shape, no active goal. A missing or broken backend can never break
 * the build or the turn; when the store lands, it writes the same file and
 * this reader keeps working unchanged. Both serializations of the record
 * family are accepted — the store-convention blob ({version, goals}) and a
 * bare array — so the reader does not pin a format it does not own.
 *
 * No cache (the memory.ts stamp pattern is skipped): the file is tiny, the
 * read is per turn by contract, and a goal the learner just set must land
 * on the very next turn without stamp bookkeeping.
 */

import * as fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";

/** The goals record — the file src/store/goals.ts owns (its exact blob
 *  shape is that module's contract; this reader only needs the goals
 *  array out of it). */
const GOALS_FILE = path.join(PATHS.data, "goals.json");

/** The narrow view the prompt block renders from — the pieces of the
 *  Goal contract (id, title, detail?, createdAt, status) that reach the
 *  model. */
export interface ActiveGoal {
	title: string;
	detail?: string;
}

/** The record shape this reader trusts: every contracted field present
 *  with its contracted type (detail optional). Junk entries are filtered,
 *  never fatal for the file (the topics.ts discipline). */
function isGoalRecord(g: unknown): g is {
	id: string;
	title: string;
	detail?: string;
	createdAt: string;
	status: "active" | "done" | "archived";
} {
	if (!g || typeof g !== "object" || Array.isArray(g)) return false;
	const o = g as Record<string, unknown>;
	return (
		typeof o.id === "string" &&
		typeof o.title === "string" &&
		typeof o.createdAt === "string" &&
		(o.status === "active" || o.status === "done" || o.status === "archived") &&
		(o.detail === undefined || typeof o.detail === "string")
	);
}

/** The learner's ONE active goal, read fresh off disk — newest createdAt
 *  when several are active (localeCompare on ISO stamps, the memory.ts
 *  ordering discipline); null on absent/corrupt/wrong-shape file or when
 *  nothing is active. Never throws. */
export function activeGoalFromDisk(): ActiveGoal | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(GOALS_FILE, "utf-8"));
	} catch {
		return null; // absent or corrupt — the documented state is "no goal"
	}
	const raw = Array.isArray(parsed)
		? parsed
		: parsed && typeof parsed === "object" && Array.isArray((parsed as { goals?: unknown }).goals)
			? (parsed as { goals: unknown[] }).goals
			: null;
	if (!raw) return null;
	const newest = raw
		.filter(isGoalRecord)
		.filter((g) => g.status === "active")
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
	if (!newest) return null;
	return newest.detail !== undefined && newest.detail !== ""
		? { title: newest.title, detail: newest.detail }
		: { title: newest.title };
}

/** The model-facing block text — the app's dry, imperative doctrine voice
 *  (the memory header and topic-assignment lines are the register):
 *  the goal named, the serving law, the honesty law, the measure. The
 *  detail rides inside the dash frame so the sentence composes with or
 *  without it. null = no goal: the prompt stays byte-identical to the
 *  pre-goal composition. */
export function renderGoalBlock(goal: ActiveGoal | null): string | null {
	if (!goal || typeof goal.title !== "string") return null;
	const title = goal.title.trim();
	if (!title) return null;
	const detail = typeof goal.detail === "string" ? goal.detail.trim() : "";
	const head = detail ? `THE LEARNER'S GOAL — ${title} — ${detail}.` : `THE LEARNER'S GOAL — ${title}.`;
	return `${head} Every plan and every step serves reaching it: prefer the minimum structure that gets them there, and say plainly when a step is off-goal. Progress is measured against this goal.`;
}
