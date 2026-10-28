/**
 * DELETE /api/memory/:id — remove one memory entry (memory v1, personal
 * fork). 200 {} when removed, 404 when the id is unknown (the store's
 * boolean answers honestly; absent = an honest no).
 */
import { memoryStore } from "@/src/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function DELETE(_req: Request, { params }: Params) {
	const { id } = await params;
	if (memoryStore.deleteMemoryEntry(id)) return Response.json({});
	return Response.json({ error: `unknown memory "${id}"` }, { status: 404 });
}
