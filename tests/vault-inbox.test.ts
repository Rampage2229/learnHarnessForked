/**
 * Hermetic tests for THE VAULT WATCHER (personal fork): the pure discovery
 * layer (src/server/vault-watch.ts) and its HTTP door (app/api/graph/inbox/
 * route.ts). The owner drops notes into a watched folder; the watcher
 * reports NEW or CHANGED files and the route imports them through the same
 * extraction pipeline the folder-import route uses.
 *
 * Setup mirrors tests/import-folder.test.ts: HOME + LH_DATA_DIR point at tmp
 * trees so the home-anchoring + PATHS.graph state file never touch the repo,
 * and extraction.importNotes is stubbed so no model runs.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, it } from "node:test";

// ── Hermetic setup (BEFORE the route/config modules load) ───────────────────
// resolveFolderPath expands `~` and relative paths against os.homedir()
// (reads process.env.HOME live); PATHS.graph (the watch state file's dir)
// resolves off LH_DATA_DIR at config import time. Point both at tmp trees so
// the scan + commit + traversal checks run entirely inside a throwaway home
// and never write into the repo (the import-folder.test.ts precedent).
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "lh-vault-home-"));
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "lh-vault-data-"));
process.env.HOME = tmpHome;
process.env.LH_DATA_DIR = tmpData;
process.env.LH_AUTH_FILE = path.join(tmpData, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");

// Dynamic imports AFTER env is pinned (config.ts computes PATHS at load).
const vault = await import("../src/server/vault-watch.ts");
const { scanInbox, diffInbox, listInboxFiles, readState, writeState, commitScan } = vault;
const { POST, GET, resolveFolderPath } = await import("../app/api/graph/inbox/route.ts");
const { extraction } = await import("../src/server/index.ts");
const { PATHS } = await import("../config.ts");
const { tinyPdf } = await import("./helpers/tiny-pdf.ts");

after(() => {
	fs.rmSync(tmpHome, { recursive: true, force: true });
	fs.rmSync(tmpData, { recursive: true, force: true });
});

// Stub extraction.importNotes so no model runs; restore after the file.
const originalImportNotes = extraction.importNotes;
after(() => { extraction.importNotes = originalImportNotes; });

// ── Helpers ─────────────────────────────────────────────────────────────────
/** A tmp state file per test (the watch state path the route uses is fixed;
 *  the pure functions take an arbitrary path so each test owns its state). */
function tmpStatePath(): string {
	return path.join(fs.mkdtempSync(path.join(tmpData, "state-")), "state.json");
}

/** Build an inbox tree under tmpHome with a mix of notes, a .obsidian dir, a
 *  hidden file, a wrong-extension file, a nested sub-folder, and a symlink. */
function makeInbox(): string {
	const root = path.join(tmpHome, "inbox");
	fs.rmSync(root, { recursive: true, force: true });
	fs.mkdirSync(path.join(root, "Course", "Week 1"), { recursive: true });
	fs.mkdirSync(path.join(root, "Notes"), { recursive: true });
	fs.mkdirSync(path.join(root, ".obsidian"), { recursive: true });
	fs.writeFileSync(path.join(root, "readme.md"), "# readme");
	fs.writeFileSync(path.join(root, "Course", "Week 1", "lecture.md"), "# lecture");
	fs.writeFileSync(path.join(root, "Notes", "plain.txt"), "plain text");
	fs.writeFileSync(path.join(root, "Notes", ".secret.md"), "hidden — must be skipped");
	fs.writeFileSync(path.join(root, ".obsidian", "config.md"), "vault metadata — must be skipped");
	fs.writeFileSync(path.join(root, "image.png"), "wrong extension — must be skipped");
	// A real (tiny) PDF the route can convert.
	fs.writeFileSync(path.join(root, "Course", "handout.pdf"), tinyPdf([{ runs: [{ text: "Handout page", x: 72, y: 700 }] }]));
	// A symlink to a file — must be skipped, not followed.
	fs.symlinkSync(path.join(root, "readme.md"), path.join(root, "link-to-readme.md"));
	return root;
}

/** POST helper: build a JSON Request for the inbox route. */
function request(body: unknown): Request {
	return new Request("http://localhost/api/graph/inbox", {
		method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
	});
}

/** Fetch a state record and assert it exists (noUncheckedIndexedAccess:
 *  newState[key] is T | undefined; this helper narrows it). */
function rec(state: Record<string, { mtimeMs: number; size: number; importedAt: string }>, key: string) {
	const r = state[key];
	assert.ok(r, `state record missing for ${key}`);
	return r!;
}

/** Set mtime forward (a touch that changes mtime). Some filesystems have
 *  coarse mtime resolution (1s), so sleep ~30ms then touch. */
function touchForward(file: string): void {
	const future = new Date(Date.now() + 10000);
	fs.utimesSync(file, future, future);
}

// ── listInboxFiles: the pure walk (max depth 3, hidden/dot-dir/symlink skips) ─

it("walk collects .md/.txt/.pdf to depth 3, skips dot-dirs, hidden files, symlinks, wrong extensions", () => {
	const root = makeInbox();
	const listing = listInboxFiles(root);
	const names = listing.map((e) => path.basename(e.path)).sort();
	assert.deepEqual(names, ["handout.pdf", "lecture.md", "plain.txt", "readme.md"]);
	// No hidden or dot-dir residents, no symlink, no wrong-extension file.
	assert.ok(!listing.some((e) => e.path.endsWith(".secret.md")), "hidden file skipped");
	assert.ok(!listing.some((e) => e.path.includes(".obsidian")), ".obsidian skipped");
	assert.ok(!listing.some((e) => e.path.endsWith("link-to-readme.md")), "symlink skipped");
	assert.ok(!listing.some((e) => e.path.endsWith("image.png")), "wrong extension skipped");
	// Each entry carries mtimeMs + size from a stat.
	assert.ok(listing.every((e) => e.mtimeMs > 0 && e.size > 0));
	// Absolute paths (the state key + the caller's read path).
	assert.ok(listing.every((e) => path.isAbsolute(e.path)));
});

it("max depth 3 bounds the walk: a file four levels deep is not collected", () => {
	const root = path.join(tmpHome, "deep");
	fs.rmSync(root, { recursive: true, force: true });
	// a/b/c/d/file.md is depth 4 — beyond max depth 3.
	fs.mkdirSync(path.join(root, "a", "b", "c", "d"), { recursive: true });
	fs.writeFileSync(path.join(root, "a", "b", "c", "d", "below.md"), "too deep");
	// a/b/c/file.md is depth 3 — collected.
	fs.writeFileSync(path.join(root, "a", "b", "c", "kept.md"), "kept");
	fs.writeFileSync(path.join(root, "top.md"), "depth 0");
	const listing = listInboxFiles(root);
	const names = listing.map((e) => e.path).sort();
	assert.deepEqual(names, [
		path.join(root, "a", "b", "c", "kept.md").split("/").join(path.sep),
		path.join(root, "top.md").split("/").join(path.sep),
	].sort());
	assert.ok(!names.some((n) => n.endsWith("below.md")), "depth-4 file not collected");
});

it("any dot-prefixed directory is skipped, not only .obsidian/.git/.trash", () => {
	const root = path.join(tmpHome, "dotdirs");
	fs.rmSync(root, { recursive: true, force: true });
	fs.mkdirSync(path.join(root, ".cache"), { recursive: true });
	fs.mkdirSync(path.join(root, "kept"), { recursive: true });
	fs.writeFileSync(path.join(root, ".cache", "hidden.md"), "x");
	fs.writeFileSync(path.join(root, "kept", "visible.md"), "y");
	const listing = listInboxFiles(root);
	assert.deepEqual(listing.map((e) => path.basename(e.path)), ["visible.md"]);
});

// ── diffInbox: the pure diff (no I/O) ─────────────────────────────────────────

it("diffInbox marks an absent file as NEW and a known file as unchanged", () => {
	const root = makeInbox();
	const listing = listInboxFiles(root);
	const state = readState(tmpStatePath()); // empty state
	const { newFiles, processed } = diffInbox(listing, state);
	// Empty state → every present file is NEW.
	assert.equal(newFiles.length, listing.length);
	assert.deepEqual(newFiles.sort(), listing.map((e) => e.path).sort());
	assert.equal(processed.length, listing.length);
});

it("diffInbox skips unchanged files and re-detects a CHANGED (mtime/size) file", () => {
	const root = makeInbox();
	const listing = listInboxFiles(root);
	const file = listing[0]!;
	// Put EVERY present file in the state so the unchanged case has no new files.
	const state: Record<string, { mtimeMs: number; size: number; importedAt: string }> = {};
	for (const e of listing) state[e.path] = { mtimeMs: e.mtimeMs, size: e.size, importedAt: "2026-01-01T00:00:00.000Z" };
	// Unchanged listing → no new files, all processed.
	let diff = diffInbox(listing, state);
	assert.equal(diff.newFiles.length, 0);
	assert.equal(diff.processed.length, listing.length);
	// CHANGED mtime → re-detected as new.
	const changed = { ...file, mtimeMs: file.mtimeMs + 60000 };
	diff = diffInbox([changed, ...listing.slice(1)], state);
	assert.deepEqual(diff.newFiles, [file.path]);
	// CHANGED size → re-detected as new (size is the fallback signal).
	const resized = { ...file, size: file.size + 1 };
	diff = diffInbox([resized, ...listing.slice(1)], state);
	assert.deepEqual(diff.newFiles, [file.path]);
});

it("diffInbox drops vanished files from processed (a deleted note is untracked)", () => {
	const root = makeInbox();
	const listing = listInboxFiles(root);
	const state: Record<string, { mtimeMs: number; size: number; importedAt: string }> = {};
	for (const e of listing) state[e.path] = { mtimeMs: e.mtimeMs, size: e.size, importedAt: "2026-01-01T00:00:00.000Z" };
	// Simulate a deleted file: listing shrinks to one entry.
	const survivor = listing[0]!;
	const { processed } = diffInbox([survivor], state);
	assert.deepEqual(processed, [survivor.path]);
});

// ── readState/writeState: atomic write, never throws ────────────────────────

it("writeState writes atomically and readState reads it back", () => {
	const sp = tmpStatePath();
	const state = { "/a/b.md": { mtimeMs: 1, size: 2, importedAt: "2026-01-01T00:00:00.000Z" } };
	writeState(sp, state);
	assert.deepEqual(readState(sp), state);
	// The state file is a JSON object (not an array).
	const raw = JSON.parse(fs.readFileSync(sp, "utf8"));
	assert.ok(!Array.isArray(raw));
	assert.deepEqual(raw, state);
});

it("readState on a missing file returns {} (never throws)", () => {
	assert.deepEqual(readState(path.join(tmpData, "no-such-dir", "state.json")), {});
});

it("readState on a corrupt file returns {} (the watcher survives a bad state)", () => {
	const sp = tmpStatePath();
	fs.writeFileSync(sp, "{ this is not json ::::");
	// Must not throw — a corrupt state is treated as "nothing tracked yet".
	assert.deepEqual(readState(sp), {});
});

it("readState on an empty file returns {} (never throws)", () => {
	const sp = tmpStatePath();
	fs.writeFileSync(sp, "");
	assert.deepEqual(readState(sp), {});
});

it("readState ignores malformed records (keeps the valid ones)", () => {
	const sp = tmpStatePath();
	const raw = {
		"/good.md": { mtimeMs: 1, size: 2, importedAt: "2026-01-01T00:00:00.000Z" },
		"/bad-mtime.md": { mtimeMs: "not-a-number", size: 2, importedAt: "2026-01-01T00:00:00.000Z" },
		"/bad-size.md": { mtimeMs: 1, size: null, importedAt: "2026-01-01T00:00:00.000Z" },
		"/bad-ts.md": { mtimeMs: 1, size: 2, importedAt: 123 },
		"/not-an-object.md": "string",
	};
	fs.writeFileSync(sp, JSON.stringify(raw));
	const state = readState(sp);
	assert.deepEqual(Object.keys(state), ["/good.md"]);
});

it("writeState never throws on an unwritable path (logs + swallows)", () => {
	// A path under a file (not a dir) cannot be created — writeState must not
	// throw; the next scan re-reads the (possibly stale) state and continues.
	const blocker = path.join(tmpData, "blocker-file");
	fs.writeFileSync(blocker, "x");
	const sp = path.join(blocker, "state.json"); // blocker is a file, not a dir
	assert.doesNotThrow(() => writeState(sp, { "/x.md": { mtimeMs: 1, size: 1, importedAt: "2026-01-01T00:00:00.000Z" } }));
});

// ── scanInbox: read state + walk + diff ──────────────────────────────────────

it("scanInbox reports all present files as NEW against an empty state", () => {
	const root = makeInbox();
	const sp = tmpStatePath();
	const { newFiles, processed } = scanInbox(root, sp);
	assert.equal(newFiles.length, 4); // readme, lecture, plain, handout
	assert.equal(processed.length, 4);
});

it("scanInbox skips unchanged files after a state write (idempotent re-scan)", () => {
	const root = makeInbox();
	const sp = tmpStatePath();
	// First scan: everything is new.
	let scan = scanInbox(root, sp);
	assert.equal(scan.newFiles.length, 4);
	// Commit the scan (mark everything imported now) + write state.
	const oldState = readState(sp);
	const newState = commitScan(scan.processed, oldState, new Set(scan.newFiles), new Date().toISOString());
	writeState(sp, newState);
	// Second scan: nothing is new (all unchanged).
	scan = scanInbox(root, sp);
	assert.equal(scan.newFiles.length, 0, "unchanged files are not re-detected");
	assert.equal(scan.processed.length, 4);
});

it("scanInbox re-detects a CHANGED file (touched mtime) after a state write", () => {
	const root = makeInbox();
	const sp = tmpStatePath();
	const scan = scanInbox(root, sp);
	const oldState = readState(sp);
	const newState = commitScan(scan.processed, oldState, new Set(scan.newFiles), new Date().toISOString());
	writeState(sp, newState);
	// Touch one file's mtime forward → it is CHANGED → re-detected as new.
	const readme = path.join(root, "readme.md");
	touchForward(readme);
	const scan2 = scanInbox(root, sp);
	assert.equal(scan2.newFiles.length, 1);
	assert.equal(scan2.newFiles[0], readme);
	assert.equal(scan2.processed.length, 4);
});

it("scanInbox re-detects a CHANGED file (rewritten size) after a state write", () => {
	const root = makeInbox();
	const sp = tmpStatePath();
	const scan = scanInbox(root, sp);
	writeState(sp, commitScan(scan.processed, readState(sp), new Set(scan.newFiles), new Date().toISOString()));
	// Rewrite a file's content (size changes; mtime may or may not on some FS).
	fs.writeFileSync(path.join(root, "Notes", "plain.txt"), "plain text but longer now — more bytes");
	const scan2 = scanInbox(root, sp);
	assert.equal(scan2.newFiles.length, 1);
	assert.equal(scan2.newFiles[0], path.join(root, "Notes", "plain.txt"));
});

it("scanInbox re-detects a newly added file after a state write", () => {
	const root = makeInbox();
	const sp = tmpStatePath();
	const scan = scanInbox(root, sp);
	writeState(sp, commitScan(scan.processed, readState(sp), new Set(scan.newFiles), new Date().toISOString()));
	// Drop a new note into the inbox.
	fs.writeFileSync(path.join(root, "new-note.md"), "# brand new");
	const scan2 = scanInbox(root, sp);
	assert.equal(scan2.newFiles.length, 1);
	assert.equal(scan2.newFiles[0], path.join(root, "new-note.md"));
	assert.equal(scan2.processed.length, 5);
});

it("scanInbox skips hidden/.obsidian files (the walk's filter, via the scan)", () => {
	const root = makeInbox();
	const sp = tmpStatePath();
	const { newFiles, processed } = scanInbox(root, sp);
	assert.ok(!newFiles.some((f) => f.endsWith(".secret.md")), "hidden file skipped");
	assert.ok(!newFiles.some((f) => f.includes(".obsidian")), ".obsidian skipped");
	assert.ok(!processed.some((f) => f.endsWith("image.png")), "wrong extension skipped");
	assert.ok(!processed.some((f) => f.endsWith("link-to-readme.md")), "symlink skipped");
});

// ── commitScan: the post-import state ───────────────────────────────────────

it("commitScan stamps importedNow with the current time; a NEW-but-failed file is left out", () => {
	const root = makeInbox();
	const sp = tmpStatePath();
	const scan = scanInbox(root, sp);
	const oldState = readState(sp); // empty
	const now = "2026-05-05T05:05:05.000Z";
	// Import only the readme; the other 3 are NEW but not imported (failed).
	const readme = path.join(root, "readme.md");
	const importedNow = new Set<string>([readme]);
	const newState = commitScan(scan.processed, oldState, importedNow, now);
	// The imported file's importedAt is `now`, with a real stat.
	const readmeRec = rec(newState, readme);
	assert.equal(readmeRec.importedAt, now);
	assert.ok(readmeRec.mtimeMs > 0 && readmeRec.size > 0);
	// The NEW-but-not-imported files are LEFT OUT so the next scan retries them.
	assert.equal(Object.keys(newState).length, 1, "only the imported file is committed");
	for (const f of scan.processed) {
		if (f === readme) continue;
		assert.ok(!newState[f], `failed file ${f} left out of the state to retry`);
	}
});

it("commitScan preserves the prior importedAt for unchanged, already-tracked files", () => {
	const root = makeInbox();
	const sp = tmpStatePath();
	const scan = scanInbox(root, sp);
	const prior = "2026-01-01T00:00:00.000Z";
	const oldState = commitScan(scan.processed, {}, new Set(scan.processed), prior);
	writeState(sp, oldState);
	// Second scan: nothing new. Commit with a different `now`; the unchanged
	// files keep their prior importedAt.
	const scan2 = scanInbox(root, sp);
	const now = "2026-06-06T06:06:06.000Z";
	const newState = commitScan(scan2.processed, oldState, new Set(), now);
	for (const f of scan2.processed) {
		assert.equal(rec(newState, f).importedAt, prior, `prior importedAt preserved for ${f}`);
	}
});

it("commitScan drops a vanished file from the state (deleted note is untracked)", () => {
	const root = makeInbox();
	const sp = tmpStatePath();
	const scan = scanInbox(root, sp);
	const oldState = commitScan(scan.processed, {}, new Set(scan.processed), new Date().toISOString());
	writeState(sp, oldState);
	// Delete a file; the next commit's `processed` no longer contains it.
	fs.rmSync(path.join(root, "readme.md"));
	const scan2 = scanInbox(root, sp);
	const newState = commitScan(scan2.processed, oldState, new Set(), new Date().toISOString());
	assert.ok(!newState[path.join(root, "readme.md")], "vanished file dropped from state");
	assert.equal(Object.keys(newState).length, scan2.processed.length);
});

// ── resolveFolderPath: home-anchoring (the fs-tools rule, duplicated) ─────────

it("~ expands to home and a relative path resolves under home", () => {
	const inbox = makeInbox();
	assert.equal(resolveFolderPath("~/inbox"), inbox);
	assert.equal(resolveFolderPath("inbox"), inbox);
});

it("an absolute path OUTSIDE home is refused (path traversal bound)", () => {
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "lh-vault-outside-"));
	after(() => fs.rmSync(outside, { recursive: true, force: true }));
	assert.throws(() => resolveFolderPath(outside), /outside your home folder/);
});

it("a missing path fails closed with a readable message", () => {
	assert.throws(() => resolveFolderPath("~/no-such-folder"), /Could not open/);
});

// ── POST dryRun: the scan listing over the wire ───────────────────────────────

it("POST dryRun lists NEW files against an empty state with totals, no results", async () => {
	makeInbox();
	const response = await POST(request({ dir: "~/inbox", dryRun: true }));
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.ok(Array.isArray(body.files));
	assert.equal(body.files.length, 4); // readme, lecture, plain, handout
	assert.equal(body.tracked, 4);
	assert.ok(!("results" in body), "dry-run never returns per-file results");
	// Folder-relative POSIX paths (the extraction identity contract).
	const paths = (body.files as { path: string }[]).map((f) => f.path).sort();
	assert.deepEqual(paths, [
		"Course/Week 1/lecture.md",
		"Course/handout.pdf",
		"Notes/plain.txt",
		"readme.md",
	]);
	// kind is known by extension for the listing.
	const handout = (body.files as { path: string; kind: string }[]).find((f) => f.path === "Course/handout.pdf")!;
	assert.equal(handout.kind, "pdf");
});

it("POST dryRun after the state is committed lists only NEW-or-CHANGED files", async () => {
	const root = makeInbox();
	// First, run a real import to populate the watch state (the route's
	// WATCH_STATE_FILE under PATHS.graph). Stub extraction so it succeeds.
	const seen: string[] = [];
	extraction.importNotes = async ({ filePath, text }) => {
		seen.push(filePath);
		assert.ok(text.length > 0);
		return { nodes: 1, chains: 0 };
	};
	await POST(request({ dir: root, dryRun: false }));
	assert.equal(seen.length, 4);
	// Now a dry-run with no changes → no new files, tracked = 4.
	let response = await POST(request({ dir: root, dryRun: true }));
	let body = await response.json();
	assert.equal(body.files.length, 0);
	assert.equal(body.tracked, 4);
	// Touch one file → it re-appears as new in a dry-run.
	touchForward(path.join(root, "readme.md"));
	response = await POST(request({ dir: root, dryRun: true }));
	body = await response.json();
	assert.equal(body.files.length, 1);
	assert.equal(body.files[0].path, "readme.md");
});

it("POST dryRun refuses a path outside home", async () => {
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "lh-vault-outside-post-"));
	after(() => fs.rmSync(outside, { recursive: true, force: true }));
	const response = await POST(request({ dir: outside, dryRun: true }));
	assert.equal(response.status, 400);
	assert.match((await response.json()).error, /outside your home folder/);
});

it("POST requires a dir", async () => {
	const response = await POST(request({ dryRun: true }));
	assert.equal(response.status, 400);
	assert.match((await response.json()).error, /folder path/i);
});

// ── POST dryRun:false: scan + import + commit (reuse of the extraction pipeline) ─

it("dryRun:false imports each NEW file through extraction and isolates a single failing file", async () => {
	const root = path.join(tmpHome, "iso");
	fs.rmSync(root, { recursive: true, force: true });
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(path.join(root, "ok1.md"), "# ok one");
	fs.writeFileSync(path.join(root, "ok2.txt"), "ok two");
	fs.writeFileSync(path.join(root, "boom.md"), "this one throws");
	const seen: string[] = [];
	extraction.importNotes = async ({ filePath }) => {
		seen.push(filePath);
		if (filePath === "boom.md") throw new Error("synthetic file failure");
		return { nodes: 1, chains: 0 };
	};
	const response = await POST(request({ dir: root, dryRun: false }));
	assert.equal(response.status, 200);
	const { results } = await response.json();
	assert.equal(results.length, 3);
	assert.deepEqual(seen.sort(), ["boom.md", "ok1.md", "ok2.txt"].sort());
	const byPath = (p: string) => results.find((r: { filePath: string }) => r.filePath === p);
	assert.equal(byPath("ok1.md").ok, true);
	assert.equal(byPath("ok1.md").outcome, "completed");
	assert.equal(byPath("ok2.txt").ok, true);
	assert.equal(byPath("boom.md").ok, false);
	assert.equal(byPath("boom.md").outcome, "failed");
	assert.match(byPath("boom.md").error, /synthetic file failure/);
	// The failed file is NOT committed → a re-scan still sees it as new.
	const scan = scanInbox(root, path.join(PATHS.graph, "vault-watch-state.json"));
	assert.ok(scan.newFiles.some((f) => f.endsWith("boom.md")), "failed file retried on next scan");
	assert.ok(!scan.newFiles.some((f) => f.endsWith("ok1.md")), "imported file skipped on next scan");
});

it("dryRun:false commits the state so a re-run is a no-op (no new files)", async () => {
	const root = path.join(tmpHome, "commit");
	fs.rmSync(root, { recursive: true, force: true });
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(path.join(root, "a.md"), "a");
	fs.writeFileSync(path.join(root, "b.md"), "b");
	extraction.importNotes = async () => ({ nodes: 0, chains: 0 });
	await POST(request({ dir: root, dryRun: false }));
	// Second run: nothing new (state committed).
	const response = await POST(request({ dir: root, dryRun: false }));
	const { results } = await response.json();
	assert.equal(results.length, 0);
});

it("dryRun:false converts a real PDF to page-marked Markdown before extraction", async () => {
	const root = path.join(tmpHome, "pdf");
	fs.rmSync(root, { recursive: true, force: true });
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(path.join(root, "handout.pdf"), tinyPdf([{ runs: [{ text: "Handout page", x: 72, y: 700 }] }]));
	let received = "";
	extraction.importNotes = async ({ text }) => { received = text; return { nodes: 0, chains: 0 }; };
	const response = await POST(request({ dir: root, dryRun: false }));
	const { results } = await response.json();
	assert.equal(results[0].outcome, "completed");
	assert.match(received, /Handout page/);
	assert.match(results[0].notice, /Scanned pages may have errors/);
});

it("dryRun:false keeps at most three files in flight (the sibling route's cap)", async () => {
	const root = path.join(tmpHome, "concurrency");
	fs.rmSync(root, { recursive: true, force: true });
	fs.mkdirSync(root, { recursive: true });
	for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(root, `f${i}.md`), "x");
	let active = 0, peak = 0;
	extraction.importNotes = async () => {
		active++; peak = Math.max(peak, active);
		try { await new Promise((r) => setTimeout(r, 5)); return { nodes: 0, chains: 0 }; }
		finally { active--; }
	};
	await POST(request({ dir: root, dryRun: false }));
	assert.equal(peak, 3);
});

// ── GET: the watch state summary ──────────────────────────────────────────────

it("GET reports tracked=0 and lastScanAt=null before any scan", async () => {
	// Point the route at a fresh tmp data dir's state by clearing the file.
	const stateFile = path.join(PATHS.graph, "vault-watch-state.json");
	fs.rmSync(stateFile, { force: true });
	const response = await GET();
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.equal(body.tracked, 0);
	assert.equal(body.lastScanAt, null);
});

it("GET reports tracked + lastScanAt after a committed import", async () => {
	const root = path.join(tmpHome, "summary");
	fs.rmSync(root, { recursive: true, force: true });
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(path.join(root, "a.md"), "a");
	fs.writeFileSync(path.join(root, "b.md"), "b");
	const before = new Date().toISOString();
	extraction.importNotes = async () => ({ nodes: 0, chains: 0 });
	await POST(request({ dir: root, dryRun: false }));
	const response = await GET();
	const body = await response.json();
	assert.equal(body.tracked, 2);
	assert.ok(body.lastScanAt >= before, "lastScanAt is the import timestamp");
});
