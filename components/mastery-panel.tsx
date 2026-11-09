"use client";

/**
 * THE MASTERY PANEL (mastery summary, personal fork): the per-topic
 * mastery surface on the minimal home — a compact list of topics, each
 * with its name, a thin progress bar (masteryPct), and the solid/total
 * counts; the weakest links ride under each as small muted text.
 *
 * TWO layers, the same doctrine as the rest of the home's quiet bands:
 *   - `MasteryList` — PURE presentational (props in, markup out), so the
 *     render suite can pin it statically (SSR, no fetch, no client hooks).
 *   - `MasteryPanel` — a thin fetching wrapper that reads
 *     /api/graph/mastery on mount + the graph-revision event (the same
 *     cadence as the Today / goals bands) and stays quiet on failure.
 *
 * Quiet by the owner ruling: muted small text (text-xs), a thin bar, no
 * cards, no chrome. The panel renders nothing when there are no topics
 * (an unassigned graph has no per-topic mastery to show — the overall
 * roll-up lives in the Today band's orbit, not here).
 */
import { useCallback, useEffect, useState } from "react";
import type { MasteryTopic, OverallMastery } from "@/src/core";
import { asArray, asObject } from "@/components/api-json";

/** The whole list's data — the /api/graph/mastery payload shape. */
export interface MasteryPanelData {
	topics: MasteryTopic[];
	overall: OverallMastery;
}

/** PURE presentational — the per-topic list. Renders nothing when there
 *  are no topics (the home stays quiet before any topic is created). */
export function MasteryList({ topics, overall }: MasteryPanelData) {
	if (topics.length === 0) return null;
	return (
		<div data-testid="mastery-panel" className="flex w-72 flex-col gap-2">
			{/* The overall roll-up — one quiet line above the list, the same
			    centered-column law as the Today band's headline. */}
			<p className="text-center font-ui text-xs uppercase tracking-wider text-muted-foreground/70" data-testid="mastery-overall">
				{overall.solid}/{overall.total} solid · {overall.masteryPct}% mastery
			</p>
			{topics.map((topic) => (
				<div key={topic.topicId} data-testid="mastery-topic" className="rounded-lg border border-border px-2.5 py-1.5">
					<div className="flex items-center justify-between gap-2">
						<span className="truncate font-ui text-xs text-muted-foreground" data-testid="mastery-topic-name">
							{topic.name}
						</span>
						<span className="shrink-0 font-ui text-xs text-muted-foreground/70" data-testid="mastery-topic-counts">
							{topic.solid}/{topic.total}
						</span>
					</div>
					{/* The thin progress bar — masteryPct width, muted track, a
					    slightly stronger fill; rounded to match the row. */}
					<div
						className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted"
						data-testid="mastery-topic-bar"
						role="progressbar"
						aria-valuenow={topic.masteryPct}
						aria-valuemin={0}
						aria-valuemax={100}
					>
						<div
							className="h-full rounded-full bg-muted-foreground/60"
							style={{ width: `${topic.masteryPct}%` }}
						/>
					</div>
					{/* The weakest links — up to 3, small muted text under the
					    row. Silent when the topic has no weak links (all solid). */}
					{topic.weakest.length > 0 && (
						<ul className="mt-1 flex flex-col gap-0.5" data-testid="mastery-topic-weakest">
							{topic.weakest.map((w) => (
								<li key={w.nodeId} className="truncate font-ui text-xs text-muted-foreground/60" title={w.statement}>
									{w.statement}
								</li>
							))}
						</ul>
					)}
				</div>
			))}
		</div>
	);
}

/** The thin fetching wrapper — reads /api/graph/mastery on mount + every
 *  graph revision (the Today / goals bands' cadence), stays quiet on
 *  failure (the panel just hides, like every cosmetic read on the home). */
export function MasteryPanel() {
	const [data, setData] = useState<MasteryPanelData | null>(null);
	const refresh = useCallback(() => {
		fetch("/api/graph/mastery")
			.then((res) => res.json() as Promise<MasteryPanelData>)
			.then((body) => {
				// The route answers { topics, overall }; accept a surprise shape
				// the same way use-retention does — never let a non-array reach
				// the topic .map and take the page down. A bad `overall` keeps
				// the panel hidden rather than rendering against null.
				const obj = asObject(body);
				if (!obj) return;
				const topics = asArray(obj, "topics") as MasteryTopic[];
				const overall = obj.overall as OverallMastery | undefined;
				if (!overall || typeof overall !== "object") return;
				setData({ topics, overall });
			})
			.catch(() => {}); // cosmetic — the panel just stays hidden
	}, []);
	useEffect(() => {
		refresh();
		window.addEventListener("lh:graph-revision", refresh);
		return () => window.removeEventListener("lh:graph-revision", refresh);
	}, [refresh]);
	if (!data) return null;
	return <MasteryList topics={data.topics} overall={data.overall} />;
}
