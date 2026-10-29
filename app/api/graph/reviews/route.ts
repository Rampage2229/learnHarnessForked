/** Review states + due set (review v1, personal fork). LEARNER STATE —
 *  one full read+fold of the append-only ledger (small file). */
import { dueNodeIds, reviewStates } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const states = reviewStates();
	const due = dueNodeIds(states);
	return Response.json({
		states: [...states.values()],
		due,
	});
}