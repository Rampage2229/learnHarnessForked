/**
 * The GoalStore adapter (goals v1, personal fork): the learner's goal
 * layer — one JSON blob at data/goals.json (derived from PATHS.data, the
 * same LH_DATA_DIR seam every mutable record rides), one versioned file
 * like memory.json/topics.json. Atomic writes (tmp+rename, the auth.ts
 * discipline), NEVER throws on read (absent/corrupt file = [] = "no goals
 * yet", the settings doctrine).
 *
 * THE SINGLE-ACTIVE INVARIANT: at most ONE goal has status "active" —
 * the goal the learner is currently working toward. Creating a new goal
 * or re-activating one ARCHIVES the previously active goal (status
 * "archived"), silently: the slot moves, history is never rewritten into
 * "done" (only the learner marks done, via updateGoal).
 *
 * Curated by the goal surface (app/api/goals); every mutation announces
 * "goals-changed" on the core event bus (the chats.ts discipline — notify
 * → fetch, open windows refetch truth).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";

/** A learner goal's lifecycle: the one slot under work ("active"), the
 *  learner's own completion mark ("done"), and the silent demotion
 *  ("archived") the single-active invariant applies. */
export type GoalStatus = "active" | "done" | "archived";

export interface Goal {
	id: string;
	title: string;
	/** Optional elaboration — absence reads as "no notes yet". */
	detail?: string;
	createdAt: string;
	status: GoalStatus;
}

/** The patch shape of updateGoal — every field optional, absent = leave
 *  as-is. There is no way to clear a detail (set it to ""). */
export interface GoalPatch {
	title?: string;
	detail?: string;
	status?: GoalStatus;
}

/** The goals file this build writes and understands. */
const GOALS_VERSION = 1;

/** The goals file path — derived from the LH_DATA_DIR seam (PATHS.data),
 *  the same relocation contract as topics.json/settings.json. */
export const GOALS_FILE = path.join(PATHS.data, "goals.json");

/** The title gate (post-trim) — 3 to 200 characters. Violations throw
 *  (the route surfaces the message as a 400). */
export const MIN_GOAL_TITLE = 3;
export const MAX_GOAL_TITLE = 200;
/** The detail cap — oversized text is rejected, not truncated (the
 *  memory.ts discipline: a silent clip would corrupt the learner's own
 *  note). */
export const MAX_GOAL_DETAIL = 2000;

function writeGoalsFile(goals: Goal[]): void {
	const dir = path.dirname(GOALS_FILE);
	fs.mkdirSync(dir, { recursive: true });
	// Atomic swap (the auth.ts discipline): tmp-in-same-dir + rename — a
	// partial write can never leave a truncated JSON (which would read as
	// "no goals yet" and silently drop the learner's goals).
	const tmp = path.join(dir, `.goals.json.tmp-${process.pid}`);
	fs.writeFileSync(tmp, `${JSON.stringify({ version: GOALS_VERSION, goals }, null, "\t")}\n`, "utf-8");
	fs.renameSync(tmp, GOALS_FILE);
}

/** The sanitized read: absent/corrupt/wrong-shape → []; a version stamped
 *  NEWER than this build is refused honestly (the chats.ts precedent — a
 *  read-modify-write store must never rewrite what it doesn't understand);
 *  malformed goals are filtered, never fatal for the whole file. */
function readGoalsFile(): Goal[] {
	try {
		const parsed = JSON.parse(fs.readFileSync(GOALS_FILE, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
		const version = (parsed as { version?: unknown }).version;
		if (typeof version === "number" && version > GOALS_VERSION) {
			console.error(
				`[goals] file stamped with format version ${version} > ${GOALS_VERSION} — this app build is older; refusing to read it`,
			);
			return [];
		}
		const raw = (parsed as { goals?: unknown }).goals;
		if (!Array.isArray(raw)) return [];
		return raw.filter(
			(g): g is Goal =>
				!!g && typeof g === "object" &&
				typeof (g as Goal).id === "string" &&
				typeof (g as Goal).title === "string" &&
				typeof (g as Goal).createdAt === "string" &&
				((g as Goal).status === "active" || (g as Goal).status === "done" || (g as Goal).status === "archived") &&
				((g as Goal).detail === undefined || typeof (g as Goal).detail === "string"),
		);
	} catch {
		return []; // absent or corrupt — the documented state is "no goals yet"
	}
}

function assertValidTitle(title: string): string {
	const trimmed = title.trim();
	if (trimmed.length < MIN_GOAL_TITLE) throw new Error(`Goal title must be at least ${MIN_GOAL_TITLE} characters`);
	if (trimmed.length > MAX_GOAL_TITLE) throw new Error(`Goal title is limited to ${MAX_GOAL_TITLE} characters`);
	return trimmed;
}

function assertValidDetail(detail: string): string {
	if (detail.length > MAX_GOAL_DETAIL) throw new Error(`Goal detail is limited to ${MAX_GOAL_DETAIL} characters`);
	return detail;
}

/** Every goal, ACTIVE FIRST then newest-first (createdAt desc) — the
 *  reading order the goal surface presents. The disk keeps creation
 *  order; the sort is a view. */
export function readGoals(): Goal[] {
	return [...readGoalsFile()].sort((a, b) => {
		const activeDiff = Number(b.status === "active") - Number(a.status === "active");
		if (activeDiff !== 0) return activeDiff;
		return b.createdAt.localeCompare(a.createdAt);
	});
}

/** The goal currently under work — the single "active" slot. null when
 *  the learner has none (the honest empty state, not an error). */
export function activeGoal(): Goal | null {
	return readGoalsFile().find((g) => g.status === "active") ?? null;
}

/** Create the new ACTIVE goal — the previous active (if any) is silently
 *  archived in the same write (the single-active invariant). */
export function createGoal(title: string, detail?: string): Goal {
	const cleanTitle = assertValidTitle(title);
	const cleanDetail = detail === undefined ? undefined : assertValidDetail(detail);
	const goals = readGoalsFile();
	const demoted = goals.map((g): Goal => (g.status === "active" ? { ...g, status: "archived" } : g));
	const goal: Goal = {
		id: `goal_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`,
		title: cleanTitle,
		...(cleanDetail !== undefined ? { detail: cleanDetail } : {}),
		createdAt: new Date().toISOString(),
		status: "active",
	};
	writeGoalsFile([...demoted, goal]);
	emit("goals-changed", {});
	return goal;
}

/** Edit and/or re-status one goal. Activation (including a no-op
 *  re-activation of the already-active goal) hands the single active
 *  slot over: every OTHER active goal is silently archived in the same
 *  write. Unknown id → null (the route's 404); invalid title/detail
 *  throws (the route's 400). */
export function updateGoal(id: string, patch: GoalPatch): Goal | null {
	const goals = readGoalsFile();
	const target = goals.find((g) => g.id === id);
	if (!target) return null;
	let updated: Goal = { ...target };
	if (patch.title !== undefined) updated = { ...updated, title: assertValidTitle(patch.title) };
	if (patch.detail !== undefined) updated = { ...updated, detail: assertValidDetail(patch.detail) };
	if (patch.status !== undefined) updated = { ...updated, status: patch.status };
	const activating = updated.status === "active";
	writeGoalsFile(
		goals.map((g): Goal => {
			if (g.id === id) return updated;
			return activating && g.status === "active" ? { ...g, status: "archived" } : g;
		}),
	);
	emit("goals-changed", {});
	return updated;
}

/** Remove the goal record outright — goals are not referenced anywhere
 *  else (no graph membership, no chat stamps), so there is nothing to
 *  cascade. False when the id is unknown — the route's 404. */
export function deleteGoal(id: string): boolean {
	const goals = readGoalsFile();
	if (!goals.some((g) => g.id === id)) return false;
	writeGoalsFile(goals.filter((g) => g.id !== id));
	emit("goals-changed", {});
	return true;
}

/** The store object — the topics.ts/memory.ts mirror for consumers that
 *  prefer one import (the functions above are the same surface). */
export const goalStore = {
	readGoals,
	activeGoal,
	createGoal,
	updateGoal,
	deleteGoal,
};
