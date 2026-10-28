/**
 * TOPIC DERIVATION (topics v1, personal fork): the pure half of the
 * topics layer — membership folds over the topics record + provenance,
 * nothing else. A topic owns SESSIONS; a node belongs to a topic when
 * any provenance chatId is one of its sessions — there is no node-level
 * tag anywhere (the v1 ruling, contracts/topics.ts). Deleting or editing
 * a topic can therefore never touch the graph: the membership is
 * recomputed on every read.
 *
 * Browser-safe pure logic (no node builtins, no fs): same contract style
 * as the rest of the core derivation modules. "First match" is the
 * topics list's order (the store keeps creation order) — a session
 * assigned to two topics resolves to the earlier one, everywhere.
 */

import type { GraphNode, Topic } from "./contracts.ts";

/** The topic a node belongs to: the first topic whose session set
 *  intersects the node's provenance chatIds. null when none does. */
export function topicOfNode(
	node: { provenance: ReadonlyArray<{ chatId: string }> },
	topics: readonly Topic[],
): Topic | null {
	for (const topic of topics) {
		const sessions = new Set(topic.sessionIds);
		if (node.provenance.some((p) => sessions.has(p.chatId))) return topic;
	}
	return null;
}

/** The topic a session belongs to: the first topic whose sessionIds
 *  contains the id. null when the session is unassigned. */
export function topicOfChat(chatId: string, topics: readonly Topic[]): Topic | null {
	return topics.find((t) => t.sessionIds.includes(chatId)) ?? null;
}

/** Topic groups for the layout engine (topics grouping): per topic, the
 *  node ids whose provenance touches that topic's sessions — the SAME
 *  derived membership as topicOfNode, first-match law and all (a node
 *  two topics share pulls toward its FIRST topic only, everywhere).
 *  Feeds the topic cohesion force (layout.ts topicPull) on both the
 *  server settle (layout-settle.ts, from the topics snapshot its caller
 *  passes) and the live sim (graph-view → renderer.setData). Singleton
 *  groups are harmless — the force skips them. Pure; deterministic
 *  (topics in list order, nodes in input order). */
export function topicNodeGroups(
	topics: readonly Topic[],
	nodes: ReadonlyArray<Pick<GraphNode, "id" | "provenance">>,
): Array<{ id: string; nodeIds: string[] }> {
	const sets = topics.map((t) => ({ id: t.id, sessions: new Set(t.sessionIds) }));
	const buckets = new Map<string, string[]>();
	for (const node of nodes) {
		for (const { id, sessions } of sets) {
			if (node.provenance.some((p) => sessions.has(p.chatId))) {
				const list = buckets.get(id);
				if (list) list.push(node.id);
				else buckets.set(id, [node.id]);
				break; // first match wins — one topic per node, everywhere
			}
		}
	}
	// Emit in TOPIC order (topics without matching nodes drop out) — the
	// group list is a pure function of (topics, nodes), positionally
	// stable no matter which topic's nodes appeared first.
	return sets
		.map(({ id }) => ({ id, nodeIds: buckets.get(id) }))
		.filter((g): g is { id: string; nodeIds: string[] } => g.nodeIds != null);
}

/** One topic + its derived stats (the GET /api/topics payload's shape). */
export interface TopicWithStats extends Topic {
	sessionCount: number;
	nodeCount: number;
}

/** The derived-stats fold (topics v1): ONE pass over the graph nodes,
 *  counting each node for EVERY topic whose session set intersects its
 *  provenance (a node two topics share counts for both — honest derived
 *  membership). sessionCount is the record's own list length. Pure; the
 *  route feeds it the store's readTopics + readNodes. */
export function withTopicStats(
	topics: readonly Topic[],
	nodes: ReadonlyArray<{ provenance: ReadonlyArray<{ chatId: string }> }>,
): TopicWithStats[] {
	const sessionSets = topics.map((t) => new Set(t.sessionIds));
	const counts = new Array<number>(topics.length).fill(0);
	for (const node of nodes) {
		const chats = new Set(node.provenance.map((p) => p.chatId));
		for (let i = 0; i < topics.length; i++) {
			for (const chat of chats) {
				if (sessionSets[i]!.has(chat)) {
					counts[i]!++;
					break;
				}
			}
		}
	}
	return topics.map((t, i) => ({ ...t, sessionCount: t.sessionIds.length, nodeCount: counts[i]! }));
}
