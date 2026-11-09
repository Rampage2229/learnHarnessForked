"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { NodeReviewState, GraphNode, TopicWithStats } from "@/src/core";
import { dueNodeIds, todaySummary, reviewStats } from "@/src/core";
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
	activeGoal: { id: string; title: string; detail?: string; status: string } | null;
	startReview: () => void;
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
	const [nodes, setNodes] = useState<GraphNode[]>([]);
	const [topics, setTopics] = useState<TopicWithStats[]>([]);
	const [goal, setGoal] = useState<GoalRecord | null>(null);

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
	const readNodes = useCallback(() => {
		fetch("/api/graph/nodes")
			.then((r) => (r.ok ? r.json() : null))
			.then((body: unknown) => {
				const list = Array.isArray(body) ? body : Array.isArray((body as { nodes?: unknown })?.nodes) ? (body as { nodes: GraphNode[] }).nodes : [];
				setNodes(list);
			})
			.catch(() => setNodes([]));
	}, []);
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
		readNodes();
		readTopics();
		readGoal();
		const onRevision = () => {
			readReviews();
			readNodes();
		};
		window.addEventListener("lh:graph-revision", onRevision);
		window.addEventListener("lh:topics-changed", readTopics);
		window.addEventListener("lh:goals-changed", readGoal as EventListener);
		return () => {
			window.removeEventListener("lh:graph-revision", onRevision);
			window.removeEventListener("lh:topics-changed", readTopics);
			window.removeEventListener("lh:goals-changed", readGoal as EventListener);
		};
	}, [readReviews, readNodes, readTopics, readGoal]);

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

	const startReview = useCallback(() => {
		const due = dueNodeIds(new Map((Array.isArray(reviewStates) ? reviewStates : []).map((s) => [s.nodeId, s])));
		const byId = new Map((snapshot?.nodes ?? nodes).map((n) => [n.id, n]));
		const picked = due
			.map((id) => byId.get(id))
			.filter((n): n is GraphNode => n !== undefined)
			.map((n) => ({ id: n.id, name: n.name, statement: n.statement }));
		if (picked.length === 0) return;
		onPracticeSelectionChange(picked);
		onOpenPracticeSelect();
	}, [reviewStates, snapshot, nodes, onPracticeSelectionChange, onOpenPracticeSelect]);

	return { today, activeGoal: goal, startReview };
}

void GOAL_TYPE;
void reviewStats;
