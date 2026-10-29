/** Move a session between topics (or unassign) — topics v1, personal fork.
 *  PATCH {topicId: string | null}: a string must name an existing topic
 *  (400 otherwise); null clears the stamp. Mirrors rename: no updatedAt
 *  bump — a topic move must not reorder the sidebar. */
import { getChat, stores, topicStore } from "@/src/server";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });

	const body = (await req.json().catch(() => null)) as { topicId?: unknown } | null;
	if (!body || (body.topicId !== null && typeof body.topicId !== "string")) {
		return Response.json({ error: "topicId must be a string or null" }, { status: 400 });
	}
	if (body.topicId !== null && !topicStore.readTopics().some((t) => t.id === body.topicId)) {
		return Response.json({ error: `unknown topic "${body.topicId}"` }, { status: 400 });
	}

	const record = stores.chatStore.setChatTopic(id, body.topicId);
	if (!record) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json({ topicId: record.topicId ?? null });
}