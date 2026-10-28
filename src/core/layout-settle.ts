import type { GraphChain, GraphNode, Position, Topic } from "./contracts.ts";
import { incrementalLayout } from "./layout.ts";
import { attachImpToCommunities, birthSessionPartition } from "./session-clusters.ts";
import { topicNodeGroups } from "./topics.ts";
import { deriveView, getGraph } from "./graph.ts";

/**
 * The merge-time settle: recompute the resting layout from the CURRENT
 * graph + the positions ledger, and replace the ledger. Called by the
 * extraction pipeline after every merge (the sole writer) and by the
 * positions-commit endpoint when the graph grew under a live-physics
 * commit (client positions become the anchor set). Synchronous — it must
 * finish before the next /api/graph fetch reflects the change.
 *
 * CHAINS-PRIMARY (owner, 2026-09-30): the settle lays out the DERIVED
 * view — propositions AND the derived implication nodes (one per chain,
 * arg_ ids) over the derived untyped arrows — so positions exist for
 * every node the canvas renders. Implication nodes participate in the
 * physics as regular nodes (rendering specialization comes later).
 *
 * SPLIT FROM layout.ts deliberately (2026-09-13): layout.ts is in the
 * browser barrel, and the settle needs the cluster partition for the
 * cluster centroid pull — this module must not ship in the client bundle.
 * Server code imports it DIRECTLY; it is never re-exported through
 * src/core/index.ts.
 *
 * TOPICS GROUPING (topics v2, personal fork): an optional topics
 * snapshot rides in and the settle adds the topic cohesion force
 * (layout.ts topicPull, TOPIC_PULL_STRENGTH) so same-topic clusters
 * drift together AT REST too — the ledger the canvas warm-starts from
 * already reads as grouped regions. The param is the TOPICS SNAPSHOT
 * (the store's readTopics shape), not pre-built groups: every caller
 * already holds a store handle, and the settle alone has the merged
 * graph (getGraph) the node-membership derivation needs — building the
 * groups here via the pure fold (core/topics.ts topicNodeGroups) keeps
 * the caller diff to one argument and the derivation to one place.
 * Absent/empty topics = exactly the pre-topics settle (no force).
 */
export function settleGraphLayout(
	graphStore: {
		readNodes(): GraphNode[];
		readChains(): GraphChain[];
		readPositions(): Record<string, Position>;
		writePositions(positions: Record<string, Position>): void;
	},
	topics?: ReadonlyArray<Topic>,
): void {
	const graph = getGraph(graphStore);
	if (graph.nodes.length === 0) return;
	const view = deriveView(graph);
	const previous = new Map(Object.entries(graphStore.readPositions()));
	// The cluster partition for the centroid pull: the SAME birth-session
	// partition the snapshot renders (derived from provenance on read —
	// core/session-clusters.ts, wave 7) — one cluster concept everywhere.
	// PROPOSITIONS ONLY (owner, 2026-09-30): implication nodes never
	// partition; the stored world clusters, its image follows.
	const communities = birthSessionPartition(graph.nodes);
	// The SAME imp-node assignment the snapshot renders (majority among
	// premises' births — core/session-clusters.ts): the resting ledger and
	// the live sim must agree on where bundles belong, or the first live
	// tick would fight the settle. Unfiltered here (settle pulls every
	// community, hulls are a canvas-only concern).
	attachImpToCommunities(communities, graph.nodes, graph.chains);
	const next = incrementalLayout(view.nodes, view.edges, previous, {
		clusters: communities,
		// The topic cohesion groups (same derived membership the canvas
		// filters and tints by — topicNodeGroups's first-match fold).
		topicGroups: topics && topics.length > 0 ? topicNodeGroups(topics, graph.nodes) : undefined,
		logicalEdges: view.logicalEdges,
		impLinks: view.impLinks,
	});
	graphStore.writePositions(Object.fromEntries(next));
}
