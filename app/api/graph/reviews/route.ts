/** Review states + due set (review v1, personal fork). LEARNER STATE —
 *  one full read+fold of the append-only ledger (small file), plus the
 *  createdAt backfill: nodes with NO review history seed a synthetic
 *  "demonstrated once" state at their teaching time, so pre-review-era
 *  nodes participate in staleness/due from the start. Local-only — the
 *  backfill derives from the graph ledger, never writes it. */
import { dueNodeIds, stores, reviewStates, type NodeReviewState, type ReviewOutcome } from "@/src/server";

export const dynamic = "force-dynamic";

/** Seed a node that was never reviewed: last "correct"-flavored study at
 *  its createdAt, correctCount 1 (first-interval decay from then). */
function backfillState(nodeId: string, createdAt: string): NodeReviewState {
	return {
		nodeId,
		lastAt: createdAt,
		lastOutcome: "correct" as ReviewOutcome,
		correctCount: 1,
		wrongCount: 0,
		seenCount: 0,
	};
}

export async function GET() {
	const recorded = reviewStates();
	const nodes = stores.graphStore.readNodes();
	const states = new Map(recorded);
	for (const n of nodes) {
		if (states.has(n.id)) continue; // real reviews win — never overwritten
		if (!n.createdAt || Number.isNaN(Date.parse(n.createdAt))) continue;
		states.set(n.id, backfillState(n.id, n.createdAt));
	}
	const due = dueNodeIds(states);
	return Response.json({
		states: [...states.values()],
		due,
	});
}