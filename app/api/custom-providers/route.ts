/**
 * GET/POST /api/custom-providers — the UI-managed custom OpenAI-compatible
 * providers (personal fork). GET lists the on-disk providers; POST
 * discovers a gateway's model catalog, persists the spec, stores the API
 * key in auth.json, and reconciles the live pi-ai Models collection so the
 * picker federates immediately.
 */
import { addCustomProvider, customProviderIdFromName, listCustomProviders } from "@/src/server";

export const dynamic = "force-dynamic";

/** Discovery/network failures (no .status) surface as 502 — the gateway is
 *  the failure, not the request shape. */
function errorResponse(e: unknown): Response {
	const status = (e as { status?: number })?.status;
	if (status) return Response.json({ error: (e as Error).message }, { status });
	return Response.json({ error: (e as Error).message ?? "request failed" }, { status: 502 });
}

function validateAddBody(body: unknown): string | null {
	if (!body || typeof body !== "object" || Array.isArray(body)) return "Invalid JSON body";
	const raw = body as Record<string, unknown>;
	if (typeof raw.name !== "string" || !raw.name.trim()) return "name must be a non-empty string";
	if (typeof raw.baseUrl !== "string" || !raw.baseUrl.trim()) return "baseUrl must be a non-empty string";
	if (!/^https?:\/\//.test(raw.baseUrl)) return "baseUrl must start with http:// or https://";
	if (typeof raw.apiKey !== "string") return "apiKey must be a string";
	if (raw.alias !== undefined && typeof raw.alias !== "string") return "alias must be a string";
	if (!customProviderIdFromName(raw.name)) return "name must produce a valid id";
	return null;
}

export async function GET() {
	return Response.json(listCustomProviders());
}

export async function POST(request: Request) {
	const body = await request.json().catch(() => null);
	const err = validateAddBody(body);
	if (err) return Response.json({ error: err }, { status: 400 });
	try {
		const spec = await addCustomProvider(body as {
			name: string;
			baseUrl: string;
			apiKey: string;
			alias?: string;
		});
		return Response.json(spec);
	} catch (e) {
		return errorResponse(e);
	}
}