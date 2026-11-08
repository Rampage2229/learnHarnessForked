/** Session recap (feature ⑤, personal fork): the end-of-session artifact —
 *  GET /api/chats/[id]/recap. The propositions THIS session carries
 *  provenance for (node lines merged by id first — getGraph's read-time
 *  discipline: the FIRST line defines the statement, link-appends union
 *  provenance), each with its FRESH review state (the ledger is read and
 *  folded per request — no caching layer), plus the count of reasoning
 *  chains these nodes participate in (as premise or conclusion; assertion
 *  lines merge by (premises, conclusion) — a second session's
 *  re-assertion is a line, not a new chain).
 *
 *  404 on an unknown chat. A pure read, force-dynamic — the transcript's
 *  recap card (components/session-recap.tsx) fetches this on mount.
 */
import { dueNodeIds, getChat, reviewStates, stores } from "@/src/server";

export const dynamic = "force-dynamic";

/** A chain's merge key — the same identity core/graph.ts folds assertion
 *  lines under (sorted premises + conclusion). Local twin: the pure
 *  derivation lives outside the server barrel, and the recap needs only
 *  this one fold. */
function chainKey(premises: readonly string[], conclusion: string): string {
	return `${[...premises].sort().join("+")}>${conclusion}`;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });

	// Node LINES may repeat an id (a later session's link-append): merge
	// by id — first line's statement stands, provenance unions — then
	// keep what THIS chat contributed to.
	const byId = new Map<string, { statement: string; chats: Set<string> }>();
	for (const node of stores.graphStore.readNodes()) {
		const existing = byId.get(node.id);
		if (!existing) {
			byId.set(node.id, { statement: node.statement, chats: new Set(node.provenance.map((pt) => pt.chatId)) });
			continue;
		}
		for (const pt of node.provenance) existing.chats.add(pt.chatId);
	}
	const session = [...byId.entries()]
		.filter(([, merged]) => merged.chats.has(id))
		.map(([nodeId, merged]) => ({ id: nodeId, statement: merged.statement }))
		.sort((a, b) => (a.id < b.id ? -1 : 1)); // deterministic — graphSessionPropositions' sort discipline

	// The ledger, read FRESH: one full read+fold per request.
	const states = reviewStates();
	const due = new Set(dueNodeIds(states));
	const propositions = session.map((n) => {
		const state = states.get(n.id);
		// "dontKnow" counts as wrong everywhere else (foldReviewStates'
		// wrongCount) — it reads as wrong here too, never its own badge.
		const outcome = state ? (state.lastOutcome === "dontKnow" ? ("wrong" as const) : state.lastOutcome) : null;
		return { id: n.id, statement: n.statement, outcome, due: due.has(n.id) };
	});

	// Chain participation: any member (premise or conclusion) among this
	// session's propositions, merged by key so a re-assertion counts once.
	const members = new Set(session.map((n) => n.id));
	const chains = new Set<string>();
	for (const chain of stores.graphStore.readChains()) {
		if (!chain.premises.some((p) => members.has(p)) && !members.has(chain.conclusion)) continue;
		chains.add(chainKey(chain.premises, chain.conclusion));
	}

	return Response.json({ propositions, chainCount: chains.size });
}
