/**
 * The user-memory collection route (memory v1, personal fork).
 *
 * GET — the Settings → Memory list, NEWEST-FIRST for the UI (the store
 * keeps newest-last on disk; this is the view flip).
 *
 * POST {text} — add one entry; the store's validation errors (empty after
 * trim, over the 2000-char ceiling) surface as 400 bodies verbatim. A
 * full store (200 entries) evicts its OLDEST entry — the standing context
 * stays fresh by construction.
 */
import { memoryStore } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ entries: [...memoryStore.readMemory()].reverse() });
}

export async function POST(req: Request) {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "body must be JSON" }, { status: 400 });
	}
	if (!body || typeof body !== "object" || Array.isArray(body) || typeof (body as { text?: unknown }).text !== "string") {
		return Response.json({ error: "body must be {text: string}" }, { status: 400 });
	}
	try {
		const entry = memoryStore.addMemoryEntry((body as { text: string }).text);
		return Response.json({ entry }, { status: 201 });
	} catch (err) {
		return Response.json(
			{ error: err instanceof Error ? err.message : "Could not save the memory." },
			{ status: 400 },
		);
	}
}
