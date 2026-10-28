/**
 * POST /api/custom-providers/[id]/refresh — re-discover one custom
 * provider's model catalog from its gateway and persist the result.
 */
import { refreshCustomProvider } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params;
	try {
		const spec = await refreshCustomProvider(id);
		return Response.json(spec);
	} catch (e) {
		const status = (e as { status?: number })?.status;
		if (status) return Response.json({ error: (e as Error).message }, { status });
		return Response.json({ error: (e as Error).message ?? "request failed" }, { status: 502 });
	}
}