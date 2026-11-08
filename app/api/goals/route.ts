/**
 * The goals collection route (goals v1, personal fork).
 *
 * GET — the goal surface's read: every goal, ACTIVE FIRST then by
 * createdAt desc (the store's readGoals sort).
 *
 * POST {title, detail?} — create the new ACTIVE goal; the store's
 * single-active invariant silently archives the previous one. Validation
 * (title string 3-200 after trim, detail string up to 2000 or absent)
 * surfaces as 400 bodies with clear errors.
 */
import {
	createGoal,
	MAX_GOAL_DETAIL,
	MAX_GOAL_TITLE,
	MIN_GOAL_TITLE,
	readGoals,
} from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ goals: readGoals() });
}

export async function POST(req: Request) {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "body must be JSON" }, { status: 400 });
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return Response.json({ error: "body must be an object" }, { status: 400 });
	}
	const { title, detail } = body as { title?: unknown; detail?: unknown };
	if (typeof title !== "string") {
		return Response.json({ error: "title must be a string" }, { status: 400 });
	}
	if (title.trim().length < MIN_GOAL_TITLE || title.trim().length > MAX_GOAL_TITLE) {
		return Response.json(
			{ error: `title must be between ${MIN_GOAL_TITLE} and ${MAX_GOAL_TITLE} characters` },
			{ status: 400 },
		);
	}
	if (detail !== undefined) {
		if (typeof detail !== "string") {
			return Response.json({ error: "detail must be a string" }, { status: 400 });
		}
		if (detail.length > MAX_GOAL_DETAIL) {
			return Response.json({ error: `detail is limited to ${MAX_GOAL_DETAIL} characters` }, { status: 400 });
		}
	}
	try {
		const goal = createGoal(title, detail);
		return Response.json({ goal }, { status: 201 });
	} catch (err) {
		return Response.json(
			{ error: err instanceof Error ? err.message : "Could not create the goal." },
			{ status: 400 },
		);
	}
}
