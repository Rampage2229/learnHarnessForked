/**
 * Goals v1 (personal fork): the whole vertical, hermetic under an
 * isolated LH_DATA_DIR (the topics.test.ts discipline — the seam is set
 * BEFORE any config-loading import, every app-module import is dynamic):
 *
 *   - the store (src/store/goals.ts): CRUD, the SINGLE-ACTIVE INVARIANT
 *     (a second create and a re-activation each archive the previous
 *     active), the validation gates, delete, the readGoals sort
 *     (active first, then createdAt desc), hostile-file safety, the
 *     goals-changed announcements;
 *   - the routes (app/api/goals, app/api/goals/[id]) driven directly
 *     with Request objects (the topics.test.ts precedent).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-goals-"));
process.env.LH_DATA_DIR = TMP;

const {
	goalStore,
	readGoals,
	activeGoal,
	createGoal,
	updateGoal,
	deleteGoal,
	GOALS_FILE,
	MIN_GOAL_TITLE,
	MAX_GOAL_TITLE,
	MAX_GOAL_DETAIL,
} = await import("../src/store/goals.ts");
const goalsRoute = await import("../app/api/goals/route.ts");
const goalItemRoute = await import("../app/api/goals/[id]/route.ts");
const { subscribe } = await import("../src/core/events.ts");
import type { Goal } from "../src/store/goals.ts";

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
	for (const g of readGoals()) deleteGoal(g.id);
}

/** One well-formed goal record, written straight into the fixture file
 *  (the topics.test.ts precedent for hand-shaped store files). */
function fixtureGoal(id: string, createdAt: string, status: Goal["status"]): Goal {
	return { id, title: `T ${id}`, createdAt, status };
}

describe("the store file seam", () => {
	it("GOALS_FILE resolves inside LH_DATA_DIR; missing file reads [] and no active", () => {
		assert.equal(GOALS_FILE, path.join(TMP, "goals.json"));
		clearAll();
		assert.deepEqual(readGoals(), []);
		assert.equal(activeGoal(), null);
	});
});

describe("store CRUD + the single-active invariant", () => {
	it("create → read → re-activation → delete", () => {
		clearAll();
		const a = createGoal("  Learn TCP  ", "three-way handshake");
		assert.match(a.id, /^goal_[0-9a-z]+_[0-9a-f]{8}$/);
		assert.equal(a.title, "Learn TCP", "trimmed");
		assert.equal(a.detail, "three-way handshake");
		assert.equal(a.status, "active");
		assert.ok(!Number.isNaN(Date.parse(a.createdAt)), "ISO createdAt");
		assert.equal(activeGoal()?.id, a.id);
		assert.deepEqual(readGoals(), [a]);

		const renamed = updateGoal(a.id, { title: "  Master TCP  ", detail: "congestion control" });
		assert.equal(renamed?.title, "Master TCP");
		assert.equal(renamed?.detail, "congestion control");
		assert.equal(renamed?.createdAt, a.createdAt, "createdAt stays put");
		assert.deepEqual(readGoals(), [renamed]);

		assert.ok(deleteGoal(a.id), "delete of a known id");
		assert.deepEqual(readGoals(), []);
		assert.ok(!deleteGoal(a.id), "unknown id → false (the route's 404)");
	});

	it("a detail-less create leaves the field ABSENT (absence reads as none)", () => {
		clearAll();
		const bare = createGoal("No notes yet");
		assert.ok(!("detail" in bare));
		const emptied = updateGoal(bare.id, { detail: "" });
		assert.equal(emptied?.detail, "", "the patch shape's only way to clear");
	});

	it("the invariant: a second create silently archives the first", () => {
		clearAll();
		const a = createGoal("Alpha");
		const b = createGoal("Beta");
		assert.equal(b.status, "active");
		assert.equal(activeGoal()?.id, b.id);
		assert.equal(readGoals().find((g) => g.id === a.id)?.status, "archived", "demoted in the read view");
		const onDisk = JSON.parse(fs.readFileSync(GOALS_FILE, "utf-8")) as { version: number; goals: Goal[] };
		assert.equal(onDisk.version, 1);
		assert.equal(onDisk.goals.find((g) => g.id === a.id)?.status, "archived", "durable on disk too");
	});

	it("the invariant: re-activating one goal archives the other active", () => {
		clearAll();
		const a = createGoal("Alpha");
		createGoal("Beta"); // active; a archived
		const back = updateGoal(a.id, { status: "active" });
		assert.equal(back?.status, "active");
		assert.equal(activeGoal()?.id, a.id, "the slot moved");
		assert.equal(readGoals().find((g) => g.title === "Beta")?.status, "archived", "the other active demoted");
	});

	it("status transitions: done/archived leave NO active behind", () => {
		clearAll();
		const a = createGoal("Alpha");
		assert.equal(updateGoal(a.id, { status: "done" })?.status, "done");
		assert.equal(activeGoal(), null);
		const b = createGoal("Beta");
		assert.equal(updateGoal(b.id, { status: "archived" })?.status, "archived");
		assert.equal(activeGoal(), null);
	});

	it("update: unknown id → null (even with a patch); validation throws on known ids", () => {
		clearAll();
		const a = createGoal("Alpha");
		assert.equal(updateGoal("goal_00000000_00000000", { title: "Whatever" }), null);
		assert.throws(() => updateGoal(a.id, { title: "no" }), /at least 3/);
		assert.throws(() => updateGoal(a.id, { title: "x".repeat(MAX_GOAL_TITLE + 1) }), /limited to 200/);
		assert.throws(() => updateGoal(a.id, { detail: "x".repeat(MAX_GOAL_DETAIL + 1) }), /limited to 2000/);
	});

	it("the validation gates: title 3-200 after trim, detail up to 2000; ceilings pass", () => {
		clearAll();
		assert.throws(() => createGoal("ab"), /at least 3/);
		assert.throws(() => createGoal("   "), /at least 3/, "whitespace-only trims below the floor");
		assert.throws(() => createGoal("x".repeat(MAX_GOAL_TITLE + 1)), /limited to 200/);
		assert.throws(() => createGoal("ok title", "d".repeat(MAX_GOAL_DETAIL + 1)), /limited to 2000/);
		// exactly at the boundaries passes (the gates are inclusive)
		const atFloor = createGoal("abc");
		assert.equal(atFloor.title, "abc");
		const atCeiling = createGoal("y".repeat(MAX_GOAL_TITLE), "z".repeat(MAX_GOAL_DETAIL));
		assert.equal(atCeiling.title.length, MAX_GOAL_TITLE);
		assert.equal(atCeiling.detail!.length, MAX_GOAL_DETAIL);
	});

	it("readGoals sorts ACTIVE FIRST then createdAt desc", () => {
		clearAll();
		const base = Date.parse("2026-01-01T00:00:00.000Z");
		fs.writeFileSync(
			GOALS_FILE,
			`${JSON.stringify({
				version: 1,
				goals: [
					fixtureGoal("goal_newest", new Date(base).toISOString(), "archived"),
					fixtureGoal("goal_older_active", new Date(base - 3 * 86_400_000).toISOString(), "active"),
					fixtureGoal("goal_middle", new Date(base - 86_400_000).toISOString(), "done"),
					fixtureGoal("goal_oldest", new Date(base - 2 * 86_400_000).toISOString(), "archived"),
				],
			}, null, "\t")}\n`,
			"utf-8",
		);
		assert.deepEqual(readGoals().map((g) => g.id), [
			"goal_older_active", // active wins regardless of age
			"goal_newest", // then newest-first
			"goal_middle",
			"goal_oldest",
		]);
		// the object mirror agrees with the bare function
		assert.deepEqual(goalStore.readGoals().map((g) => g.id), readGoals().map((g) => g.id));
	});

	it("sanitize safety — a hostile file never throws, never lies", () => {
		clearAll();
		fs.writeFileSync(GOALS_FILE, "{not json", "utf-8");
		assert.deepEqual(readGoals(), []);

		fs.writeFileSync(GOALS_FILE, JSON.stringify([1, 2, 3]), "utf-8");
		assert.deepEqual(readGoals(), [], "a top-level array is not a goals file");

		fs.writeFileSync(
			GOALS_FILE,
			JSON.stringify({
				version: 99,
				goals: [fixtureGoal("goal_from_the_future", "2026-01-01T00:00:00.000Z", "active")],
			}),
			"utf-8",
		);
		assert.deepEqual(readGoals(), [], "a NEWER format stamp is refused (the chats.ts precedent)");

		fs.writeFileSync(
			GOALS_FILE,
			JSON.stringify({
				version: 1,
				goals: [
					fixtureGoal("goal_keep", "2026-01-01T00:00:00.000Z", "active"),
					fixtureGoal("goal_badstatus", "2026-01-01T00:00:00.000Z", "pending" as never),
					{ id: 7, title: "no" },
					{ title: "no id" },
					"junk string",
					42,
				],
			}),
			"utf-8",
		);
		const kept = readGoals();
		assert.equal(kept.length, 1, "malformed goals are filtered, the rest survives");
		assert.equal(kept[0]!.id, "goal_keep");

		// the store still writes sanely after a hostile read — and the
		// invariant holds against the surviving file: the new create
		// archives the filtered-in active.
		const fresh = createGoal("Recovers");
		assert.equal(activeGoal()?.id, fresh.id);
		assert.equal(readGoals().find((g) => g.id === "goal_keep")?.status, "archived");
	});

	it("every mutation announces goals-changed on the event bus", () => {
		clearAll();
		let announces = 0;
		const off = subscribe((e) => {
			if (e.type === "goals-changed") announces++;
		});
		const g = createGoal("Announced");
		assert.equal(announces, 1);
		updateGoal(g.id, { title: "Renamed" });
		assert.equal(announces, 2);
		assert.ok(deleteGoal(g.id));
		assert.equal(announces, 3, "a real removal announces");
		assert.ok(!deleteGoal(g.id));
		assert.equal(announces, 3, "an unknown-id delete wrote nothing — nothing announced");
		off();
	});
});

describe("route handlers (app/api/goals)", () => {
	it("GET lists; POST 201s the new active; bad bodies are 400s", async () => {
		clearAll();
		const created = await goalsRoute.POST(
			jsonRequest("POST", "http://localhost/api/goals", { title: "  Learn TCP  ", detail: "handshake" }),
		);
		assert.equal(created.status, 201);
		const { goal } = (await created.json()) as { goal: Goal };
		assert.equal(goal.title, "Learn TCP", "trimmed");
		assert.equal(goal.status, "active");
		assert.match(goal.id, /^goal_[0-9a-z]+_[0-9a-f]{8}$/);
		assert.equal(activeGoal()?.id, goal.id);

		const second = await goalsRoute.POST(jsonRequest("POST", "http://localhost/api/goals", { title: "Learn TLS" }));
		assert.equal(second.status, 201);
		const { goal: goal2 } = (await second.json()) as { goal: Goal };
		assert.equal(readGoals().find((g) => g.id === goal.id)?.status, "archived", "the invariant rode the route");

		const get = await goalsRoute.GET();
		assert.equal(get.status, 200);
		const list = (await get.json()) as { goals: Goal[] };
		assert.deepEqual(list.goals.map((g) => g.id), [goal2.id, goal.id], "active first, then createdAt desc");

		const tooShort = await goalsRoute.POST(jsonRequest("POST", "http://localhost/api/goals", { title: "ab" }));
		assert.equal(tooShort.status, 400);
		const tooLong = await goalsRoute.POST(
			jsonRequest("POST", "http://localhost/api/goals", { title: "x".repeat(MAX_GOAL_TITLE + 1) }),
		);
		assert.equal(tooLong.status, 400);
		const notAString = await goalsRoute.POST(jsonRequest("POST", "http://localhost/api/goals", { title: 5 }));
		assert.equal(notAString.status, 400);
		const missing = await goalsRoute.POST(jsonRequest("POST", "http://localhost/api/goals", {}));
		assert.equal(missing.status, 400);
		const badDetailType = await goalsRoute.POST(
			jsonRequest("POST", "http://localhost/api/goals", { title: "ok title", detail: 7 }),
		);
		assert.equal(badDetailType.status, 400);
		const oversizedDetail = await goalsRoute.POST(
			jsonRequest("POST", "http://localhost/api/goals", { title: "ok title", detail: "d".repeat(MAX_GOAL_DETAIL + 1) }),
		);
		assert.equal(oversizedDetail.status, 400);
		const arrayBody = await goalsRoute.POST(jsonRequest("POST", "http://localhost/api/goals", ["no"]));
		assert.equal(arrayBody.status, 400);
		const badJson = await goalsRoute.POST(
			new Request("http://localhost/api/goals", { method: "POST", body: "{", headers: { "content-type": "application/json" } }),
		);
		assert.equal(badJson.status, 400);
		const message = ((await tooShort.json()) as { error: string }).error;
		assert.match(message, new RegExp(String(MIN_GOAL_TITLE)), "a clear validation error");
		assert.equal(readGoals().length, 2, "rejections wrote nothing");
	});

	it("PUT edits and re-statuses; re-activation hands over the slot; 404 unknown; 400 malformed", async () => {
		clearAll();
		const { goal: alpha } = (await (await goalsRoute.POST(jsonRequest("POST", "http://localhost/api/goals", { title: "Alpha" }))).json()) as { goal: Goal };
		const { goal: beta } = (await (await goalsRoute.POST(jsonRequest("POST", "http://localhost/api/goals", { title: "Beta" }))).json()) as { goal: Goal };
		assert.equal(alpha.status, "active"); // the route's 201 body
		assert.equal(readGoals().find((g) => g.id === alpha.id)?.status, "archived", "beta's creation archived alpha");

		const reactivate = await goalItemRoute.PUT(
			jsonRequest("PUT", `http://localhost/api/goals/${alpha.id}`, { status: "active" }),
			{ params: Promise.resolve({ id: alpha.id }) },
		);
		assert.equal(reactivate.status, 200);
		const { goal: revived } = (await reactivate.json()) as { goal: Goal };
		assert.equal(revived.status, "active");
		assert.equal(activeGoal()?.id, alpha.id, "the slot moved");
		assert.equal(readGoals().find((g) => g.id === beta.id)?.status, "archived", "the other active demoted");

		const edit = await goalItemRoute.PUT(
			jsonRequest("PUT", `http://localhost/api/goals/${alpha.id}`, { title: "  Alpha 2  ", detail: "refined" }),
			{ params: Promise.resolve({ id: alpha.id }) },
		);
		assert.equal(edit.status, 200);
		const edited = (await edit.json()) as { goal: Goal };
		assert.equal(edited.goal.title, "Alpha 2", "trimmed");
		assert.equal(edited.goal.detail, "refined");

		const finish = await goalItemRoute.PUT(
			jsonRequest("PUT", `http://localhost/api/goals/${alpha.id}`, { status: "done" }),
			{ params: Promise.resolve({ id: alpha.id }) },
		);
		assert.equal(((await finish.json()) as { goal: Goal }).goal.status, "done");
		assert.equal(activeGoal(), null, "no active left when the active one is done");

		const unknown = await goalItemRoute.PUT(
			jsonRequest("PUT", "http://localhost/api/goals/goal_00000000_00000000", { title: "Ghost" }),
			{ params: Promise.resolve({ id: "goal_00000000_00000000" }) },
		);
		assert.equal(unknown.status, 404);
		const badStatus = await goalItemRoute.PUT(
			jsonRequest("PUT", `http://localhost/api/goals/${alpha.id}`, { status: "pending" }),
			{ params: Promise.resolve({ id: alpha.id }) },
		);
		assert.equal(badStatus.status, 400);
		const badTitle = await goalItemRoute.PUT(
			jsonRequest("PUT", `http://localhost/api/goals/${alpha.id}`, { title: "ab" }),
			{ params: Promise.resolve({ id: alpha.id }) },
		);
		assert.equal(badTitle.status, 400);
		const badTitleType = await goalItemRoute.PUT(
			jsonRequest("PUT", `http://localhost/api/goals/${alpha.id}`, { title: 9 }),
			{ params: Promise.resolve({ id: alpha.id }) },
		);
		assert.equal(badTitleType.status, 400);
		const badDetail = await goalItemRoute.PUT(
			jsonRequest("PUT", `http://localhost/api/goals/${alpha.id}`, { detail: "x".repeat(MAX_GOAL_DETAIL + 1) }),
			{ params: Promise.resolve({ id: alpha.id }) },
		);
		assert.equal(badDetail.status, 400);
		const badJson = await goalItemRoute.PUT(
			new Request(`http://localhost/api/goals/${alpha.id}`, { method: "PUT", body: "{", headers: { "content-type": "application/json" } }),
			{ params: Promise.resolve({ id: alpha.id }) },
		);
		assert.equal(badJson.status, 400);
		assert.equal(readGoals().find((g) => g.id === alpha.id)?.status, "done", "rejections wrote nothing");
	});

	it("DELETE removes; 404 unknown", async () => {
		clearAll();
		const g = createGoal("Doomed");
		const del = await goalItemRoute.DELETE(
			new Request(`http://localhost/api/goals/${g.id}`, { method: "DELETE" }),
			{ params: Promise.resolve({ id: g.id }) },
		);
		assert.equal(del.status, 200);
		assert.deepEqual(await del.json(), { ok: true });
		assert.deepEqual(readGoals(), []);

		const missing = await goalItemRoute.DELETE(
			new Request(`http://localhost/api/goals/${g.id}`, { method: "DELETE" }),
			{ params: Promise.resolve({ id: g.id }) },
		);
		assert.equal(missing.status, 404);
	});
});
