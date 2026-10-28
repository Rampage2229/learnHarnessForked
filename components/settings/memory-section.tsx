"use client";
/**
 * The Memory section (memory v1, personal fork): the learner's standing
 * context — arbitrary plain-text notes ("my mandarin audio lives in
 * ~/docs/mandarin") that every teaching agent (prober, teacher, practice)
 * receives as the final system-prompt segment, rendered per turn by
 * src/server/memory.ts. NOT a UserSettings record section: like the Keys
 * section it is self-fetching — GET/POST /api/memory, DELETE
 * /api/memory/:id, a re-fetch after every write, and a
 * notifySettingsSaved("memory") announce (the "keys" semantics: after
 * add AND delete).
 *
 * Owner rulings carried in: plain text only (the knowledge graph stays
 * the home of formal propositions); the add gate is the store's (empty /
 * oversized → the 400 body lands inline); rows carry the created date +
 * Delete; the empty state is honest and muted.
 */

import { useEffect, useState } from "react";
import type { MemoryEntry } from "@/src/core";
import { SettingsSection } from "./controls.tsx";
import { notifySettingsSaved } from "@/components/settings-signal";

/** The entries list — pure, exported for the SSR tests (fetch state never
 *  exists under renderToStaticMarkup, so the render tests drive this
 *  directly). Empty → the muted empty state; otherwise one row per entry
 *  in the GET order (newest first). */
export function MemoryList({
	entries,
	onDelete,
}: {
	entries: readonly MemoryEntry[];
	onDelete: (id: string) => void;
}) {
	if (entries.length === 0) {
		return (
			<p data-testid="memory-empty" className="px-1 text-xs text-muted-foreground/70">
				No memories yet.
			</p>
		);
	}
	return (
		<div className="flex flex-col gap-1">
			{entries.map((entry) => (
				<div
					key={entry.id}
					data-testid={`memory-${entry.id}-row`}
					className="flex items-start justify-between gap-3 rounded-sm px-1 py-1.5"
				>
					<span className="min-w-0 whitespace-pre-wrap break-words font-prose text-(length:--lh-prose-size)">
						{entry.text}
					</span>
					<span className="flex shrink-0 items-center gap-2 pt-0.5">
						<span className="font-mono text-[11px] text-muted-foreground">{entry.createdAt.slice(0, 10)}</span>
						<button
							type="button"
							data-testid={`memory-${entry.id}-delete`}
							onClick={() => onDelete(entry.id)}
							className="shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-red-500 hover:underline"
						>
							Delete
						</button>
					</span>
				</div>
			))}
		</div>
	);
}

export function MemorySection() {
	const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
	const [loading, setLoading] = useState(true);
	const [draft, setDraft] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const reload = () =>
		fetch("/api/memory")
			.then((r) => r.json())
			.then((body: { entries?: MemoryEntry[] }) => setEntries(body.entries ?? []))
			.catch(() => setEntries([]))
			.finally(() => setLoading(false));

	useEffect(() => {
		void reload();
	}, []);

	async function add() {
		if (!draft.trim() || busy) return;
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/memory", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text: draft }),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				setError(body.error ?? `Save failed (${res.status})`);
				return;
			}
			setDraft("");
			await reload();
			notifySettingsSaved("memory");
		} finally {
			setBusy(false);
		}
	}

	async function remove(id: string) {
		await fetch(`/api/memory/${id}`, { method: "DELETE" }).catch(() => undefined);
		await reload();
		notifySettingsSaved("memory");
	}

	if (loading || entries === null) {
		return <p className="px-6 py-5 text-xs text-muted-foreground/70">Loading memories…</p>;
	}

	return (
		<SettingsSection
			title="Memory"
			hint="Standing context every teaching agent sees — files, preferences, background. Plain text."
			testid="section-memory"
		>
			<div className="flex flex-col gap-1">
				<textarea
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					placeholder="e.g. my mandarin audio lives in ~/docs/mandarin"
					aria-label="New memory"
					data-testid="memory-new-input"
					rows={2}
					className="resize-y rounded-sm border border-border bg-background px-1.5 py-1 font-ui text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50"
				/>
				<button
					type="button"
					onClick={() => void add()}
					disabled={busy || !draft.trim()}
					data-testid="memory-new-save"
					className="self-start text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline"
				>
					Save
				</button>
				{error && (
					<p role="alert" data-testid="memory-new-error" className="px-1 text-xs text-red-500">
						{error}
					</p>
				)}
			</div>
			<MemoryList entries={entries} onDelete={(id) => void remove(id)} />
		</SettingsSection>
	);
}
