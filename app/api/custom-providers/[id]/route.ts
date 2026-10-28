/**
 * PUT/DELETE /api/custom-providers/[id] — update or remove a custom
 * OpenAI-compatible provider (personal fork). Update applies present
 * fields; a baseUrl change (or an empty model list) re-discovers. Delete
 * removes the spec and its auth.json key. Both reconcile the live pi-ai
 * Models collection.
 */
import { removeCustomProvider, updateCustomProvider } from "@/src/server";

export const dynamic = "force-dynamic";

function errorResponse(e: unknown): Response {
	const status = (e as { status?: number })?.status;
	if (status) return Response.json({ error: (e as Error).message }, { status });
	return Response.json({ error: (e as Error).message ?? "request failed" }, { status: 502 });
}

function validatePatchBody(body: unknown): string | null {
	if (!body || typeof body !== "object" || Array.isArray(body)) return "Invalid JSON body";
	const raw = body as Record<string, unknown>;
	if (raw.name !== undefined && (typeof raw.name !== "string" || !raw.name.trim())) {
		return "name must be a non-empty string";
	}
	if (raw.baseUrl !== undefined) {
		if (typeof raw.baseUrl !== "string" || !raw.baseUrl.trim()) return "baseUrl must be a non-empty string";
		if (!/^https?:\/\//.test(raw.baseUrl)) return "baseUrl must start with http:// or https://";
	}
	if (raw.apiKey !== undefined && typeof raw.apiKey !== "string") return "apiKey must be a string";
	if (raw.alias !== undefined && typeof raw.alias !== "string") return "alias must be a string";
	return null;
}

export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params;
	const body = await request.json().catch(() => null);
	const err = validatePatchBody(body);
	if (err) return Response.json({ error: err }, { status: 400 });
	try {
		const spec = await updateCustomProvider(id, body as {
			name?: string;
			baseUrl?: string;
			apiKey?: string;
			alias?: string;
		});
		return Response.json(spec);
	} catch (e) {
		return errorResponse(e);
	}
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params;
	try {
		removeCustomProvider(id);
		return Response.json({});
	} catch (e) {
		return errorResponse(e);
	}
}