/**
 * THE VAULT WATCHER (personal fork) — auto-import notes dropped into a
 * folder. The owner writes on a tablet; Nextcloud syncs the PDFs/Markdown
 * to disk. This module is the watch's PURE-ish discovery layer: it walks a
 * server-side inbox, compares it against a persisted state JSON, and
 * reports which files are NEW or CHANGED since the last import. It does
 * NOT do the extraction — the caller (app/api/graph/inbox/route.ts) imports
 * the returned list through the SAME pipeline the folder-import route uses.
 *
 * Scope contract (the task): this is a SERVER MODULE, not a route. It has
 * no Next handler; it is imported by app/api/graph/inbox/route.ts and by
 * tests/vault-inbox.test.ts. It touches no agent/core code and no existing
 * route — the only shared primitive is IMPORT_EXTENSIONS from
 * lib/notes-import-limits (the import contract).
 *
 * State shape: a JSON object mapping each tracked file's ABSOLUTE path to
 *   { mtimeMs: number, size: number, importedAt: string }
 * A file is NEW (not in state) or CHANGED (mtimeMs or size differ). Both
 * surface in `newFiles` for the caller to import. The state is written
 * atomically (write-rename) and readState/writeState NEVER throw — a
 * missing/corrupt/empty state is treated as "nothing tracked yet" so a
 * single bad state file can never brick the watcher.
 *
 * Walk depth: ONE level by default (the task), plus one nested level for an
 * Obsidian vault's sub-folder (max depth 3). Hidden / dot-directories
 * (.obsidian, .git, .trash, any `.`-prefix) and hidden files are skipped,
 * mirroring the folder-import route's `isHiddenName` rule. Symlinks are
 * NOT followed (the fs tools' rule, duplicated from import-folder).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { IMPORT_EXTENSIONS } from "@/lib/notes-import-limits.ts";

// ── Caps (watch-specific) ────────────────────────────────────────────────────
/** Never walk deeper than this many directory levels below the inbox root.
 *  depth 0 = root's direct files; the walker enters subdirs at depth+1. The
 *  task allows one level plus one nested level — 3 covers a root file, a
 *  sub-folder, and one sub-sub-folder (an Obsidian vault's typical shape). */
export const MAX_WATCH_DEPTH = 3;
/** Belt-and-braces alongside the dot-prefix rule (mirrors import-folder). */
const SKIPPED_DOT_DIRS = new Set([".obsidian", ".git", ".trash"]);

// ── State ───────────────────────────────────────────────────────────────────

/** One tracked file's persisted record. `importedAt` is the ISO timestamp
 *  the file was last successfully imported (its identity marker); mtimeMs
 *  and size detect a CHANGED file on the next scan. */
export interface VaultFileState {
	mtimeMs: number;
	size: number;
	importedAt: string;
}

/** The persisted state: absolute path → record. Stored as a JSON object;
 *  never an array (O(1) lookup, stable key order on write). */
export type VaultWatchState = Record<string, VaultFileState>;

/** A single file discovered by the walk — the pure listing `diffInbox`
 *  consumes. `path` is the ABSOLUTE path (the state key + the caller's
 *  read path); `mtimeMs`/`size` come from a stat. */
export interface VaultListingEntry {
	path: string;
	mtimeMs: number;
	size: number;
}

// ── State I/O (atomic write, never throws) ───────────────────────────────────

/** Read the watch state. NEVER throws: a missing, empty, or corrupt file is
 *  treated as "nothing tracked yet" (returns `{}`). This is deliberate — a
 *  single bad state write (a crashed atomic rename, a half-written JSON)
 *  must never brick the watcher; the next scan just re-imports everything,
 *  which is safe (the extraction pipeline is idempotent per file path). */
export function readState(statePath: string): VaultWatchState {
	try {
		const raw = fs.readFileSync(statePath, "utf8");
		if (!raw) return {};
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const out: VaultWatchState = {};
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (value && typeof value === "object" && !Array.isArray(value)) {
				const rec = value as Record<string, unknown>;
				// Require the RAW values to be the right type — `Number(null)` is 0
				// (finite!), and `Number("5")` coerces, so a malformed record that
			// would silently round-trip is rejected instead.
				const mtimeRaw = rec.mtimeMs;
				const sizeRaw = rec.size;
				const importedAt = rec.importedAt;
				if (typeof mtimeRaw === "number" && Number.isFinite(mtimeRaw)
					&& typeof sizeRaw === "number" && Number.isFinite(sizeRaw)
					&& typeof importedAt === "string") {
					out[key] = { mtimeMs: mtimeRaw, size: sizeRaw, importedAt };
				}
			}
		}
		return out;
	} catch {
		return {};
	}
}

/** Write the watch state ATOMICALLY (write to a temp file, fsync, rename over
 *  the target). NEVER throws: a write failure is logged to stderr and
 *  swallowed — the next scan re-reads the (possibly stale) state and
 *  continues, never crashing the caller. The rename is the durability
 *  commit; a reader never sees a half-written file. */
export function writeState(statePath: string, state: VaultWatchState): void {
	try {
		const dir = path.dirname(statePath);
		fs.mkdirSync(dir, { recursive: true });
		const tmp = `${statePath}.${process.pid}.${Date.now()}.tmp`;
		const data = JSON.stringify(state, null, "\t") + "\n";
		const fd = fs.openSync(tmp, "w");
		try {
			fs.writeFileSync(fd, data);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(tmp, statePath);
	} catch (err) {
		// Never throw: a corrupt/locked state file must not crash the watcher.
		// The next scan re-reads the (possibly stale) state and continues.
		console.error(`[vault-watch] could not write state ${statePath}:`, err);
	}
}

// ── The walk (pure-ish; exported for testing) ────────────────────────────────

/** True for a path segment the walk skips: a dot-directory (vault metadata)
 *  or a hidden file. Mirrors import-folder's isHiddenName. */
function isHiddenName(name: string): boolean {
	return name.length > 0 && name.startsWith(".");
}

/** Walk `root` and collect importable notes files up to `maxDepth` levels.
 *  Synchronous on purpose: a scan must be deterministic and fast. Symlinks
 *  are NOT followed (the fs tools' rule, duplicated from import-folder); a
 *  symlinked directory is skipped, not entered. Unreadable directories are
 *  skipped but the walk continues over siblings. Caps are enforced as the
 *  walk proceeds.
 *
 *  Returns ABSOLUTE paths (the state key + the caller's read path). The
 *  caller derives the folder-relative path for the extraction pipeline's
 *  source identity. */
export function listInboxFiles(
	root: string,
	opts: { maxDepth?: number } = {},
): VaultListingEntry[] {
	const maxDepth = opts.maxDepth ?? MAX_WATCH_DEPTH;
	const out: VaultListingEntry[] = [];
	const walk = (dir: string, depth: number): void => {
		if (depth > maxDepth) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return; // unreadable directory: skip, keep walking siblings.
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			// Never follow symlinks (the fs tools' rule); a symlinked dir/file
			// is skipped, not entered.
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				// Dot-directories (.obsidian, .git, .trash, any `.`-prefix) hold
				// vault metadata, not notes; the named skips are belt-and-braces.
				if (isHiddenName(entry.name) || SKIPPED_DOT_DIRS.has(entry.name)) continue;
				walk(full, depth + 1);
				continue;
			}
			if (!entry.isFile()) continue; // sockets, fifos, devices, etc.
			// Hidden files (.DS_Store, .gitignore, …) are skipped; the root
			// itself is exempt, but every file under it is filtered.
			if (isHiddenName(entry.name)) continue;
			// Extension filter — the same regex the import routes accept.
			if (!IMPORT_EXTENSIONS.test(entry.name)) continue;
			let stat: fs.Stats;
			try { stat = fs.statSync(full); }
			catch { continue; } // vanished between readdir and stat
			if (!stat.isFile()) continue;
			out.push({ path: full, mtimeMs: stat.mtimeMs, size: stat.size });
		}
	};
	walk(root, 0);
	return out;
}

// ── The pure diff (exported for testing without I/O) ─────────────────────────

/** Pure diff: given a fresh listing and the old state, split the listing
 *  into NEW-or-CHANGED files (`newFiles`) and the full set of currently-
 *  present valid files (`processed`). A file is NEW (absent from state) or
 *  CHANGED (mtimeMs or size differ from the state record); both surface in
 *  `newFiles` for the caller to import. `processed` is EVERY listing path
 *  (new and unchanged) — the universe the state should cover after this
 *  scan, so the caller can drop stale records for files that vanished. */
export function diffInbox(
	listing: readonly VaultListingEntry[],
	state: VaultWatchState,
): { newFiles: string[]; processed: string[] } {
	const newFiles: string[] = [];
	const processed: string[] = [];
	for (const entry of listing) {
		processed.push(entry.path);
		const prev = state[entry.path];
		if (!prev) {
			newFiles.push(entry.path);
			continue;
		}
		// CHANGED: mtimeMs or size differ. mtimeMs is the primary signal
		// (a re-saved file); size is the fallback (a rewritten file may
		// keep its mtime on some filesystems — size catches a content
		// swap the touch would miss).
		if (prev.mtimeMs !== entry.mtimeMs || prev.size !== entry.size) {
			newFiles.push(entry.path);
		}
	}
	return { newFiles, processed };
}

// ── The scan (read state + walk + diff) ──────────────────────────────────────

/** One scan result. `newFiles` are the ABSOLUTE paths the caller should
 *  import (NEW or CHANGED since the last scan). `processed` are the
 *  ABSOLUTE paths of every currently-present valid file — the universe the
 *  state should cover after the caller commits this scan. The caller does
 *  NOT write the state itself; it uses `commitScan` + `writeState` after a
 *  successful import. */
export interface ScanResult {
	newFiles: string[];
	processed: string[];
}

/** Scan an inbox directory: read the persisted state, walk the directory,
 *  diff against the state, and return the NEW-or-CHANGED files plus the
 *  full currently-present set. Does NOT import and does NOT write state.
 *  The caller imports `newFiles` then calls `commitScan` + `writeState`.
 *
 *  Mirrors the folder-import route's walk (dot-dirs/hidden/symlink/extension
 *  rules) but with the watch's shallower depth (max depth 3). The state is
 *  keyed by ABSOLUTE path so a moved file is treated as a new source. */
export function scanInbox(dir: string, statePath: string): ScanResult {
	const state = readState(statePath);
	const listing = listInboxFiles(dir);
	return diffInbox(listing, state);
}

// ── Commit (build the post-import state) ────────────────────────────────────

/** Build the state to persist after a scan + import. `processed` is the
 *  scan's full currently-present set (absolute paths); `oldState` is the
 *  state read at scan time; `importedNow` is the set of `processed` paths
 *  the caller ACTUALLY imported this run (the new/changed files that did
 *  not fail). The new state keeps:
 *   - every `importedNow` file, stamped with `now` + the current stat
 *     (the stat is read HERE, not at scan time, so a file rewritten
 *     between scan and commit is tracked by its post-import state);
 *   - every already-tracked, unchanged file, with its prior record verbatim
 *     (the prior importedAt is its identity marker).
 *  A file that is NEW this run but FAILED (in `processed`, not in
 *  `importedNow`, absent from `oldState`) is LEFT OUT — so the next scan
 *  retries it. A file that vanished (in `oldState` but not in `processed`)
 *  is dropped — a deleted note is no longer tracked, so a re-creation
 *  re-imports it. */
export function commitScan(
	processed: readonly string[],
	oldState: VaultWatchState,
	importedNow: ReadonlySet<string>,
	now: string,
): VaultWatchState {
	const out: VaultWatchState = {};
	for (const file of processed) {
		const prior = oldState[file];
		if (importedNow.has(file)) {
			// A freshly-imported file (or a re-import of a CHANGED file): stamp
			// `now` and record the current stat.
			let mtimeMs = 0;
			let size = 0;
			try {
				const st = fs.statSync(file);
				if (st.isFile()) { mtimeMs = st.mtimeMs; size = st.size; }
			} catch {
				// Vanished between scan and commit: keep the prior record's
				// stat if we have one, else a zero-size placeholder. The next
				// scan will drop it from `processed` and commit drops it.
				if (prior) { mtimeMs = prior.mtimeMs; size = prior.size; }
			}
			out[file] = { mtimeMs, size, importedAt: now };
			continue;
		}
		// An unchanged, already-tracked file: preserve its prior record
		// verbatim (the prior importedAt is its identity marker). A NEW file
		// that was NOT imported this run (failed or not attempted) has no
		// prior record and is left OUT — the next scan retries it.
		if (prior) out[file] = prior;
	}
	// Files in oldState but not in `processed` (deleted or moved out of the
	// inbox) are dropped from the new state — `out` only contains `processed`.
	return out;
}
