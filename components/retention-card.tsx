"use client";

import { useState } from "react";
import { XIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The retention surface (retention wave, personal fork): the Goal band +
 * streak + Today band trio as ONE overlay card, rendered on the GRAPH VIEW
 * (the home the owner actually lives on — rendering ON means the quiet
 * MinimalHome never shows, and the retention surface was invisible).
 *
 * Composition law: the SAME components MinimalHome renders (GoalBand/
 * StreakBadge/TodayBand arrive as props/children), wrapped in a card that
 * floats top-center under the header. Dismissible per mount (X, or
 * localStorage "off" persisted) — the graph is the workspace; the card
 * must never feel bolted on.
 *
 * Data wiring stays in the caller (MinimalHome owns the fetches — the
 * graph view receives the resolved bands as children).
 */

export function RetentionCard({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	const [dismissed, setDismissed] = useState(() => {
		try {
			return window.localStorage.getItem("lh:retention-card-dismissed") === "1";
		} catch {
			return false;
		}
	});
	if (dismissed) return null;
	return (
		<div
			data-testid="retention-card"
			className={cn(
				// Top-center under the header, above the canvas (the chrome
				// column's z band); pointer-events for the card itself, none
				// for the wrapper (the canvas stays draggable around it).
				"absolute left-1/2 top-14 z-20 w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2",
				"rounded-2xl border bg-card/90 p-4 shadow-lg backdrop-blur",
				"pointer-events-auto flex flex-col items-center gap-3",
				className,
			)}
		>
			<button
				type="button"
				data-testid="retention-card-dismiss"
				aria-label="Dismiss the Today card"
				onClick={() => {
					setDismissed(true);
					try {
						window.localStorage.setItem("lh:retention-card-dismissed", "1");
					} catch {
						/* private mode — dismiss for this mount only */
					}
				}}
				className="absolute right-2 top-2 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				<XIcon className="size-3.5" />
			</button>
			{children}
		</div>
	);
}
