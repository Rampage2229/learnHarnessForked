/**
 * The per-goal route (goals v1, personal fork).
 *
 * PUT /api/goals/:id {title?, detail?, status?} — edit and/or re-status
 * the goal; the updated goal is the body. Re-activation ("active") hands
 * the single active slot over: the previous active is silently archived
 * (the store's invariant). Unknown id → 404; malformed fields → 400
 * (status must be one of active/done/archived, title 3-200 after trim,
 * detail up to 2000).
 *
 * DELETE — removes the goal record outright (goals are referenced
 * nowhere else — nothing to cascade). 200 {ok: true} when removed, 404
 * when the id is unknown.
 */
import {
	deleteGoal,
	MAX_GOAL_DETAIL,
	MAX_GOAL_TITLE,
	MIN_GOAL_TITLE,
	updateGoal,
	type GoalStatus,
} from "@/src/server";

export const dynamic = "force-dynamic";

const GOAL_STATUSES: readonly GoalStatus[] = ["active", "done", "archived"];

type Params = { params: Promise<{ id: string }> };

export async function PUT(req: Request, { params }: Params) {
	const { id } = await params;
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "body must be JSON" }, { status: 400 });
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return Response.json({ error: "body must be an object" }, { status: 400 });
	}
	const { title, detail, status } = body as { title?: unknown; detail?: unknown; status?: unknown };
	if (title !== undefined) {
		if (typeof title !== "string") {
			return Response.json({ error: "title must be a string" }, { status: 400 });
		}
		const trimmed = title.trim();
		if (trimmed.length < MIN_GOAL_TITLE || trimmed.length > MAX_GOAL_TITLE) {
			return Response.json(
				{ error: `title must be between ${MIN_GOAL_TITLE} and ${MAX_GOAL_TITLE} characters` },
				{ status: 400 },
			);
		}
	}
	if (detail !== undefined) {
		if (typeof detail !== "string") {
			return Response.json({ error: "detail must be a string" }, { status: 400 });
		}
		if (detail.length > MAX_GOAL_DETAIL) {
			return Response.json({ error: `detail is limited to ${MAX_GOAL_DETAIL} characters` }, { status: 400 });
		}
	}
	if (status !== undefined && !GOAL_STATUSES.includes(status as GoalStatus)) {
		return Response.json({ error: `status must be one of ${GOAL_STATUSES.join(", ")}` }, { status: 400 });
	}
	try {
		const goal = updateGoal(id, {
			...(title !== undefined ? { title } : {}),
			...(detail !== undefined ? { detail } : {}),
			...(status !== undefined ? { status: status as GoalStatus } : {}),
		});
		if (!goal) return Response.json({ error: `unknown goal "${id}"` }, { status: 404 });
		return Response.json({ goal });
	} catch (err) {
		return Response.json(
			{ error: err instanceof Error ? err.message : "Could not update the goal." },
			{ status: 400 },
		);
	}
}

export async function DELETE(_req: Request, { params }: Params) {
	const { id } = await params;
	if (deleteGoal(id)) return Response.json({ ok: true });
	return Response.json({ error: `unknown goal "${id}"` }, { status: 404 });
}
