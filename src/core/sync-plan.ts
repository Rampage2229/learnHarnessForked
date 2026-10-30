/**
 * Sync planning (Nextcloud sync, personal fork) — the PURE decision core.
 * Given the local files, the remote files, and the last-synced state, it
 * emits the minimal set of transfer/merge/conflict/delete actions. No fs,
 * no network — the engine (src/server/sync-engine.ts) executes and then
 * re-scans both sides to record the next state.
 *
 * Resolution law (two-way, state-anchored):
 *  - whole-file JSON  → last-writer-wins by mtime; the loser is preserved
 *    as a sibling `<path>.conflict-<ts>` file (nothing silently dies).
 *  - append-only JSONL → union-merge when both sides changed (the ledgers
 *    dedupe by line content; order = local first, then remote-only lines).
 *  - deletions propagate (a local delete removes the remote copy and vice
 *    versa), UNLESS the other side edited it meanwhile — an edit wins over
 *    a delete.
 *  - a file new on both sides resolves like both-changed.
 */

export type SyncFileKind = "json" | "jsonl";

export interface SyncStamp {
	mtimeMs: number;
	size: number;
}

/** Per-path state as of the last successful sync (both sides recorded). */
export interface SyncStateEntry {
	local: SyncStamp;
	remote: SyncStamp;
}
export type SyncStateMap = Record<string, SyncStateEntry>;

export interface LocalFile {
	path: string;
	mtimeMs: number;
	size: number;
	kind: SyncFileKind;
}

export interface RemoteFile {
	path: string;
	mtimeMs: number;
	size: number;
	kind: SyncFileKind;
}

export type SyncAction =
	| { path: string; type: "upload" }
	| { path: string; type: "download" }
	| { path: string; type: "mergeJsonl" }
	/** Local wins; the remote's old content is kept as `path.conflict-<ts>`. */
	| { path: string; type: "conflictKeepLocal" }
	/** Remote wins; the local's old content is kept as `path.conflict-<ts>`. */
	| { path: string; type: "conflictKeepRemote" }
	| { path: string; type: "deleteRemote" }
	| { path: string; type: "deleteLocal" };

export function planSync(input: {
	local: readonly LocalFile[];
	remote: readonly RemoteFile[];
	state: SyncStateMap;
}): SyncAction[] {
	const localMap = new Map(input.local.map((f) => [f.path, f]));
	const remoteMap = new Map(input.remote.map((f) => [f.path, f]));
	const paths = new Set([...localMap.keys(), ...remoteMap.keys(), ...Object.keys(input.state)]);
	const actions: SyncAction[] = [];

	// DEGENERATE-LISTING INTERLOCK: if the state tracked files that are
	// missing from BOTH current listings, one side's listing is broken
	// (a throttled/proxy server returning an empty multistatus, a parse
	// bug…) — executing the plan would mass-delete real data. Abort.
	const trackedButInvisible = Object.keys(input.state).filter(
		(p) => input.state[p] && !localMap.has(p) && !remoteMap.has(p),
	);
	if (trackedButInvisible.length > 0) {
		actions.push({
			path: `<${trackedButInvisible.length} tracked files missing from BOTH listings — refusing to plan (degenerate listing)>`,
			type: "deleteLocal",
		});
		return actions;
	}

	const changed = (cur: SyncStamp | null | undefined, prev: SyncStamp | undefined): boolean =>
		Boolean(cur && prev && (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size));

	for (const path of paths) {
		const l = localMap.get(path);
		const r = remoteMap.get(path);
		const s = input.state[path];
		const lc = changed(l, s?.local);
		const rc = changed(r, s?.remote);

		if (!l && !r) continue; // gone everywhere

		if (l && !r) {
			// remote missing
			if (s && !lc) actions.push({ path, type: "deleteLocal" }); // remote deleted it
			else actions.push({ path, type: "upload" }); // local new or local edited after remote delete
			continue;
		}
		if (!l && r) {
			if (s && !rc) actions.push({ path, type: "deleteRemote" }); // local deleted it
			else actions.push({ path, type: "download" }); // remote new or remote edited after local delete
			continue;
		}
		// both present
		if (!s) {
			// both created independently
			if (l!.kind === "jsonl" && r!.kind === "jsonl") actions.push({ path, type: "mergeJsonl" });
			else actions.push(l!.mtimeMs > r!.mtimeMs ? { path, type: "conflictKeepLocal" } : { path, type: "conflictKeepRemote" });
			continue;
		}
		if (lc && !rc) actions.push({ path, type: "upload" });
		else if (!lc && rc) actions.push({ path, type: "download" });
		else if (lc && rc) {
			if (l!.kind === "jsonl" && r!.kind === "jsonl") actions.push({ path, type: "mergeJsonl" });
			else actions.push(l!.mtimeMs > r!.mtimeMs ? { path, type: "conflictKeepLocal" } : { path, type: "conflictKeepRemote" });
		}
		// neither changed → nothing
	}
	return actions;
}