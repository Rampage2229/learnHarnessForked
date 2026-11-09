/** Mastery per topic (mastery summary, personal fork): the per-topic
 *  solid/shaky/unseen fold + mastery % + weakest links, plus the overall
 *  roll-up. LEARNER STATE — derived on read, never stored (the same
 *  doctrine as app/api/graph/reviews/stats). */
import { masteryByTopic, overallMastery } from "@/src/core";
import { stores, topicStore, reviewStates } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const states = reviewStates();
	const nodes = stores.graphStore.readNodes();
	const topics = topicStore.readTopics();

	return Response.json({
		topics: masteryByTopic(states, nodes, topics),
		overall: overallMastery(states, nodes, topics),
	});
}
