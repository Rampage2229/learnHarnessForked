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

/** One due node ranked WORST FIRST — the Start-review preset's selection
 *  (personal fork). The backlog is too often a 256-node wall; the preset
 *  preselects the WORST `limit` (the daily review target, the same cap
 *  the band's headline reads) so a learner opens practice on what is
 *  breaking, not on whatever the ledger happened to list first. The
 *  `reason` is WHY it ranked (the scheduler's three due paths — the
 *  membership set is reused from dueNodeIds, never re-derived):
 *   - "wrong"   last graded wrong/dontKnow (immediately due — the
 *                model is broken, re-learn first)
 *   - "overdue"  last graded correct but past its SM-2-lite interval
 *                (correct-but-fading — review before forgetting)
 *   - "stale"   last graded "seen" (ungraded) and past the base interval
 *                (the model never got a verdict — surface it again)
 *  `wrongCount` rides along so a caller can keep showing the struggling
 *  count for the picked set (the statement, never the name, as always). */
export interface TodayDueNode {
	id: string;
	statement: string;
	reason: "wrong" | "overdue" | "stale";
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

/** The DAILY REVIEW TARGET's caps (personal fork): the Today band's
 *  headline is a capped target, not the full backlog — a 256-node day
 *  is unusable, so the band caps both the count and the minutes at the
 *  owner's daily target (default 20, agent.dailyReviewTarget 5–100).
 *  The cap is a SIBLING view of an existing TodaySummary — the fold's
 *  own fields (dueCount, minutesEstimate, …) keep their full-backlog
 *  meaning exactly as before (existing tests pin them), and this view
 *  adds ONLY the two capped numbers the button reads. */
export interface TodayReviewTarget {
	/** min(dueCount, target) — the band's headline count (capped). */
	startCount: number;
	/** min(minutesEstimate, target) — the band's headline minutes (capped). */
	startMinutes: number;
}

/** Cap a Today summary's headline numbers at a daily review target.
 *  Pure sibling of `todaySummary` — the fold's existing fields are
 *  untouched; this derives ONLY `startCount`/`startMinutes` (the min of
 *  the summary's dueCount/minutesEstimate and the target). A target of
 *  Infinity (or any number ≥ both) leaves the full counts as-is, so a
 *  caller that never pins a target can pass Infinity and read the
 *  unchanged numbers — the cap is opt-in. */
export function capToday(summary: TodaySummary, target: number): TodayReviewTarget {
	return {
		startCount: Math.min(summary.dueCount, target),
		startMinutes: Math.min(summary.minutesEstimate, target),
	};
}

/** The daily review target's DEFAULT and bounds (personal fork): the
 *  Today band caps its headline at this count of nodes/minutes so a
 *  256-node backlog stays a livable day's work. Absent = 20; the
 *  sanitizer drops outside 5–100 and the write side rejects it. */
export const DAILY_REVIEW_TARGET_DEFAULT = 20;
export const DAILY_REVIEW_TARGET_MIN = 5;
export const DAILY_REVIEW_TARGET_MAX = 100;

/** Resolve the daily review target from the settings key (pure).
 *  Takes the resolved agent settings (the concrete view —
 *  `dailyReviewTarget` is always present after resolution, default 20);
 *  returns the target clamped to 5–100 (a hand-edited out-of-range value
 *  that slipped past the sanitizer still resolves inside the bounds, so
 *  the band's cap can never read a nonsense target). Default 20 when the
 *  key is absent (the resting state). */
export function reviewTarget(agent: { dailyReviewTarget?: number } | undefined | null): number {
	const value = agent?.dailyReviewTarget;
	if (typeof value !== "number" || !Number.isFinite(value)) return DAILY_REVIEW_TARGET_DEFAULT;
	return Math.min(Math.max(Math.round(value), DAILY_REVIEW_TARGET_MIN), DAILY_REVIEW_TARGET_MAX);
}

/** Rank the due nodes WORST FIRST, capped at `limit` — the Start-review
 *  preset's selection (personal fork): the review backlog is too often a
 *  256-node wall, and "first N" of it is whatever the ledger listed first,
 *  not what is breaking. This orders it so a learner opens practice on the
 *  nodes most in need, then caps at the daily target (the same setting the
 *  band's headline cap reads) — review only the worst.
 *
 *  ORDER (worst first):
 *   (a) last graded wrong/dontKnow — most wrongCount desc (the broken
 *       models re-learn first; a repeated wrong outranks a one-off)
 *   (b) correct-but-overdue — oldest lastAt first (the longest-forgotten
 *       correct answers are slipping most)
 *   (c) seen-past-interval — oldest lastAt first (the never-graded
 *       material that has sat longest re-surfaces first)
 *  Ties: within (a) a shared wrongCount breaks to oldest lastAt first
 *  (the older wrong is more likely forgotten), then to nodes-list order
 *  (stable, the same convention as todaySummary's struggling list).
 *  Within (b)/(c) a shared lastAt breaks to nodes-list order. The bucket
 *  order itself is decided by the scheduler's classification, NOT
 *  re-derived: the membership set is reused from dueNodeIds (the due
 *  law lives in one place), and each due state's `reason` is read off its
 *  lastOutcome exactly as dueNodeIds does — wrong/dontKnow → "wrong",
 *  correct → "overdue", seen → "stale".
 *
 *  A node with NO ledger state never appears (it is never due). A node
 *  whose state exists but is not in `nodes` (deleted from the graph) is
 *  dropped — there is no statement to show, the graph-view's resolution
 *  law (a review state for a deleted node is not selectable), the same
 *  law todaySummary uses for dueCount. `limit` ≤ 0 yields an empty list. */
export function rankDueNodes(
	states: ReadonlyMap<string, NodeReviewState>,
	nodes: ReadonlyArray<Pick<GraphNode, "id" | "statement">>,
	limit: number,
	now: Date = new Date(),
): TodayDueNode[] {
	if (!Number.isFinite(limit) || limit <= 0) return [];
	const due = new Set(dueNodeIds(states, now));
	if (due.size === 0) return [];
	const index = new Map(nodes.map((n, i) => [n.id, { node: n, i }]));

	// Score every PRESENT due node into a sortable row. The reason is read
	// off the lastOutcome exactly as dueNodeIds classifies due-ness, so the
	// rank can never disagree with the scheduler on why a node is due.
	const rows: Array<{
		id: string;
		statement: string;
		reason: "wrong" | "overdue" | "stale";
		wrongCount: number;
		bucket: 0 | 1 | 2;
		lastAt: string;
		order: number;
	}> = [];
	for (const entry of index.values()) {
		const state = states.get(entry.node.id);
		if (!state || !due.has(state.nodeId)) continue;
		let reason: "wrong" | "overdue" | "stale";
		let bucket: 0 | 1 | 2;
		if (state.lastOutcome === "wrong" || state.lastOutcome === "dontKnow") {
			reason = "wrong";
			bucket = 0;
		} else if (state.lastOutcome === "correct") {
			reason = "overdue";
			bucket = 1;
		} else {
			// "seen" — the only remaining due path (dueNodeIds already
			// classified it stale when it crossed the base interval).
			reason = "stale";
			bucket = 2;
		}
		rows.push({
			id: entry.node.id,
			statement: entry.node.statement,
			reason,
			wrongCount: state.wrongCount,
			bucket,
			lastAt: state.lastAt,
			order: entry.i,
		});
	}

	// Worst first: bucket (a/b/c), then within-bucket by wrongCount desc (a)
	// or oldest lastAt asc (a's tiebreak + b + c), then nodes-list order
	// (stable). lastAt is ISO so lexical compare ≡ chronological compare.
	rows.sort((a, b) => {
		if (a.bucket !== b.bucket) return a.bucket - b.bucket;
		if (a.bucket === 0) {
			if (a.wrongCount !== b.wrongCount) return b.wrongCount - a.wrongCount;
		}
		if (a.lastAt !== b.lastAt) return a.lastAt < b.lastAt ? -1 : 1; // oldest first
		return a.order - b.order; // stable — nodes-list order
	});

	return rows.slice(0, Math.floor(limit)).map(({ id, statement, reason, wrongCount }) => ({ id, statement, reason, wrongCount }));
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
