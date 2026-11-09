"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { NodeReviewState, GraphNode, TopicWithStats, UserSettings } from "@/src/core";
import { rankDueNodes, todaySummary, reviewStats, capToday, reviewTarget } from "@/src/core";
import { resolveSettings } from "@/src/core";
import type { Topic } from "@/src/core";

/**
 * The retention hook (retention wave round 2, personal fork): the data
 * wiring behind the Today band + mastery + goal — extracted from
 * MinimalHome so the GRAPH VIEW can render the same retention surface
 * without duplicating ~80 lines of fetch/refresh state.
 *
 * Read cadence (mirrors MinimalHome): one fetch on mount, a refetch on
 * lh:graph-revision (graph/review mutations), topics also on
 * lh:topics-changed. Fire-and-forget — a failed read leaves the band
 * stale, never broken (the home's law).
 *
 * Returns everything the overlay needs: the resolved Today fold, the
 * goal CRUD handlers, and the review-due preset callback wiring.
 */

export interface UseRetention {
	today: ReturnType<typeof todaySummary>;
	/** The DAILY REVIEW TARGET cap (personal fork): the band's headline
	 *  count + minutes capped at the resolved target — `startCount`/
	 *  `startMinutes` for the TodayBand's button label. The fold's full
	 *  `today` fields stay uncapped (the preset still lifts every due
	 *  node). */
	capped: { startCount: number; startMinutes: number };
	activeGoal: { id: string; title: string; detail?: string; status: string } | null;
	startReview: () => void;
	/** The goal editor (shared by the graph card and the quiet home — the
	 *  graph view used to navigate to "/?goal=1", which nothing read: a
	 *  dead click). One implementation, two surfaces. */
	goal: {
		editing: boolean;
		draftTitle: string;
		draftDetail: string;
		setDraftTitle: (v: string) => void;
		setDraftDetail: (v: string) => void;
		startEdit: () => void;
		save: () => void;
		cancel: () => void;
		markDone: () => void;
		clear: () => void;
	};
}

const GOAL_TYPE = { type: "Goal" } as const;

type GoalRecord = { id: string; title: string; detail?: string; status: "active" | "done" | "archived" };

export function useRetention(
	/** The graph snapshot — resolved due nodes need the live node set. */
	snapshot: { nodes: GraphNode[] } | null,
	/** The review-due preset: lift the due nodes + open practice select. */
	onPracticeSelectionChange: (nodes: { id: string; name: string; statement: string }[]) => void,
	onOpenPracticeSelect: () => void,
): UseRetention {
	const [reviewStates, setReviewStates] = useState<NodeReviewState[]>([]);
	const [topics, setTopics] = useState<TopicWithStats[]>([]);
	const [goal, setGoal] = useState<GoalRecord | null>(null);
	// DAILY REVIEW TARGET (personal fork): the resolved cap — read from
	// /api/settings + resolveSettings (the daily-reminder's pattern),
	// refreshed on mount + lh:settings-saved. The resting 20 default is
	// kept on a failed read (the band shows the uncapped minute estimate
	// at worst — never broken).
	const [dailyReviewTarget, setDailyReviewTarget] = useState(20);

	const readReviews = useCallback(() => {
		fetch("/api/graph/reviews")
			.then((r) => (r.ok ? r.json() : null))
			.then((body: unknown) => {
				// The route answers { states: NodeReviewState[] } — accept the
				// bare array too (older shape), and NEVER let a surprise shape
				// reach the fold (a .map on a non-array crashed the whole page).
				const list = Array.isArray(body) ? body : Array.isArray((body as { states?: unknown })?.states) ? (body as { states: NodeReviewState[] }).states : [];
				setReviewStates(list);
			})
			.catch(() => setReviewStates([]));
	}, []);
	// Nodes arrive from the CALLER's snapshot (the graph view owns the one
	// /api/graph fetch). There is no /api/graph/nodes route — asking for one
	// returned the 404 page, which emptied the node set and made the Today
	// count disagree with the chrome's "Review due (N)".
	const nodes = useMemo(() => (Array.isArray(snapshot?.nodes) ? snapshot.nodes : []), [snapshot]);
	const readTopics = useCallback(() => {
		fetch("/api/topics")
			.then((r) => (r.ok ? r.json() : null))
			.then((body: unknown) => {
				const list = Array.isArray(body) ? body : Array.isArray((body as { topics?: unknown })?.topics) ? (body as { topics: TopicWithStats[] }).topics : [];
				setTopics(list);
			})
			.catch(() => setTopics([]));
	}, []);
	const readGoal = useCallback(() => {
		fetch("/api/goals")
			.then((r) => (r.ok ? r.json() : null))
			.then((body: unknown) => {
				const list = Array.isArray((body as { goals?: unknown })?.goals) ? (body as { goals: GoalRecord[] }).goals : [];
				setGoal(list.find((g) => g.status === "active") ?? null);
			})
			.catch(() => setGoal(null));
	}, []);

	useEffect(() => {
		readReviews();
		readTopics();
		readGoal();
		const onRevision = () => readReviews();
		window.addEventListener("lh:graph-revision", onRevision);
		window.addEventListener("lh:topics-changed", readTopics);
		window.addEventListener("lh:goals-changed", readGoal as EventListener);
		return () => {
			window.removeEventListener("lh:graph-revision", onRevision);
			window.removeEventListener("lh:topics-changed", readTopics);
			window.removeEventListener("lh:goals-changed", readGoal as EventListener);
		};
	}, [readReviews, readTopics, readGoal]);
	// The daily review target read (personal fork) mirrors the DailyReminder
	// cadence: mount + lh:settings-saved. Resolve the concrete agent target;
	// a failed read keeps the 20 default.
	useEffect(() => {
		const read = () => {
			fetch("/api/settings")
				.then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
				.then((body: { settings: UserSettings | null }) =>
					setDailyReviewTarget(reviewTarget(resolveSettings(body.settings ?? null).agent)),
				)
				.catch(() => setDailyReviewTarget(20));
		};
		read();
		window.addEventListener("lh:settings-saved", read);
		return () => window.removeEventListener("lh:settings-saved", read);
	}, []);

	const today = useMemo(() => {
		try {
			const states = new Map((Array.isArray(reviewStates) ? reviewStates : []).map((s) => [s.nodeId, s]));
			return todaySummary(states, Array.isArray(nodes) ? nodes : [], Array.isArray(topics) ? topics : []);
		} catch {
			// The retention surface is an AID — a fold failure degrades to
			// "nothing due" and never takes the page down with it.
			return todaySummary(new Map(), [], []);
		}
	}, [reviewStates, nodes, topics]);
	// The DAILY REVIEW TARGET cap (personal fork): the band's headline
	// capped at the resolved target. The fold's full `today` stays uncapped
	// (the preset still lifts every due node).
	const capped = useMemo(() => capToday(today, dailyReviewTarget), [today, dailyReviewTarget]);

	const startReview = useCallback(() => {
		// Start review preselects the WORST N (personal fork): the review
		// backlog is too often a 256-node wall, and "first N" of it is
		// whatever the ledger listed first — not what is breaking.
		// rankDueNodes orders the due set worst-first (wrong → overdue →
		// stale) and caps at the SAME resolved daily target the band's
		// headline cap reads, so a learner opens practice on the nodes most
		// in need, not on the ledger's accidental ordering. When the rank
		// list is empty (nothing due / no present due nodes) the existing
		// behavior holds: do nothing, never open an empty practice select.
		const states = new Map((Array.isArray(reviewStates) ? reviewStates : []).map((s) => [s.nodeId, s]));
		const nodeSet = snapshot?.nodes ?? nodes;
		const ranked = rankDueNodes(states, nodeSet, dailyReviewTarget);
		if (ranked.length === 0) return;
		const byId = new Map(nodeSet.map((n) => [n.id, n]));
		const picked = ranked
			.map((r) => byId.get(r.id))
			.filter((n): n is GraphNode => n !== undefined)
			.map((n) => ({ id: n.id, name: n.name, statement: n.statement }));
		if (picked.length === 0) return;
		onPracticeSelectionChange(picked);
		onOpenPracticeSelect();
	}, [reviewStates, snapshot, nodes, dailyReviewTarget, onPracticeSelectionChange, onOpenPracticeSelect]);

	// ─── the goal editor (one implementation, both surfaces) ─────────────
	const [editing, setEditing] = useState(false);
	const [draftTitle, setDraftTitle] = useState("");
	const [draftDetail, setDraftDetail] = useState("");
	const startEdit = useCallback(() => {
		setDraftTitle(goal?.title ?? "");
		setDraftDetail(goal?.detail ?? "");
		setEditing(true);
	}, [goal]);
	const save = useCallback(() => {
		const title = draftTitle.trim();
		if (!title) return;
		const detail = draftDetail.trim();
		const payload = JSON.stringify(detail ? { title, detail } : { title });
		const req = goal
			? fetch(`/api/goals/${encodeURIComponent(goal.id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: payload })
			: fetch("/api/goals", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload });
		req.then(() => readGoal()).catch(() => {});
		setEditing(false);
	}, [goal, draftTitle, draftDetail, readGoal]);
	const cancel = useCallback(() => setEditing(false), []);
	const markDone = useCallback(() => {
		if (!goal) return;
		fetch(`/api/goals/${encodeURIComponent(goal.id)}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "done" }),
		}).then(() => readGoal()).catch(() => {});
	}, [goal, readGoal]);
	const clear = useCallback(() => {
		if (!goal) return;
		fetch(`/api/goals/${encodeURIComponent(goal.id)}`, { method: "DELETE" }).then(() => readGoal()).catch(() => {});
	}, [goal, readGoal]);

	return {
		today,
		capped,
		activeGoal: goal,
		startReview,
		goal: { editing, draftTitle, draftDetail, setDraftTitle, setDraftDetail, startEdit, save, cancel, markDone, clear },
	};
}

void GOAL_TYPE;
void reviewStats;
