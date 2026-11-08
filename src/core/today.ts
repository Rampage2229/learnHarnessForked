/**
 * THE TODAY FOLD (feature ①, the Today retention surface, personal
 * fork): the pure half of the home's Today band — given the folded
 * review states + the graph nodes (+ the topics list), derive everything
 * the band shows: the due count, the due breakdown by topic, the
 * struggling nodes, and a rough minutes estimate.
 *
 * Browser-safe pure logic (no store imports, no fs, no network): the
 * same seam law as core/reviews.ts — data arrives as parameters, the
 * caller fetches. The fold REUSES the review scheduler verbatim
 * (dueNodeIds — SM-2-lite) and the topic-membership law (topicOfNode —
 * first match in topics-list order), so the band's numbers can never
 * disagree with the graph chrome's Review due preset.
 */

import type { GraphNode, Topic } from "./contracts.ts";
import { dueNodeIds, type NodeReviewState } from "./reviews.ts";
import { topicOfNode } from "./topics.ts";

/** A node counts as STRUGGLING at two or more wrong/dontKnow reviews —
 *  one wrong is noise (a misread), a repeated wrong is a broken model. */
export const STRUGGLING_MIN_WRONG = 2;

/** The struggling list's cap — the band is a headline, not a table. */
export const STRUGGLING_CAP = 5;

/** The minutes estimate's floor — even a handful of due cards costs a
 *  context switch; never promise "0 min". */
export const MIN_REVIEW_MINUTES = 5;

/** One topic's slice of the due set. `topicId: ""` is the UNASSIGNED
 *  bucket (due nodes no topic claims via provenance) — kept so the
 *  breakdown always sums to dueCount; it only ever appears when
 *  non-empty, sorted last on ties (appended after the topic buckets). */
export interface TodayDueTopic {
	topicId: string;
	name: string;
	count: number;
}

/** One struggling node — the band (and any future surface) renders the
 *  statement (the identity anchor), never the name (presentational). */
export interface TodayStrugglingNode {
	nodeId: string;
	statement: string;
	wrongCount: number;
}

/** The whole Today band's data, in one fold. */
export interface TodaySummary {
	/** Due nodes PRESENT in the graph — the graph view's resolution law:
	 *  a review state for a deleted node is not selectable, so not
	 *  counted (the band's number must match what Start review selects). */
	dueCount: number;
	/** The due set broken down by topic (count desc, stable). */
	dueByTopic: TodayDueTopic[];
	/** wrongCount ≥ STRUGGLING_MIN_WRONG, worst first, capped at
	 *  STRUGGLING_CAP. Present nodes only (the statement comes from the
	 *  node); input order breaks ties. */
	struggling: TodayStrugglingNode[];
	/** max(MIN_REVIEW_MINUTES, dueCount) — one minute per due node,
	 *  never below the floor. */
	minutesEstimate: number;
}

/** The Today fold. `now` defaults to the call moment (the same
 *  convention as dueNodeIds/reviewStats) so callers — and tests — can
 *  pin the clock. */
export function todaySummary(
	states: ReadonlyMap<string, NodeReviewState>,
	nodes: ReadonlyArray<Pick<GraphNode, "id" | "statement" | "provenance">>,
	topics: readonly Topic[],
	now: Date = new Date(),
): TodaySummary {
	// The due set resolved against the PRESENT nodes (graph-view's law,
	// verbatim): the band counts only what Start review can preselect.
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const dueNodes = dueNodeIds(states, now)
		.map((id) => byId.get(id))
		.filter((n): n is Pick<GraphNode, "id" | "statement" | "provenance"> => n !== undefined);

	// The topic breakdown: topicOfNode's first-match law decides each
	// due node's topic; the unclaimed rest lands in the Unassigned
	// bucket so the parts still sum to the whole. Stable sort — ties
	// keep topics-list order, Unassigned (appended last) last.
	const buckets = new Map<string, TodayDueTopic>();
	for (const node of dueNodes) {
		const topic = topicOfNode(node, topics);
		const key = topic?.id ?? "";
		const bucket = buckets.get(key);
		if (bucket) bucket.count++;
		else buckets.set(key, { topicId: key, name: topic?.name ?? "Unassigned", count: 1 });
	}
	const dueByTopic = [...buckets.values()].sort((a, b) => b.count - a.count);

	// Struggling: walk the PRESENT nodes (states may outlive deleted
	// nodes — there is no statement to show for them), keep the ones
	// with enough wrongs, worst first, capped.
	const struggling = nodes
		.map((node) => ({ node, state: states.get(node.id) }))
		.filter(
			(entry): entry is { node: Pick<GraphNode, "id" | "statement" | "provenance">; state: NodeReviewState } =>
				entry.state !== undefined && entry.state.wrongCount >= STRUGGLING_MIN_WRONG,
		)
		.sort((a, b) => b.state.wrongCount - a.state.wrongCount)
		.slice(0, STRUGGLING_CAP)
		.map((entry) => ({ nodeId: entry.node.id, statement: entry.node.statement, wrongCount: entry.state.wrongCount }));

	return {
		dueCount: dueNodes.length,
		dueByTopic,
		struggling,
		minutesEstimate: Math.max(MIN_REVIEW_MINUTES, dueNodes.length),
	};
}
