"use client";

import { useEffect, useState } from "react";

/**
 * The session recap card (feature ⑤, personal fork): the end-of-session
 * artifact at the transcript's tail — what the session built into the
 * knowledge graph and how it has held up since. Fetches
 * GET /api/chats/[id]/recap on mount; renders NOTHING while loading, on
 * failure, or when the session built no propositions (chat.tsx gates the
 * kind; this gate is the honest-render belt).
 */

/** Client-safe mirror of the recap route's response shape. */
export interface RecapProposition {
	id: string;
	statement: string;
	/** The node's last recorded review outcome — null when the ledger
	 *  holds no verdict for it ("dontKnow" folds to "wrong", the same
	 *  wrongCount discipline core/reviews.ts applies). */
	outcome: "correct" | "wrong" | "seen" | null;
	due: boolean;
}

export interface SessionRecapData {
	propositions: RecapProposition[];
	chainCount: number;
}

/** One proposition's mastery badge — the outcome chips' register
 *  (practice-cards.tsx OUTCOME_CHIP): green = solid, red = shaky, amber
 *  = due, muted = new. Priority: a wrong verdict reads Shaky even while
 *  due (Shaky says WHAT broke; Due adds nothing); a correct verdict past
 *  its review interval reads Due. */
function badge(p: RecapProposition): { label: string; className: string } {
	if (p.outcome === "wrong") return { label: "Shaky", className: "bg-red-500/15 text-red-500" };
	if (p.due) return { label: "Due", className: "bg-amber-500/15 text-amber-500" };
	if (p.outcome === "correct") return { label: "Solid", className: "bg-green-500/15 text-green-500" };
	return { label: "New", className: "bg-muted text-muted-foreground" };
}

/** Keep DOM rows honest on long statements: a hard cap, then CSS
 *  truncation handles the rest. */
function clamp(statement: string, max = 140): string {
	const s = statement.trim();
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

function noun(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** The pure card — the SSR-testable seam (the fetch wrapper renders this
 *  same JSX once data arrives). */
export function SessionRecapCard({ data }: { data: SessionRecapData }) {
	return (
		<div
			data-testid="session-recap"
			className="my-1 rounded-lg border border-border/70 px-4 py-3 text-xs text-muted-foreground"
		>
			<div className="mb-1.5 font-medium">
				Session recap — you built {noun(data.propositions.length, "proposition", "propositions")} across{" "}
				{noun(data.chainCount, "chain", "chains")}
			</div>
			<ul className="space-y-1">
				{data.propositions.map((p) => {
					const b = badge(p);
					return (
						<li key={p.id} className="flex items-center gap-2 leading-relaxed">
							<span className="min-w-0 flex-1 truncate">{clamp(p.statement)}</span>
							<span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${b.className}`}>{b.label}</span>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

/** The transcript's mount point: fetch on mount, render nothing until the
 *  recap exists AND carries propositions. */
export function SessionRecap({ chatId }: { chatId: string }) {
	const [recap, setRecap] = useState<SessionRecapData | null>(null);
	useEffect(() => {
		let live = true;
		fetch(`/api/chats/${encodeURIComponent(chatId)}/recap`)
			.then(async (res) => (res.ok ? ((await res.json()) as SessionRecapData) : null))
			.then((body) => {
				if (live) setRecap(body);
			})
			.catch(() => {
				if (live) setRecap(null);
			});
		return () => {
			live = false;
		};
	}, [chatId]);
	if (!recap || recap.propositions.length === 0) return null;
	return <SessionRecapCard data={recap} />;
}
