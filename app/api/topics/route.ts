/**
 * The topics collection route (topics v1, personal fork).
 *
 * GET — the graph view's Topics control + the sidebar's badge resolver:
 * every topic with its DERIVED stats (withTopicStats, core/topics.ts —
 * one readNodes pass; membership is never stored, contracts/topics.ts).
 *
 * POST {name} — create an empty topic; the store's validation errors
 * (empty after trim, over the 120-char cap) surface as 400 bodies
 * verbatim.
 */
import { withTopicStats } from "@/src/core";
import { stores, topicStore } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const topics = topicStore.readTopics();
	const nodes = stores.graphStore.readNodes();
	return Response.json({ topics: withTopicStats(topics, nodes) });
}

export async function POST(req: Request) {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "body must be JSON" }, { status: 400 });
	}
	if (!body || typeof body !== "object" || Array.isArray(body) || typeof (body as { name?: unknown }).name !== "string") {
		return Response.json({ error: "body must be {name: string}" }, { status: 400 });
	}
	try {
		const topic = topicStore.createTopic((body as { name: string }).name);
		return Response.json({ topic }, { status: 201 });
	} catch (err) {
		return Response.json(
			{ error: err instanceof Error ? err.message : "Could not create the topic." },
			{ status: 400 },
		);
	}
}
