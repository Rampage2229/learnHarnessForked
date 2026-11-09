"use client";

/**
 * THE STREAK BADGE (habit glue, personal fork): the pure presentational
 * flame + "N day streak" line that rides the minimal home's Today band.
 * A streak DAY is any calendar day (local date) with at least one review
 * entry — the same definition core/streak.ts's studyStreak uses. Hidden
 * at 0 (no streak → no badge), so an empty graph keeps its exact old
 * shape (the same law as the Today band's own collapse).
 *
 * Pure body (StreakBadge) + a thin fetch wrapper (StreakBadgeContainer):
 * the wrapper reads the EXISTING GET /api/graph/reviews route (the same
 * read the home's Today band makes) and adapts the folded per-node
 * states into pseudo-entries for studyStreak — each node's `lastAt`
 * (the date of its last review) stands for one study day. The route
 * returns folded NodeReviewState[], NOT raw ReviewEntry[] (the ledger
 * is append-only; a full raw read would be a bigger seam), so the
 * adapter maps one entry per node's last review day. This slightly
 * UNDERCOUNTS days where a learner reviewed but a node's LAST review
 * was an earlier day — an acceptable, conservative read for a badge,
 * and it costs nothing new (no new route, no new store read).
 *
 * data-testid="streak-badge" on the root; the flame is lucide's Flame
 * (the same icon family the home already imports). The wrapper NEVER
 * throws — a failed read just hides the badge (cosmetic, like the Today
 * band's own quiet-on-failure law).
 */

import { useEffect, useState } from "react";
import { Flame } from "lucide-react";
import { studyStreak, type ReviewEntry } from "@/src/core";
import type { NodeReviewState } from "@/src/core";

/** Adapt the folded per-node review states (GET /api/graph/reviews'
 *  `states`) into pseudo-entries for studyStreak: one entry per node,
 *  `at` = the node's last review. Multiple nodes last-reviewed the same
 *  day collapse to one streak day (studyStreak's union-of-days law).
 *  Pure — exported for the render suite. */
export function streakEntriesFromStates(states: readonly NodeReviewState[]): ReviewEntry[] {
	return states.map((s) => ({ nodeId: s.nodeId, chatId: "", at: s.lastAt, outcome: s.lastOutcome, source: "self" }));
}

/** The pure presentational badge. Hidden at 0 (no streak). The flame
 *  + "N day streak" ride a single muted line, the home's own quiet law
 *  (no cards, no chrome). Pure — exported for the render suite. */
export function StreakBadge({ current }: { current: number }) {
	if (current <= 0) return null;
	return (
		<div
			data-testid="streak-badge"
			className="flex items-center gap-1.5 font-ui text-xs text-muted-foreground"
		>
			<Flame className="size-3.5" aria-hidden="true" />
			<span>
				{current} {current === 1 ? "day" : "days"} streak
			</span>
		</div>
	);
}

/** The fetch wrapper: reads GET /api/graph/reviews on mount + every
 *  graph revision (the Today band's own cadence), adapts the folded
 *  states to streak entries, and renders the badge. Never throws — a
 *  failed read just leaves the badge hidden (cosmetic, like the Today
 *  band's quiet-on-failure law). `today` is overridable for tests. */
export function StreakBadgeContainer({ today }: { today?: Date } = {}) {
	const [current, setCurrent] = useState(0);
	useEffect(() => {
		const read = () => {
			fetch("/api/graph/reviews")
				.then((res) => res.json() as Promise<{ states: NodeReviewState[]; due: string[] }>)
				.then((d) => {
					const entries = streakEntriesFromStates(d.states ?? []);
					setCurrent(studyStreak(entries, today ?? new Date()).current);
				})
				.catch(() => {}); // cosmetic — the badge just stays hidden
		};
		read();
		window.addEventListener("lh:graph-revision", read);
		return () => window.removeEventListener("lh:graph-revision", read);
		// `today` is captured at mount; the home remounts on day roll-over
		// (the Today band's own cadence), so a pinned test clock does not
		// need to re-run on prop change.
	}, []);
	return <StreakBadge current={current} />;
}
