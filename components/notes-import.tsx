"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type ChangeEvent } from "react";
import { WaypointsIcon } from "lucide-react";
import { Hint } from "@/components/ui/hint";
import { createNotesImportQueue, EMPTY_IMPORT_QUEUE, notesPath, type ImportQueueSnapshot } from "./notes-import-queue";
import { BROWSER_NOTICE } from "@/components/file-path-drop-zone";

export { MAX_IMPORT_BYTES } from "@/lib/notes-import-limits.ts";
export { notesPath } from "./notes-import-queue";

// ── Folder import (Obsidian / tablet vault on disk) ─────────────────────────
// The renderer cannot read an arbitrary server-side directory, so a folder
// import walks the path on the SERVER (app/api/graph/import-folder) in two
// phases: a dry-run listing for a confirmation row, then the real import.
// Progress reuses the SAME fields the per-file queue exposes (errors /
// notices / importing) so the existing NotesImportErrors / NotesImportNotices
// surface it without a second progress system — the hook merges the folder
// store's snapshot into its own (no new return keys).

export interface FolderFileEntry {
	path: string;
	size: number;
	kind: "text" | "pdf";
}
export interface FolderListing {
	files: FolderFileEntry[];
	skipped: number;
	totalBytes: number;
	truncated: boolean;
}
export interface FolderImportResult {
	filePath: string;
	ok: boolean;
	outcome: "completed" | "failed" | "partial" | "aborted" | "busy";
	stats?: { nodes: number; chains?: number; droppedChains?: number };
	error?: string;
	code?: string;
	missing?: string[];
	provider?: string;
	slots?: string[];
	notice?: string;
}

/** POST /api/graph/import-folder with dryRun:true → the listing for the
 *  confirmation row. Never reads file contents or calls models. */
export async function postFolderImportDryRun(folderPath: string): Promise<FolderListing> {
	const response = await fetch("/api/graph/import-folder", {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ path: folderPath, dryRun: true }),
	});
	let body: unknown;
	try { body = await response.json(); }
	catch { throw new Error("Invalid folder response. Check the graph before retrying."); }
	if (!response.ok) {
		const detail = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? `: ${body.error}` : "";
		throw new Error(`Folder scan failed (HTTP ${response.status})${detail}${/[.!?]$/.test(detail) ? "" : "."}`);
	}
	if (!body || typeof body !== "object" || !Array.isArray((body as FolderListing).files)) {
		throw new Error("Invalid folder response. Check the graph before retrying.");
	}
	return body as FolderListing;
}

/** POST /api/graph/import-folder with dryRun:false → per-file results through
 *  the SAME extraction pipeline the per-file route uses. */
export async function postFolderImport(folderPath: string): Promise<FolderImportResult[]> {
	const response = await fetch("/api/graph/import-folder", {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ path: folderPath, dryRun: false }),
	});
	let body: unknown;
	try { body = await response.json(); }
	catch { throw new Error("Invalid import response. Check the graph before retrying."); }
	if (!response.ok) {
		const detail = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? `: ${body.error}` : "";
		throw new Error(`Import request failed (HTTP ${response.status})${detail}${/[.!?]$/.test(detail) ? "" : "."} Check the graph before retrying.`);
	}
	if (!body || typeof body !== "object" || !Array.isArray((body as { results: FolderImportResult[] }).results)) {
		throw new Error("Invalid import response. Check the graph before retrying.");
	}
	return (body as { results: FolderImportResult[] }).results;
}

/** A folder result → the SAME per-file error line format the queue emits, so
 *  the existing NotesImportErrors / NotesImportNotices render it unchanged. */
function folderResultLine(result: FolderImportResult): { error?: string; notice?: string } {
	if (result.ok) return result.notice ? { notice: `${result.filePath}: ${result.notice}` } : {};
	const details = [result.provider, result.missing?.join(", "), result.slots?.join(", ")].filter(Boolean);
	return { error: `${result.filePath}: ${result.error}${result.code ? `\n${[result.code, ...details].join(" — ")}` : ""}` };
}

function createFolderImportStore() {
	const listeners = new Set<() => void>();
	let errors: string[] = [];
	let notices: string[] = [];
	let importing = false;
	let completion = 0;
	const snapshot: ImportQueueSnapshot = { importing: false, errors: [], notices: [], completion: 0 };
	const onStartRef = { current: () => {} };
	const publish = (completed: boolean) => {
		snapshot.importing = importing;
		snapshot.errors = errors;
		snapshot.notices = notices;
		snapshot.completion = completion + Number(completed);
		if (completed) completion = snapshot.completion;
		for (const listener of [...listeners]) listener();
	};
	return {
		getSnapshot: () => snapshot,
		subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
		setCallbacks(onStart: () => void) { onStartRef.current = onStart; },
		async run(folderPath: string): Promise<void> {
			importing = true; errors = []; notices = []; publish(false);
			onStartRef.current();
			try {
				const results = await postFolderImport(folderPath);
				const errs: string[] = [];
				const nts: string[] = [];
				for (const result of results) {
					const line = folderResultLine(result);
					if (line.error) errs.push(line.error);
					if (line.notice) nts.push(line.notice);
				}
				errors = errs; notices = nts;
			} catch (error) {
				errors = [error instanceof Error ? error.message : String(error)];
			} finally {
				importing = false;
				publish(true);
			}
		},
	};
}
const pageFolderImport = createFolderImportStore();

// Transport-only types: never import the server's extraction/agent module here.
export interface NotesImportResult {
	requestIndex: number;
	filePath: string;
	ok: boolean;
	outcome: "completed" | "failed" | "partial" | "aborted" | "busy";
	stats?: { nodes: number; chains?: number; droppedChains?: number };
	error?: string;
	code?: string;
	missing?: string[];
	provider?: string;
	slots?: string[];
	notice?: string;
}

/** Contributor's strict attribution: validate the complete response before
 * applying any row, even when several files have identical basenames. */
export function parseNotesImportResults(body: unknown, files: readonly File[]): NotesImportResult[] {
	const invalid = () => new Error("Invalid import response. Check the graph before retrying.");
	if (!body || typeof body !== "object" || !("results" in body) || !Array.isArray(body.results) || body.results.length !== files.length) throw invalid();
	const seen = new Set<number>();
	for (const raw of body.results) {
		if (!raw || typeof raw !== "object") throw invalid();
		const r = raw as NotesImportResult;
		if (!Number.isInteger(r.requestIndex) || r.requestIndex < 0 || r.requestIndex >= files.length || seen.has(r.requestIndex) || r.filePath !== notesPath(files[r.requestIndex]!)) throw invalid();
		seen.add(r.requestIndex);
		if (!["completed", "failed", "partial", "aborted", "busy"].includes(r.outcome) || typeof r.ok !== "boolean" || r.ok !== (r.outcome === "completed")) throw invalid();
		if (r.stats !== undefined && (!r.stats || typeof r.stats !== "object" || !Number.isFinite(r.stats.nodes) || r.stats.nodes < 0 || (r.stats.chains !== undefined && (!Number.isFinite(r.stats.chains) || r.stats.chains < 0)))) throw invalid();
		if (r.ok && !r.stats) throw invalid();
		if (!r.ok && typeof r.error !== "string") throw invalid();
		for (const field of ["error", "code", "provider", "notice"] as const) if (r[field] !== undefined && typeof r[field] !== "string") throw invalid();
		for (const field of ["missing", "slots"] as const) if (r[field] !== undefined && (!Array.isArray(r[field]) || !r[field]!.every((v) => typeof v === "string"))) throw invalid();
	}
	return body.results as NotesImportResult[];
}

export async function postNotesImport(files: readonly File[]): Promise<NotesImportResult[]> {
	const form = new FormData();
	for (const file of files) {
		form.append("files", file);
		form.append("paths", notesPath(file));
	}
	const response = await fetch("/api/graph/import", { method: "POST", body: form });
	let body: unknown;
	try { body = await response.json(); }
	catch { throw new Error("Invalid import response. Check the graph before retrying."); }
	if (!response.ok) {
		const detail = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? `: ${body.error}` : "";
		throw new Error(`Import request failed (HTTP ${response.status})${detail}${/[.!?]$/.test(detail) ? "" : "."} Check the graph before retrying.`);
	}
	return parseNotesImportResults(body, files);
}

// Client module singletons: shared by both home views and successive selections.
// SSR never appends Files, and uses the immutable empty server snapshot.
const pageImportQueue = createNotesImportQueue(postNotesImport);

/** Merge the per-file queue and the folder store into ONE snapshot so the
 *  hook exposes a single { errors, notices, importing } surface for both
 *  flows — folder progress reuses the existing conventions, not a second
 *  system. The merged object is replaced only when a value actually
 *  changes, so useSyncExternalStore sees a stable reference. */
const EMPTY_MERGED: ImportQueueSnapshot = { importing: false, errors: [], notices: [], completion: 0 };
function createMergedImportStore() {
	const listeners = new Set<() => void>();
	let merged: ImportQueueSnapshot = EMPTY_MERGED;
	const recompute = () => {
		const file = pageImportQueue.getSnapshot();
		const folder = pageFolderImport.getSnapshot();
		const next: ImportQueueSnapshot = {
			importing: file.importing || folder.importing,
			errors: [...file.errors, ...folder.errors],
			notices: [...file.notices, ...folder.notices],
			completion: file.completion + folder.completion,
		};
		// Referential stability: keep the cached object when nothing moved.
		if (
			merged.importing === next.importing &&
			merged.completion === next.completion &&
			merged.errors.length === next.errors.length && merged.errors.every((e, i) => e === next.errors[i]) &&
			merged.notices.length === next.notices.length && merged.notices.every((n, i) => n === next.notices[i])
		) return;
		merged = next;
		for (const listener of [...listeners]) listener();
	};
	const forward = () => recompute();
	pageImportQueue.subscribe(forward);
	pageFolderImport.subscribe(forward);
	return {
		getSnapshot: () => merged,
		subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
	};
}
const pageMergedImport = createMergedImportStore();

export function useNotesImport(callbacks: { onStart?: () => void; onFinish?: () => void } = {}) {
	const snapshot = useSyncExternalStore(pageMergedImport.subscribe, pageMergedImport.getSnapshot, () => EMPTY_IMPORT_QUEUE);
	const latest = useRef(callbacks);
	latest.current = callbacks;
	// Register onStart with the folder transport so folder work fires the
	// parent's onStart through the merged snapshot. onFinish is driven by the
	// merged completion counter below (same path as per-file imports).
	useEffect(() => {
		pageFolderImport.setCallbacks(() => latest.current.onStart?.());
	}, []);
	const seenCompletion = useRef(snapshot.completion);
	useEffect(() => {
		if (seenCompletion.current !== snapshot.completion) {
			seenCompletion.current = snapshot.completion;
			latest.current.onFinish?.();
		}
	}, [snapshot.completion]);
	return {
		errors: snapshot.errors, notices: snapshot.notices, importing: snapshot.importing,
		onImportFiles: (files: FileList | null) => {
			if (!files || files.length === 0) return;
			latest.current.onStart?.();
			pageImportQueue.append(Array.from(files));
		},
	};
}

/** Desktop-bridge detection (mirrors attach-files-button's useDesktopPaths):
 *  the native directory picker is Electron-only; the browser keeps the
 *  webkitdirectory Folder choice. SSR and the test env have no bridge. */
const noSubscribe = () => () => {};
function useDesktopFolderPicker(): boolean {
	return useSyncExternalStore(noSubscribe, () => Boolean(window.lh?.chooseAttachmentFolder), () => false);
}

/** Human-readable byte count for the confirmation row (e.g. 2.4MB). */
function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${bytes}B`;
}

/** PR198's shared Files / Folder native picker. Unlike the donor, it remains
 *  available while work is running; later selections join the SAME queue.
 *  Desktop adds an "Import folder…" entry that walks the chosen directory
 *  server-side (the renderer can't read arbitrary paths): a dry-run listing
 *  feeds a compact confirmation row, then the real import runs through the
 *  same useNotesImport progress surface (the merged import store). */
export function NotesImportControl({ importing, onImportFiles }: { importing: boolean; onImportFiles: (files: FileList | null) => void }) {
	const filesRef = useRef<HTMLInputElement>(null);
	const folderRef = useRef<HTMLInputElement>(null);
	const [open, setOpen] = useState(false);
	const [scanning, setScanning] = useState(false);
	const [scanError, setScanError] = useState<string | null>(null);
	const [folderPick, setFolderPick] = useState<{ path: string; listing: FolderListing } | null>(null);
	const desktop = useDesktopFolderPicker();
	const hintId = useId();
	const onChange = (event: ChangeEvent<HTMLInputElement>) => {
		onImportFiles(event.target.files);
		event.target.value = "";
	};
	const choices = [["Files", filesRef], ["Folder", folderRef]] as const;
	const chooseFolder = async () => {
		const choose = window.lh?.chooseAttachmentFolder;
		if (!choose) { setScanError(BROWSER_NOTICE); return; }
		setOpen(false);
		setScanning(true);
		setScanError(null);
		setFolderPick(null);
		try {
			const chosen = await choose();
			if (chosen === null) return; // Native cancellation leaves the menu closed.
			const listing = await postFolderImportDryRun(chosen);
			setFolderPick({ path: chosen, listing });
		} catch (error) {
			setScanError(error instanceof Error ? error.message : String(error));
		} finally { setScanning(false); }
	};
	const confirmImport = async () => {
		const pick = folderPick;
		if (!pick) return;
		setFolderPick(null);
		await pageFolderImport.run(pick.path);
	};
	const cancelImport = () => { setFolderPick(null); };
	return (
		<div className="relative shrink-0 rounded-xl border bg-card/85 px-1 py-[3px] shadow-lg backdrop-blur"
			onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
			onKeyDown={(event) => { if (event.key === "Escape") { setOpen(false); setFolderPick(null); } }}>
			<input ref={filesRef} type="file" multiple accept=".md,.markdown,.txt,.pdf" className="hidden" onChange={onChange} />
			<input ref={folderRef} type="file" {...{ webkitdirectory: "" }} className="hidden" onChange={onChange} />
			<Hint label="Extract files into the graph" side="bottom">
				<button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu" data-testid="import-notes"
					className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent">
					<WaypointsIcon className="size-3" />{importing || scanning ? "Extracting…" : "Extract files…"}
				</button>
			</Hint>
			{open && (
				<div role="menu" aria-label="Extract files into the graph" aria-describedby={hintId} className="absolute right-0 top-full z-50 mt-1 w-52 rounded-lg border bg-card p-1 shadow-lg">
					<div role="none"><p id={hintId} className="px-2 py-1.5 text-xs leading-relaxed text-muted-foreground">For lessons, attach material to a session instead.</p></div>
					{choices.map(([label, input]) => <button key={label} type="button" role="menuitem" className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-accent"
						onClick={() => { setOpen(false); input.current?.click(); }}>{label}</button>)}
					{desktop && <button type="button" role="menuitem" data-testid="import-folder"
						className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-accent" onClick={() => { void chooseFolder(); }}>Import folder…</button>}
				</div>
			)}
			{(folderPick || scanError) && (
				<div role="status" data-testid="import-folder-confirm" className="absolute right-0 top-full z-50 mt-1 w-64 rounded-lg border bg-card p-2 text-xs shadow-lg">
					{scanError ? <p className="text-red-400">{scanError}</p>
					: folderPick ? <>
						<p className="text-muted-foreground">
							Import {folderPick.listing.files.length} {folderPick.listing.files.length === 1 ? "note" : "notes"} ({formatBytes(folderPick.listing.totalBytes)})?
							{folderPick.listing.truncated && <span className="ml-1 text-amber-500">Folder capped.</span>}
						</p>
						<div className="mt-2 flex justify-end gap-1.5">
							<button type="button" data-testid="import-folder-cancel" className="rounded px-2 py-1 hover:bg-accent" onClick={cancelImport}>Cancel</button>
							<button type="button" data-testid="import-folder-confirm-import" className="rounded bg-accent px-2 py-1 font-medium hover:bg-accent/80" onClick={() => { void confirmImport(); }}>Import</button>
						</div>
					</> : null}
				</div>
			)}
		</div>
	);
}

export function NotesImportErrors({ errors }: { errors: readonly string[] }) {
	return <>{errors.map((error, i) => <p key={i} role="alert" className="max-w-full whitespace-pre-wrap break-words text-xs text-red-400">{error}</p>)}</>;
}
export function NotesImportNotices({ notices }: { notices: readonly string[] }) {
	return <>{notices.map((notice, i) => <p key={i} role="status" className="max-w-full whitespace-pre-wrap break-words text-xs text-muted-foreground">{notice}</p>)}</>;
}
