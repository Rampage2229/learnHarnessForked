/**
 * MASTERY PER TOPIC (mastery summary, personal fork): the pure fold behind
 * the minimal home's Mastery panel — for every topic, how many of its
 * derived nodes are SOLID (last correct + fresh), SHAKY (last wrong /
 * dontKnow, OR correct-but-due), or UNSEEN (no ledger state, or last
 * "seen"), plus the mastery % and the worst few links.
 *
 * Browser-safe pure logic (no store imports, no fs, no network): the SAME
 * seam law as core/reviews.ts / core/today.ts — data arrives as
 * parameters, the caller fetches. The fold REUSES the review scheduler
 * verbatim (dueNodeIds — SM-2-lite) for the "correct-but-due" ruling and
 * the topic-membership law (topicOfNode — first match in topics-list
 * order), so the panel's numbers can never disagree with the graph
 * chrome's Review due preset (the same doctrine as core/today.ts).
 *
 * STATE RULING (the mastery panel's vocabulary, deliberately simpler than
 * the scheduler's color ladder — a panel headline, not a per-node color):
 *   solid   = last correct AND not due (within its SM-2-lite interval)
 *   shaky   = last wrong/dontKnow, OR correct-but-due (overdue review)
 *   unseen  = no ledger state for the node, OR last outcome "seen" (the
 *             ungraded teaching checks — explain/recall record "seen",
 *             no verdict yet). A "seen" node is unseen to mastery EVEN
 *             when the scheduler would decay it into due (the retention
 *             wave): the panel is about KNOWLEDGE state, not schedule.
 *
 * MEMBERSHIP: topicOfNode's first-match law — a node whose provenance
 * spans two topics belongs to its FIRST topic only, everywhere (the v1
 * ruling, contracts/topics.ts). Nodes no topic claims are simply not
 * counted per-topic (they still roll up into overallMastery). Reused, not
 * re-implemented (the doctrine — never a second membership fold).
 */

import type { GraphNode, Topic } from "./contracts.ts";
import { dueNodeIds, type NodeReviewState } from "./reviews.ts";
import { topicOfNode } from "./topics.ts";

/** The worst-state rank for the weakest-links sort — smaller is worse.
 *  Solid is the best and never appears in `weakest`, so it sits at the
 *  bottom of the rank ladder (it is filtered out before the cap). */
const RANK_WRONG = 0; // last wrong / dontKnow — the broken model
const RANK_DUE_CORRECT = 1; // last correct but overdue — approaching forget
const RANK_UNSEEN = 2; // no ledger state or last "seen" — never graded
const RANK_SOLID = 3; // last correct + fresh — healthy

/** The weakest-links cap — the panel is a headline, not a table. */
export const WEAKEST_CAP = 3;

/** One weakest link — the statement is the identity anchor (the
 *  presentational law — same as the Today band's struggling list). */
export interface MasteryWeakest {
	nodeId: string;
	statement: string;
}

/** One topic's mastery summary. `weakest` is up to WEAKEST_CAP nodes with
 *  the worst state (wrong first, then due-correct, then unseen), stable
 *  in nodes-list order on ties. */
export interface MasteryTopic {
	topicId: string;
	name: string;
	/** The topic's derived node count (topicOfNode membership). */
	total: number;
	/** last correct AND not due. */
	solid: number;
	/** last wrong/dontKnow, OR correct-but-due. */
	shaky: number;
	/** no ledger state OR last "seen". */
	unseen: number;
	/** round(100 * solid / total); 0 when total is 0 (never NaN). */
	masteryPct: number;
	/** up to WEAKEST_CAP worst-state nodes (wrong → due-correct → unseen). */
	weakest: MasteryWeakest[];
}

/** The overall mastery roll-up across EVERY topic's nodes (each node once,
 *  via topicOfNode's first-match law — a node two topics share counts once
 *  here, exactly as it counts once in its first topic). */
export interface OverallMastery {
	/** round(100 * solid / total); 0 when total is 0. */
	masteryPct: number;
	solid: number;
	total: number;
}

/** The per-node mastery state, derived from its folded review state and
 *  its due-ness. Used both to classify and to rank for the weakest list. */
function rankOf(state: NodeReviewState | undefined, due: ReadonlySet<string>): number {
	if (state === undefined) return RANK_UNSEEN; // no ledger state
	if (state.lastOutcome === "seen") return RANK_UNSEEN;
	if (state.lastOutcome === "wrong" || state.lastOutcome === "dontKnow") return RANK_WRONG;
	// lastOutcome === "correct" — shaky when overdue, solid when fresh.
	return due.has(state.nodeId) ? RANK_DUE_CORRECT : RANK_SOLID;
}

/** The mastery fold. `now` defaults to the call moment (the same
 *  convention as dueNodeIds/reviewStats/todaySummary) so callers — and
 *  tests — can pin the clock.
 *
 *  Iterates the nodes ONCE: topicOfNode decides membership (first-match),
 *  dueNodeIds precomputes the due set, and each node folds into its
 *  topic's counts + weakest candidate list. Topics with no matching
 *  nodes still emit (total 0, masteryPct 0, empty weakest) — the panel
 *  shows every topic, mirroring the Topics control. */
export function masteryByTopic(
	states: ReadonlyMap<string, NodeReviewState>,
	nodes: ReadonlyArray<Pick<GraphNode, "id" | "statement" | "provenance">>,
	topics: readonly Topic[],
	now: Date = new Date(),
): MasteryTopic[] {
	const due = new Set(dueNodeIds(states, now));

	// One accumulator per topic, kept in topics-list order so the result
	// is positionally stable (the same doctrine as topicNodeGroups).
	type Acc = {
		topicId: string;
		name: string;
		total: number;
		solid: number;
		shaky: number;
		unseen: number;
		// weakest candidates: [rank, nodeIndex, nodeId, statement] — the
		// nodeIndex carries the nodes-list order for stable tiebreaking.
		candidates: Array<[rank: number, index: number, nodeId: string, statement: string]>;
	};
	const accs = topics.map<Acc>((t) => ({
		topicId: t.id,
		name: t.name,
		total: 0,
		solid: 0,
		shaky: 0,
		unseen: 0,
		candidates: [],
	}));

	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i]!;
		const topic = topicOfNode(node, topics);
		if (topic === null) continue; // unclaimed — not counted per-topic
		const idx = topics.indexOf(topic);
		if (idx === -1) continue; // unreachable (topicOfNode returned it)
		const acc = accs[idx]!;
		acc.total++;
		const state = states.get(node.id);
		const rank = rankOf(state, due);
		if (rank === RANK_SOLID) acc.solid++;
		else if (rank === RANK_UNSEEN) acc.unseen++;
		else acc.shaky++; // RANK_WRONG or RANK_DUE_CORRECT
		// Solid never enters the weakest list; the rest are candidates.
		if (rank !== RANK_SOLID) acc.candidates.push([rank, i, node.id, node.statement]);
	}

	return accs.map((acc) => {
		// Worst first (rank asc), stable on nodes-list order (index asc) on
		// ties — a stable sort (Array.prototype.sort is stable as of
		// ES2019, V8/Node included).
		acc.candidates.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
		const weakest: MasteryWeakest[] = acc.candidates.slice(0, WEAKEST_CAP).map((c) => ({
			nodeId: c[2],
			statement: c[3],
		}));
		return {
			topicId: acc.topicId,
			name: acc.name,
			total: acc.total,
			solid: acc.solid,
			shaky: acc.shaky,
			unseen: acc.unseen,
			masteryPct: acc.total > 0 ? Math.round((100 * acc.solid) / acc.total) : 0,
			weakest,
		};
	});
}

/** The overall mastery roll-up — solid / total across every node a topic
 *  claims (topicOfNode's first-match law, so a node shared between two
 *  topics counts once here, as it does in its first topic). Nodes no
 *  topic claims are excluded (mastery is a PER-TOPIC surface — an
 *  unassigned node has no topic to attribute its mastery to). */
export function overallMastery(
	states: ReadonlyMap<string, NodeReviewState>,
	nodes: ReadonlyArray<Pick<GraphNode, "id" | "provenance">>,
	topics: readonly Topic[],
	now: Date = new Date(),
): OverallMastery {
	const due = new Set(dueNodeIds(states, now));
	let total = 0;
	let solid = 0;
	for (const node of nodes) {
		if (topicOfNode(node, topics) === null) continue; // unassigned — not in any topic
		total++;
		const state = states.get(node.id);
		if (rankOf(state, due) === RANK_SOLID) solid++;
	}
	return {
		masteryPct: total > 0 ? Math.round((100 * solid) / total) : 0,
		solid,
		total,
	};
}
