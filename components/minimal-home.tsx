"use client";

/**
 * THE MINIMAL HOME (owner, 2026-10-06 — the no-graph home, take two):
 * when GRAPH RENDERING is off (graph.rendering in settings), the home's
 * main view is this — deliberately quiet, deliberately minimal. The
 * eventual plan is the DATA VIEW as home; until that is designed and
 * built, this is the placeholder that asks for nothing new: the SAME
 * composer blob home already floats (teach/practice switcher + pick
 * pill — untouched), the graph chrome's survivors in the SAME places
 * the graph view keeps them (top-right column: actions row, cost pill
 * BELOW it), and a centered, quiet summary of the knowledge base in
 * numbers. No recent sessions (the sidebar owns that), no canvas, no
 * list scrolling under the composer.
 *
 * The CHAIN TABLE stays behind its button exactly as on the graph view:
 * the standard overlay, unchanged — this component owns only the button.
 * The practice pick flow mirrors GraphView's contract verbatim (home
 * lifts the pick set; the chip opens the overlay in select mode).
 *
 * THE TODAY BAND (feature ①, personal fork): the retention surface —
 * the graph chrome's Review due preset, carried onto the no-graph home.
 * The numbers come from the pure Today fold (core/today.ts, fed by the
 * SAME /api/graph/reviews + /api/topics reads the graph view makes);
 * Start review triggers the SAME preset mechanism as the graph view
 * (preselect the resolved due nodes, open the chain table, flip into
 * practice-select mode). Home's chainSelectOpen owns the composer's
 * select-mode flag and is not settable from here — the overlay's select
 * mode honors a local flip instead, identical in effect.
 *
 * THE GOAL BAND (feature ②, personal fork): the aim above the day's
 * status — "Working toward: <title>" rides the same centered column,
 * directly above the Today band. One active goal at a time (the
 * /api/goals backend archives the previous one); no goal set is a quiet
 * "Set a goal" pill. Clicking the line opens the small inline editor
 * (title + optional detail) — POST on create, PUT on edit; Mark done
 * and Clear act on the active goal. The reads mirror the Today band's
 * cadence (mount + lh:graph-revision); the band stays quiet on failure
 * like every cosmetic read here.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ListTreeIcon } from "lucide-react";
import { ChainTableOverlay } from "@/components/chain-table.tsx";
import { GraphCostControl } from "@/components/graph-view.tsx";
import { NotesImportControl, NotesImportErrors, NotesImportNotices, useNotesImport } from "@/components/notes-import.tsx";
import { Hint } from "@/components/ui/hint";
import { dueNodeIds, todaySummary } from "@/src/core";
import type { ChatSummary, GraphCostSummary, GraphNode, GraphSnapshot, NodeReviewState, TopicWithStats } from "@/src/core";

/** The quiet centered summary — a pure body (props in, markup out) so
 * the render suite can pin it statically. Very quiet by owner ruling:
 * muted small text, no cards, no chrome. */
export function KnowledgeSummary({
	propositions,
	chains,
	teachSessions,
	practiceSessions,
	importedNotes,
}: {
	propositions: number;
	chains: number;
	teachSessions: number;
	practiceSessions: number;
	importedNotes: number;
}) {
	const empty =
		propositions === 0 && chains === 0 && teachSessions === 0 && practiceSessions === 0 && importedNotes === 0;
	return (
		<div data-testid="knowledge-summary" className="flex flex-col items-center text-center">
			{/* Own-line law (owner, 2026-10-06): every count sits on its own
			    row — no dot separators; the two blocks (graph, sessions)
			    part with one empty line; the notes COUNT (never the file
			    list) rides after the same parting. */}
			<div className="flex flex-col gap-1">
				<p className="font-ui text-sm text-muted-foreground">
					{propositions} {propositions === 1 ? "proposition" : "propositions"}
				</p>
				<p className="font-ui text-sm text-muted-foreground">
					{chains} {chains === 1 ? "chain" : "chains"}
				</p>
			</div>
			<div className="h-4" aria-hidden="true" />
			<div className="flex flex-col gap-1">
				<p className="font-ui text-sm text-muted-foreground">
					{teachSessions} {teachSessions === 1 ? "teaching session" : "teaching sessions"}
				</p>
				<p className="font-ui text-sm text-muted-foreground">
					{practiceSessions} {practiceSessions === 1 ? "practice session" : "practice sessions"}
				</p>
			</div>
			<div className="h-4" aria-hidden="true" />
			<p className="font-ui text-sm text-muted-foreground">
				{importedNotes} {importedNotes === 1 ? "imported note" : "imported notes"}
			</p>
			{empty && (
				<div className="pt-2 font-ui text-xs text-muted-foreground/70">
					<p>Start a session to begin learning.</p>
					<p className="mt-1">Attach your material with the paperclip or drag and drop.</p>
				</div>
			)}
		</div>
	);
}

/** THE TODAY BAND (feature ①, personal fork): the retention surface —
 *  the due count, the struggling count when anyone is struggling, and
 *  the Start review button that runs the graph view's review-due preset
 *  mechanism. Pure body (props in, markup out) like KnowledgeSummary so
 *  the render suite can pin it statically. Quiet by the same owner
 *  ruling: muted small text, no cards, no chrome. Renders nothing when
 *  there is nothing due and nobody struggling; the button follows the
 *  graph chrome's own law — zero due, no button. */
export function TodayBand({
	dueCount,
	strugglingCount,
	minutesEstimate,
	onStartReview,
}: {
	dueCount: number;
	strugglingCount: number;
	minutesEstimate: number;
	/** The review-due preset's click (lift the due nodes + open the
	 *  practice picker). Absent = the readout renders without the button
	 *  (static pins); the graph chrome's law still hides it at zero due. */
	onStartReview?: () => void;
}) {
	if (dueCount === 0 && strugglingCount === 0) return null;
	return (
		<div data-testid="today-band" className="flex flex-col items-center gap-1.5">
			<p className="font-ui text-xs uppercase tracking-wider text-muted-foreground/70">Today</p>
			<p className="font-ui text-sm text-muted-foreground">
				{dueCount} {dueCount === 1 ? "node" : "nodes"} due for review
			</p>
			{strugglingCount > 0 && (
				<p className="font-ui text-xs text-muted-foreground" data-testid="today-struggling-count">
					{strugglingCount} {strugglingCount === 1 ? "node" : "nodes"} struggling
				</p>
			)}
			{dueCount > 0 && onStartReview && (
				<Hint label="Pre-selects every due node and opens the practice picker" side="bottom">
					<button
						type="button"
						onClick={onStartReview}
						data-testid="start-review"
						// pointer-events-auto: the centered column is
						// pointer-events-none so the quiet summary never blocks
						// the surface beneath it — the one interactive element
						// here opts back in (the chrome column's own pattern).
						className="pointer-events-auto flex h-7 items-center rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent"
					>
						Start review (~{minutesEstimate} min)
					</button>
				</Hint>
			)}
		</div>
	);
}

/** THE GOAL BAND (feature ②, personal fork): the aim line above the
 *  Today band — "Working toward: <title>" (detail as the smaller second
 *  line), or the quiet "Set a goal" pill when none is active, or the
 *  small inline editor. Pure body (props in, markup out) like
 *  TodayBand/KnowledgeSummary so the render suite can pin it statically;
 *  the fetches and the draft state live in MinimalHome. Same quiet law:
 *  muted small text, no cards, no chrome. The Goal type is defined here
 *  from the /api/goals JSON shape (components import only the pure core
 *  barrel, and goals are a transport shape, not core). */
export type GoalStatus = "active" | "done" | "archived";

export type Goal = {
	id: string;
	title: string;
	detail?: string;
	createdAt: string;
	status: GoalStatus;
};

export function GoalBand({
	goal,
	editing,
	draftTitle,
	draftDetail,
	onEditStart,
	onDraftTitle,
	onDraftDetail,
	onSave,
	onCancel,
	onMarkDone,
	onClear,
}: {
	/** The ACTIVE goal (status "active"), or null when none is set. */
	goal: Goal | null;
	/** The inline editor is open (goal line / Set a goal click). */
	editing: boolean;
	/** The controlled draft fields of the inline editor. */
	draftTitle: string;
	draftDetail: string;
	/** Open the editor — the caller prefills the drafts from the goal. */
	onEditStart?: () => void;
	onDraftTitle?: (value: string) => void;
	onDraftDetail?: (value: string) => void;
	/** POST on create / PUT on edit; Cancel closes; Mark done flips the
	 *  active goal to "done"; Clear deletes it. Absent callbacks = the
	 *  static pins (SSR tests wire only what a state shows). */
	onSave?: () => void;
	onCancel?: () => void;
	onMarkDone?: () => void;
	onClear?: () => void;
}) {
	// A title is the one requirement — Save stays dead without one (create
	// and edit alike; detail is optional by contract).
	const canSave = draftTitle.trim().length > 0;

	// The inline editor replaces the line (the classic inline-edit law):
	// title, optional detail, Save/Cancel — no modal, no chrome.
	if (editing) {
		return (
			<div
				data-testid="goal-edit"
				// pointer-events-auto: the centered column is pointer-events-none
				// (the Today band's law); everything here is interactive.
				className="pointer-events-auto flex w-72 flex-col items-stretch gap-1.5"
			>
				<input
					type="text"
					value={draftTitle}
					onChange={(e) => onDraftTitle?.(e.target.value)}
					placeholder="What are you working toward?"
					data-testid="goal-title-input"
					className="rounded-lg border bg-transparent px-2.5 py-1 font-ui text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
				/>
				<textarea
					value={draftDetail}
					onChange={(e) => onDraftDetail?.(e.target.value)}
					placeholder="Detail (optional)"
					rows={2}
					data-testid="goal-detail-input"
					className="resize-none rounded-lg border bg-transparent px-2.5 py-1 font-ui text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
				/>
				<div className="flex items-center justify-center gap-1">
					<button
						type="button"
						onClick={onSave}
						disabled={!canSave}
						data-testid="goal-save"
						className="flex h-7 items-center rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
					>
						Save
					</button>
					<button
						type="button"
						onClick={onCancel}
						data-testid="goal-cancel"
						className="flex h-7 items-center rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent"
					>
						Cancel
					</button>
				</div>
			</div>
		);
	}

	// No active goal: the quiet affordance — one small pill, nothing else.
	if (!goal) {
		return (
			<div data-testid="goal-line" className="pointer-events-auto flex flex-col items-center gap-1.5">
				<button
					type="button"
					onClick={onEditStart}
					data-testid="goal-set"
					className="flex h-7 items-center rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent"
				>
					Set a goal
				</button>
			</div>
		);
	}

	// The aim line: the title (click to edit), the detail as the smaller
	// second line, and the two quiet actions on the active goal.
	return (
		<div data-testid="goal-line" className="pointer-events-auto flex flex-col items-center gap-1.5">
			<button
				type="button"
				onClick={onEditStart}
				data-testid="goal-title"
				className="max-w-xs truncate rounded-lg px-2.5 py-0.5 font-ui text-sm text-muted-foreground transition-colors hover:bg-accent"
			>
				Working toward: {goal.title}
			</button>
			{goal.detail && (
				<p className="max-w-xs truncate px-2.5 font-ui text-xs text-muted-foreground/70">{goal.detail}</p>
			)}
			<div className="flex items-center gap-1">
				<button
					type="button"
					onClick={onMarkDone}
					data-testid="goal-done"
					className="flex h-7 items-center rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent"
				>
					Mark done
				</button>
				<button
					type="button"
					onClick={onClear}
					data-testid="goal-clear"
					className="flex h-7 items-center rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent"
				>
					Clear
				</button>
			</div>
		</div>
	);
}

export function MinimalHome({
	chainSelectOpen = false,
	practiceSelection,
	onPracticeSelectionChange,
	onChainSelectClose,
}: {
	/** The lifted pick set drives the overlay's select mode (Done instead
	 * of the delete fence); the chip in home's composer reflects it. */
	chainSelectOpen?: boolean;
	practiceSelection?: ReadonlySet<string>;
	onPracticeSelectionChange?: (nodes: { id: string; name: string; statement: string }[]) => void;
	onChainSelectClose?: () => void;
}) {
	const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
	const [costs, setCosts] = useState<GraphCostSummary | null>(null);
	const [chats, setChats] = useState<ChatSummary[]>([]);
	const [chainsOpen, setChainsOpen] = useState(false);
	// REVIEW LEDGER (feature ①): the same read the graph view makes — the
	// folded per-node states, refreshed on mount + every graph data reload
	// (a cheap refetch, never a poll; cosmetic — the band just stays quiet
	// when the read fails).
	const [reviewStates, setReviewStates] = useState<NodeReviewState[]>([]);
	// TOPICS (topics v1): the membership list behind the fold's by-topic
	// breakdown; refreshed on mount + the topics-changed event (the graph
	// view's refreshTopics cadence).
	const [topics, setTopics] = useState<TopicWithStats[]>([]);
	// PRACTICE SELECT, local flip (feature ①): home's chainSelectOpen owns
	// the composer-side select-mode flag and only flows DOWN as a prop —
	// Start review needs to flip the overlay into select mode from inside,
	// so the surface keeps its own flag with identical effect (the graph
	// view reaches the same state through the onOpenPracticeSelect prop
	// this surface's contract lacks).
	const [practiceSelectOpen, setPracticeSelectOpen] = useState(false);
	// THE GOAL (feature ②): the goals list from /api/goals — only the
	// ACTIVE one (status "active") is ever displayed here. The editor's
	// drafts live up here too (GoalBand stays a pure body); opened empty
	// for a new goal, prefilled from the active goal for an edit.
	const [goals, setGoals] = useState<Goal[]>([]);
	const [goalEditing, setGoalEditing] = useState(false);
	const [goalDraftTitle, setGoalDraftTitle] = useState("");
	const [goalDraftDetail, setGoalDraftDetail] = useState("");

	const readState = useCallback(() => {
		fetch("/api/graph")
			.then((res) => res.json() as Promise<GraphSnapshot>)
			.then(setSnapshot)
			.catch(() => {});
		fetch("/api/graph/costs")
			.then((res) => res.json() as Promise<GraphCostSummary>)
			.then(setCosts)
			.catch(() => {});
		fetch("/api/chats")
			.then((res) => res.json() as Promise<{ chats: ChatSummary[] }>)
			.then((body) => setChats(body.chats))
			.catch(() => {});
		fetch("/api/graph/reviews")
			.then((res) => res.json() as Promise<{ states: NodeReviewState[]; due: string[] }>)
			.then((d) => setReviewStates(d.states ?? []))
			.catch(() => {}); // cosmetic — the band just stays hidden
	}, []);
	// The topics read mirrors the graph view's refreshTopics verbatim (its
	// own cadence — the topics-changed event, not graph revisions).
	const refreshTopics = useCallback(() => {
		fetch("/api/topics")
			.then((res) => res.json() as Promise<{ topics: TopicWithStats[] }>)
			.then((body) => setTopics(body.topics))
			.catch(() => {});
	}, []);
	useEffect(() => {
		refreshTopics();
		const onChanged = () => refreshTopics();
		window.addEventListener("lh:topics-changed", onChanged);
		return () => window.removeEventListener("lh:topics-changed", onChanged);
	}, [refreshTopics]);
	useEffect(() => {
		readState();
		window.addEventListener("lh:graph-revision", readState);
		return () => window.removeEventListener("lh:graph-revision", readState);
	}, [readState]);
	// The goals read (feature ②) mirrors the Today band's cadence exactly:
	// mount + lh:graph-revision (a cheap refetch, never a poll; cosmetic —
	// the affordance just stays at "Set a goal" when the read fails). The
	// mutations below re-run it after every write.
	const refreshGoals = useCallback(() => {
		fetch("/api/goals")
			.then((res) => res.json() as Promise<{ goals: Goal[] }>)
			.then((body) => setGoals(body.goals ?? []))
			.catch(() => {});
	}, []);
	useEffect(() => {
		refreshGoals();
		window.addEventListener("lh:graph-revision", refreshGoals);
		return () => window.removeEventListener("lh:graph-revision", refreshGoals);
	}, [refreshGoals]);

	// The practice chip opens the table in select mode (GraphView's law):
	// the pick intent raises the overlay; Done/close reports back down.
	useEffect(() => {
		if (chainSelectOpen) setChainsOpen(true);
	}, [chainSelectOpen]);

	// Refetch even after incomplete imports: earlier writes and spend remain.
	const notesImport = useNotesImport({ onFinish: readState });
	const { importing, onImportFiles } = notesImport;

	const teachSessions = chats.filter((c) => c.kind === "teach").length;
	const practiceSessions = chats.filter((c) => c.kind === "practice").length;

	// The folded states by id — the graph view's shape for the scheduler.
	const statesById = useMemo(() => new Map(reviewStates.map((s) => [s.nodeId, s])), [reviewStates]);
	// The due set (review v1): resolved against the live snapshot so the
	// preset only ever selects REAL, present nodes — graph-view's law,
	// verbatim.
	const dueNodes = useMemo(() => {
		const props = snapshot?.propositions ?? [];
		return dueNodeIds(statesById)
			.map((id) => props.find((n) => n.id === id))
			.filter((n): n is GraphNode => n !== undefined);
	}, [statesById, snapshot]);
	// The Today fold (feature ①): dueCount + dueByTopic + struggling +
	// the minutes estimate, over the same states + present nodes the
	// preset consumes — the band's numbers can never disagree with the
	// button's selection.
	const today = useMemo(
		() => todaySummary(statesById, snapshot?.propositions ?? [], topics),
		[statesById, snapshot, topics],
	);

	// THE REVIEW-DUE PRESET (feature ①): the graph chrome's exact
	// mechanism (graph-view.tsx onReviewDue) — lift the resolved due
	// nodes into the practice selection, flip into practice-select mode,
	// and open the chain table. Home's mode switch is NOT touched (the
	// graph view doesn't either — picks ride a teach send as graph
	// context, the persistent-pick law).
	const startReview = useCallback(() => {
		onPracticeSelectionChange?.(dueNodes.map((n) => ({ id: n.id, name: n.name, statement: n.statement })));
		setPracticeSelectOpen(true);
		setChainsOpen(true);
	}, [dueNodes, onPracticeSelectionChange]);

	// THE GOAL (feature ②): the active goal is the one with status
	// "active" (the backend keeps at most one). All writes are
	// fire-and-forget like every read here — refreshGoals re-syncs after
	// each; failures just leave the band as it was.
	const activeGoal = useMemo(() => goals.find((g) => g.status === "active") ?? null, [goals]);
	const startGoalEdit = useCallback(() => {
		setGoalDraftTitle(activeGoal?.title ?? "");
		setGoalDraftDetail(activeGoal?.detail ?? "");
		setGoalEditing(true);
	}, [activeGoal]);
	const saveGoal = useCallback(() => {
		const title = goalDraftTitle.trim();
		if (!title) return;
		const detail = goalDraftDetail.trim();
		const payload = JSON.stringify(detail ? { title, detail } : { title });
		// POST when creating, PUT when the active goal is being edited.
		const req = activeGoal
			? fetch(`/api/goals/${encodeURIComponent(activeGoal.id)}`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: payload,
				})
			: fetch("/api/goals", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload });
		req.then(() => refreshGoals()).catch(() => {});
		setGoalEditing(false);
	}, [activeGoal, goalDraftTitle, goalDraftDetail, refreshGoals]);
	const cancelGoalEdit = useCallback(() => setGoalEditing(false), []);
	const markGoalDone = useCallback(() => {
		if (!activeGoal) return;
		fetch(`/api/goals/${encodeURIComponent(activeGoal.id)}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "done" }),
		})
			.then(() => refreshGoals())
			.catch(() => {});
	}, [activeGoal, refreshGoals]);
	const clearGoal = useCallback(() => {
		if (!activeGoal) return;
		fetch(`/api/goals/${encodeURIComponent(activeGoal.id)}`, { method: "DELETE" })
			.then(() => refreshGoals())
			.catch(() => {});
	}, [activeGoal, refreshGoals]);

	return (
		<div className="relative h-full">
			{/* The quiet summary — centered, biased up off the composer, with
			    the TODAY BAND (feature ①) above it: the retention surface
			    rides the same centered column (the band renders nothing when
			    there is nothing due and nobody struggling, so an empty graph
			    keeps its exact old shape). */}
			<div className="pointer-events-none flex h-full flex-col items-center justify-center gap-6 pb-40">
				{/* The goal band (feature ②) rides ABOVE the Today band: the
				    aim first, the day's status under it. It always renders
				    something (line, Set-a-goal pill, or editor), so unlike the
				    Today band it never collapses — a fresh graph shows the
				    quiet Set-a-goal pill where the due counts would be. */}
				<GoalBand
					goal={activeGoal}
					editing={goalEditing}
					draftTitle={goalDraftTitle}
					draftDetail={goalDraftDetail}
					onEditStart={startGoalEdit}
					onDraftTitle={setGoalDraftTitle}
					onDraftDetail={setGoalDraftDetail}
					onSave={saveGoal}
					onCancel={cancelGoalEdit}
					onMarkDone={markGoalDone}
					onClear={clearGoal}
				/>
				<TodayBand
					dueCount={today.dueCount}
					strugglingCount={today.struggling.length}
					minutesEstimate={today.minutesEstimate}
					onStartReview={startReview}
				/>
				<KnowledgeSummary
					propositions={snapshot?.propositions.length ?? 0}
					chains={snapshot?.chains.length ?? 0}
					teachSessions={teachSessions}
					practiceSessions={practiceSessions}
					importedNotes={Object.keys(snapshot?.fileSources ?? {}).length}
				/>
			</div>

			{/* The chrome survivors in the graph view's own places (owner,
			    2026-10-06): the top-right column — actions row (Chains +
			    Import, the same 36px band pills), the cost pill BELOW it.
			    The column carries lh-no-drag EXACTLY like the graph
			    chrome's (the DOM-order mask law): without it the drag band
			    swallows the clicks in Electron — the buttons dragged the
			    window instead. Node search and the render-settings gear are
			    canvas things and stay gone; Import ALWAYS renders (the
			    entry law). */}
			<div className="lh-no-drag lh-wco-floating absolute right-2 top-2 z-10 flex max-w-[calc(100%-5.5rem)] flex-col items-end gap-2">
				<div className="flex min-w-0 items-start gap-2">
					<div className="graph-chrome-fade-in shrink-0 rounded-xl border bg-card/85 px-1 py-[3px] shadow-lg backdrop-blur">
						<Hint label="Every reasoning chain" side="bottom">
							<button
								type="button"
								onClick={() => setChainsOpen(true)}
								data-testid="open-chain-table"
								className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent"
							>
								<ListTreeIcon className="size-3" />
								Chains
							</button>
						</Hint>
					</div>
					<NotesImportControl importing={importing} onImportFiles={onImportFiles} />
				</div>
				<NotesImportErrors errors={notesImport.errors} />
				<NotesImportNotices notices={notesImport.notices} />
				{costs && costs.runs.length > 0 && <GraphCostControl costs={costs} />}
			</div>

			{/* The chain table — the STANDARD overlay, unchanged, behind its
			    button. LAST CHILD OF THE ROOT, DELIBERATELY (the graph view's
			    DOM-order drag law): app-region subtraction resolves by DOM
			    order, so a full-bleed surface covering the drag band must
			    paint after everything it covers. */}
			<ChainTableOverlay
				open={chainsOpen}
				nodes={snapshot?.propositions ?? []}
				chains={snapshot?.chains ?? []}
				sessions={snapshot?.sessions ?? {}}
				fileSources={snapshot?.fileSources ?? {}}
				onClose={() => {
					setChainsOpen(false);
					setPracticeSelectOpen(false);
					onChainSelectClose?.();
				}}
				selectMode={chainSelectOpen || practiceSelectOpen}
				controlledSelection={practiceSelection}
				onSelectionChange={(ids) => {
					// Resolve ids → nodes against the live snapshot; the
					// caller holds the pick set (count + seed).
					const props = snapshot?.propositions ?? [];
					const picked: { id: string; name: string; statement: string }[] = [];
					for (const id of ids) {
						const n = props.find((node) => node.id === id);
						if (n) picked.push({ id: n.id, name: n.name, statement: n.statement });
					}
					onPracticeSelectionChange?.(picked);
				}}
			/>
		</div>
	);
}
