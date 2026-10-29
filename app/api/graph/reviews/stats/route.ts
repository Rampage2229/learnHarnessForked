/** Review mastery summary (review v1, personal fork): overall health +
 *  per-topic breakdown. LEARNER STATE — derived on read, never stored. */
import { stores, topicStore, reviewStates, reviewStats } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const states = reviewStates();
	const nodes = stores.graphStore.readNodes();
	const topics = topicStore.readTopics();

	// Node id → review state for the per-topic folds.
	const overall = reviewStats(states);

	const byTopic = topics.map((topic) => {
		const sessions = new Set(topic.sessionIds);
		const memberIds = new Set<string>();
		for (const n of nodes) {
			if (n.provenance.some((pt) => sessions.has(pt.chatId))) memberIds.add(n.id);
		}
		const topicStates = new Map<string, (typeof states) extends Map<string, infer V> ? V : never>();
		for (const id of memberIds) {
			const s = states.get(id);
			if (s) topicStates.set(id, s);
		}
		const stats = reviewStats(topicStates);
		return {
			topicId: topic.id,
			name: topic.name,
			sessionCount: topic.sessionIds.length,
			nodeCount: memberIds.size,
			...stats,
		};
	});

	return Response.json({ overall, byTopic });
}