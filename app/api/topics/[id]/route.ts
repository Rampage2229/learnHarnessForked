/**
 * The per-topic route (topics v1, personal fork).
 *
 * PUT /api/topics/:id {name?, addSessionIds?, removeSessionIds?} —
 * rename and/or re-assign sessions in one call; the updated topic is
 * the body. Unknown id → 404; malformed fields → 400 (the store's
 * validation errors surface verbatim).
 *
 * DELETE — removes the GROUP only: sessions and their graph nodes are
 * never touched (membership is derived, contracts/topics.ts). 200 {}
 * when removed, 404 when the id is unknown.
 */
import { topicStore } from "@/src/server";

export const dynamic = "force-dynamic";

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
	const { name, addSessionIds, removeSessionIds } = body as {
		name?: unknown;
		addSessionIds?: unknown;
		removeSessionIds?: unknown;
	};
	if (name !== undefined && typeof name !== "string") {
		return Response.json({ error: "name must be a string" }, { status: 400 });
	}
	const isIdList = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
	if (addSessionIds !== undefined && !isIdList(addSessionIds)) {
		return Response.json({ error: "addSessionIds must be a list of session ids" }, { status: 400 });
	}
	if (removeSessionIds !== undefined && !isIdList(removeSessionIds)) {
		return Response.json({ error: "removeSessionIds must be a list of session ids" }, { status: 400 });
	}
	try {
		const topic = topicStore.updateTopic(id, {
			...(name !== undefined ? { name } : {}),
			...(addSessionIds !== undefined || removeSessionIds !== undefined
				? { add: addSessionIds, remove: removeSessionIds }
				: {}),
		});
		return Response.json({ topic });
	} catch (err) {
		const status = (err as { status?: number }).status === 404 ? 404 : 400;
		return Response.json(
			{ error: err instanceof Error ? err.message : "Could not update the topic." },
			{ status },
		);
	}
}

export async function DELETE(_req: Request, { params }: Params) {
	const { id } = await params;
	if (topicStore.deleteTopic(id)) return Response.json({});
	return Response.json({ error: `unknown topic "${id}"` }, { status: 404 });
}
