/**
 * Review ledger — the learner's graded answers per graph node (review v1,
 * personal fork). LEARNER STATE, not knowledge: a standalone append-only
 * JSONL at the data seam (config PATHS.reviews), deliberately outside the
 * graph ledger family (no format stamp — a review is not a proposition).
 *
 * Feeds two surfaces: staleness coloring on the graph (reviewNodeColor)
 * and the "Review due" practice preset (dueNodeIds — SM-2-lite).
 */

export type ReviewOutcome = "correct" | "wrong" | "dontKnow" | "seen";
export type ReviewSource = "quiz" | "explain" | "probe" | "recall" | "practice" | "self";

export interface ReviewEntry {
	nodeId: string;
	chatId: string;
	at: string;
	outcome: ReviewOutcome;
	confidence?: number;
	source: ReviewSource;
}

/** The folded state for one node across every recorded review. */
export interface NodeReviewState {
	nodeId: string;
	lastAt: string;
	lastOutcome: ReviewOutcome;
	correctCount: number;
	wrongCount: number;
	seenCount: number;
}

const OUTCOMES: ReadonlySet<string> = new Set(["correct", "wrong", "dontKnow", "seen"]);

/** The SM-2-lite interval ladder by correct-streak (correctCount AFTER the
 *  review in question). Index 0 = first correct answer. Documented, not
 *  tuned — the user always chooses when to practice; this only proposes. */
export const REVIEW_INTERVAL_DAYS = [1, 3, 7, 14, 30] as const;

export function intervalDaysForCorrectStreak(correctCount: number): number {
	const i = Math.max(0, Math.min(correctCount - 1, REVIEW_INTERVAL_DAYS.length - 1));
	return REVIEW_INTERVAL_DAYS[i]!;
}

export function isReviewOutcome(value: unknown): value is ReviewOutcome {
	return typeof value === "string" && OUTCOMES.has(value);
}

/** One line is one review; unreadable lines are skipped (never throw). */
export function parseReviewLine(line: string): ReviewEntry | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		const raw = JSON.parse(trimmed) as Record<string, unknown>;
		if (typeof raw.nodeId !== "string" || !raw.nodeId) return null;
		if (typeof raw.chatId !== "string" || !raw.chatId) return null;
		if (typeof raw.at !== "string" || !raw.at) return null;
		if (!isReviewOutcome(raw.outcome)) return null;
		if (typeof raw.source !== "string") return null;
		return {
			nodeId: raw.nodeId,
			chatId: raw.chatId,
			at: raw.at,
			outcome: raw.outcome,
			...(typeof raw.confidence === "number" ? { confidence: raw.confidence } : {}),
			source: raw.source as ReviewSource,
		};
	} catch {
		return null;
	}
}

/** Fold every review into one state per node (last write wins for lastAt /
 *  lastOutcome; counts accumulate). */
export function foldReviewStates(entries: readonly ReviewEntry[]): Map<string, NodeReviewState> {
	const map = new Map<string, NodeReviewState>();
	for (const e of entries) {
		const prev = map.get(e.nodeId);
		const state: NodeReviewState = prev ?? {
			nodeId: e.nodeId,
			lastAt: e.at,
			lastOutcome: e.outcome,
			correctCount: 0,
			wrongCount: 0,
			seenCount: 0,
		};
		if (prev === undefined || e.at >= prev.lastAt) {
			state.lastAt = e.at;
			state.lastOutcome = e.outcome;
		}
		if (e.outcome === "correct") state.correctCount++;
		else if (e.outcome === "wrong" || e.outcome === "dontKnow") state.wrongCount++;
		else state.seenCount++;
		map.set(e.nodeId, state);
	}
	return map;
}

/** A node is DUE when: last wrong/dontKnow → immediately; last correct →
 *  past its SM-2-lite interval; last "seen" (ungraded) → not due (the
 *  model grades it the NEXT turn — the recording seam records a follow-up
 *  correct/wrong entry). Never-reviewed nodes are neutral, never due. */
export function dueNodeIds(
	states: ReadonlyMap<string, NodeReviewState>,
	now: Date = new Date(),
): string[] {
	const due: string[] = [];
	for (const [id, s] of states) {
		const ageMs = now.getTime() - Date.parse(s.lastAt);
		if (Number.isNaN(ageMs)) continue;
		if (s.lastOutcome === "wrong" || s.lastOutcome === "dontKnow") {
			due.push(id);
			continue;
		}
		if (s.lastOutcome !== "correct") continue; // "seen" — no verdict yet
		const intervalMs = intervalDaysForCorrectStreak(s.correctCount) * 24 * 3600 * 1000;
		if (ageMs > intervalMs) due.push(id);
	}
	return due;
}

/**
 * Staleness → node color (browser-safe, pure). Returns null when the node
 * should render in the default color:
 *  - never reviewed → null (neutral)
 *  - wrong/dontKnow recently → RED (needs re-learning)
 *  - wrong/dontKnow but a while ago → deeper red (long-broken)
 *  - correct and fresh (within interval) → null (healthy)
 *  - correct and overdue → AMBER (approaching forget)
 *  - correct and very overdue (≥ 3× interval) → stronger amber→red
 */
export function reviewNodeColor(
	state: NodeReviewState | undefined,
	now: Date = new Date(),
): string | null {
	if (!state) return null;
	const ageMs = now.getTime() - Date.parse(state.lastAt);
	if (Number.isNaN(ageMs)) return null;
	const days = ageMs / (24 * 3600 * 1000);
	if (state.lastOutcome === "wrong" || state.lastOutcome === "dontKnow") {
		// Wrong is always salient; older wrongs read as forgotten.
		return days < 7 ? "hsla(0, 70%, 55%, 1)" : "hsla(0, 75%, 42%, 1)";
	}
	if (state.lastOutcome !== "correct") return null; // "seen" — neutral
	const interval = intervalDaysForCorrectStreak(state.correctCount);
	if (days <= interval) return null; // healthy
	if (days <= interval * 3) return "hsla(38, 85%, 52%, 1)"; // amber — due soon
	return "hsla(20, 85%, 48%, 1)"; // deep amber — overdue
}