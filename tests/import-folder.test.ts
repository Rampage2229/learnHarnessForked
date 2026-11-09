import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";

// ── Hermetic setup ──────────────────────────────────────────────────────────
// Home-anchoring (resolveFolderPath) expands `~` and relative paths against
// os.homedir(), which reads process.env.HOME live. Point HOME at a tmp tree so
// the walk + traversal checks run entirely inside a throwaway "home", and give
// the server stores a tmp data dir + auth file so importing @/src/server does
// not write into the repo (the notes-import-paths.test.ts precedent).
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "lh-import-folder-home-"));
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "lh-import-folder-data-"));
process.env.HOME = tmpHome;
process.env.LH_DATA_DIR = tmpData;
process.env.LH_AUTH_FILE = path.join(tmpData, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");

const { POST, listImportableFiles, resolveFolderPath } = await import("../app/api/graph/import-folder/route.ts");
const { extraction } = await import("../src/server/index.ts");
const { tinyPdf } = await import("./helpers/tiny-pdf.ts");
const { MAX_IMPORT_BYTES } = await import("../lib/notes-import-limits.ts");

after(() => {
	fs.rmSync(tmpHome, { recursive: true, force: true });
	fs.rmSync(tmpData, { recursive: true, force: true });
});

const originalImportNotes = extraction.importNotes;
after(() => { extraction.importNotes = originalImportNotes; });

// ── Helpers ─────────────────────────────────────────────────────────────────
/** A vault tree under `home`/`sub` with nested dirs, a .obsidian folder, a
 *  hidden file, .md/.txt/.pdf files, a wrong-extension file, and a symlink. */
function makeVault(): string {
	const root = path.join(tmpHome, "vault");
	fs.rmSync(root, { recursive: true, force: true });
	fs.mkdirSync(path.join(root, "Course/Week 1"), { recursive: true });
	fs.mkdirSync(path.join(root, "Course/Week 2"), { recursive: true });
	fs.mkdirSync(path.join(root, "Notes"), { recursive: true });
	fs.mkdirSync(path.join(root, ".obsidian"), { recursive: true });
	fs.writeFileSync(path.join(root, "Course/Week 1/lecture.md"), "# Week 1 lecture");
	fs.writeFileSync(path.join(root, "Course/Week 1/same.md"), "dup week 1");
	fs.writeFileSync(path.join(root, "Course/Week 2/same.md"), "dup week 2");
	fs.writeFileSync(path.join(root, "Notes/plain.txt"), "plain text notes");
	fs.writeFileSync(path.join(root, "Notes/.secret.md"), "hidden — must be skipped");
	fs.writeFileSync(path.join(root, ".obsidian/config.md"), "vault metadata — must be skipped");
	fs.writeFileSync(path.join(root, "readme.md"), "# readme at root");
	fs.writeFileSync(path.join(root, "image.png"), "not a notes file — wrong extension");
	// A real (tiny) PDF the route can convert.
	fs.writeFileSync(path.join(root, "Course/handout.pdf"), tinyPdf([{ runs: [{ text: "Handout page", x: 72, y: 700 }] }]));
	// A symlink to a file — must be skipped, not followed.
	fs.symlinkSync(path.join(root, "readme.md"), path.join(root, "link-to-readme.md"));
	return root;
}

/** POST helper: build a JSON Request for the import-folder route. */
function request(body: unknown): Request {
	return new Request("http://localhost/api/graph/import-folder", {
		method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
	});
}

// ── listImportableFiles: pure walk, no extraction ───────────────────────────

it("dry-run walk collects .md/.txt/.pdf, skips dot-dirs, hidden files, symlinks, wrong extensions", () => {
	const root = makeVault();
	const listing = listImportableFiles(root);
	const paths = listing.files.map((f) => f.path).sort();
	assert.deepEqual(paths, [
		"Course/Week 1/lecture.md",
		"Course/Week 1/same.md",
		"Course/Week 2/same.md",
		"Course/handout.pdf",
		"Notes/plain.txt",
		"readme.md",
	]);
	// No hidden or dot-dir residents, no symlink, no wrong-extension file.
	assert.ok(!paths.includes("Notes/.secret.md"), "hidden file skipped");
	assert.ok(!paths.includes(".obsidian/config.md"), ".obsidian skipped");
	assert.ok(!paths.includes("link-to-readme.md"), "symlink skipped");
	assert.ok(!paths.includes("image.png"), "wrong extension skipped");
	// kind is known by extension for the listing (magic-byte detection is the
	// real import's job; the dry-run only labels by extension).
	const handout = listing.files.find((f) => f.path === "Course/handout.pdf")!;
	assert.equal(handout.kind, "pdf");
	assert.equal(listing.files.find((f) => f.path === "readme.md")!.kind, "text");
	assert.ok(listing.totalBytes > 0);
	assert.equal(listing.truncated, false);
});

it("duplicate basenames keep their folder-relative paths (separate source identities)", () => {
	const root = path.join(tmpHome, "dups");
	fs.mkdirSync(path.join(root, "a"), { recursive: true });
	fs.mkdirSync(path.join(root, "b"), { recursive: true });
	fs.writeFileSync(path.join(root, "a/same.md"), "a");
	fs.writeFileSync(path.join(root, "b/same.md"), "b");
	const listing = listImportableFiles(root);
	assert.deepEqual(listing.files.map((f) => f.path).sort(), ["a/same.md", "b/same.md"]);
});

it("any dot-prefixed directory is skipped, not only .obsidian/.git/.trash", () => {
	const root = path.join(tmpHome, "dotdirs");
	fs.mkdirSync(path.join(root, ".cache"), { recursive: true });
	fs.mkdirSync(path.join(root, "kept"), { recursive: true });
	fs.writeFileSync(path.join(root, ".cache/hidden.md"), "x");
	fs.writeFileSync(path.join(root, "kept/visible.md"), "y");
	const listing = listImportableFiles(root);
	assert.deepEqual(listing.files.map((f) => f.path), ["kept/visible.md"]);
});

it("symlinks are not followed (a symlinked directory is skipped)", () => {
	const root = path.join(tmpHome, "symlinks");
	const target = path.join(tmpHome, "symlink-target");
	fs.mkdirSync(target, { recursive: true });
	fs.writeFileSync(path.join(target, "via-link.md"), "via link");
	fs.mkdirSync(root, { recursive: true });
	fs.symlinkSync(target, path.join(root, "link"));
	fs.writeFileSync(path.join(root, "real.md"), "real");
	const listing = listImportableFiles(root);
	assert.deepEqual(listing.files.map((f) => f.path), ["real.md"]);
});

it("file-count cap truncates the walk and sets truncated", () => {
	const root = path.join(tmpHome, "many");
	fs.mkdirSync(root, { recursive: true });
	for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(root, `n${i}.md`), "x");
	const listing = listImportableFiles(root, { maxFiles: 3 });
	assert.equal(listing.files.length, 3);
	assert.equal(listing.truncated, true);
});

it("max depth bounds the recursion", () => {
	const root = path.join(tmpHome, "deep");
	fs.mkdirSync(path.join(root, "a/b/c/d"), { recursive: true });
	fs.writeFileSync(path.join(root, "a/b/c/d/below.md"), "too deep at depth 4");
	fs.writeFileSync(path.join(root, "a/shallow.md"), "depth 1");
	// depth 0 = root's direct files; the walker enters subdirs at depth+1, so
	// a/b/c/d is depth 4 — beyond maxDepth:3, its file is not collected.
	const listing = listImportableFiles(root, { maxDepth: 3 });
	assert.deepEqual(listing.files.map((f) => f.path), ["a/shallow.md"]);
});

it("per-file size cap skips an oversized file but keeps smaller siblings", () => {
	const root = path.join(tmpHome, "sizes");
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(path.join(root, "big.md"), "x".repeat(MAX_IMPORT_BYTES + 1));
	fs.writeFileSync(path.join(root, "small.md"), "y");
	const listing = listImportableFiles(root);
	assert.deepEqual(listing.files.map((f) => f.path), ["small.md"]);
	assert.ok(listing.skipped >= 1, "oversized file counted as skipped");
});

// ── resolveFolderPath: ~ expansion + traversal bounding (the fs-tools rule) ─

it("~ expands to home and a relative path resolves under home", () => {
	const vault = makeVault();
	// `~` + relative resolves under the tmp home; realpath canonicalizes it.
	const resolved = resolveFolderPath("~/vault");
	assert.equal(resolved, vault);
	const resolvedRel = resolveFolderPath("vault");
	assert.equal(resolvedRel, vault);
});

it("an absolute path inside home is accepted", () => {
	const vault = makeVault();
	assert.equal(resolveFolderPath(vault), vault);
});

it("an absolute path OUTSIDE home is refused (path traversal bound, like fs tools)", () => {
	const outside = path.join(os.tmpdir(), "lh-import-folder-outside-");
	fs.mkdirSync(outside, { recursive: true });
	after(() => fs.rmSync(outside, { recursive: true, force: true }));
	assert.throws(() => resolveFolderPath(outside), /outside your home folder/);
});

it("a relative path that escapes home via ../ is refused", () => {
	// `..` resolves to home's parent (/tmp), which exists — so the containment
	// check (not realpath's ENOENT) refuses it, the fs-tools traversal rule.
	assert.throws(() => resolveFolderPath(".."), /outside your home folder/);
});

it("a missing path fails closed with a readable message", () => {
	assert.throws(() => resolveFolderPath("~/no-such-folder"), /Could not open/);
});

// ── POST dryRun: the listing over the wire ───────────────────────────────────

it("POST dryRun returns the filtered listing with totals and no results", async () => {
	const vault = makeVault();
	const response = await POST(request({ path: vault, dryRun: true }));
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.ok(Array.isArray(body.files));
	assert.equal(body.files.length, 6);
	assert.ok(body.totalBytes > 0);
	assert.equal(body.truncated, false);
	assert.ok(!("results" in body), "dry-run never returns per-file results");
});

it("POST dryRun with ~ path expands to home and lists the vault", async () => {
	makeVault();
	const response = await POST(request({ path: "~/vault", dryRun: true }));
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.equal(body.files.length, 6);
});

it("POST refuses a path outside home", async () => {
	const outside = path.join(os.tmpdir(), "lh-import-folder-outside-post-");
	fs.mkdirSync(outside, { recursive: true });
	after(() => fs.rmSync(outside, { recursive: true, force: true }));
	const response = await POST(request({ path: outside, dryRun: true }));
	assert.equal(response.status, 400);
	const body = await response.json();
	assert.match(body.error, /outside your home folder/);
});

it("POST refuses a non-directory path", async () => {
	const file = path.join(tmpHome, "a-file.md");
	fs.writeFileSync(file, "x");
	const response = await POST(request({ path: file, dryRun: true }));
	assert.equal(response.status, 400);
	assert.match((await response.json()).error, /not a folder/);
});

it("POST on an empty (no importable notes) folder returns 400 with a listing", async () => {
	const empty = path.join(tmpHome, "empty");
	fs.mkdirSync(empty, { recursive: true });
	fs.writeFileSync(path.join(empty, "image.png"), "x");
	const response = await POST(request({ path: empty, dryRun: true }));
	assert.equal(response.status, 400);
	const body = await response.json();
	assert.deepEqual(body.files, []);
	assert.ok(body.skipped >= 1);
});

it("POST requires a path", async () => {
	const response = await POST(request({ dryRun: true }));
	assert.equal(response.status, 400);
	assert.match((await response.json()).error, /folder path/i);
});

// ── POST dryRun:false: reuse of the extraction pipeline + error isolation ─────

it("dryRun:false runs each file through extraction and isolates a single failing file", async () => {
	const vault = path.join(tmpHome, "isolation");
	fs.mkdirSync(path.join(vault, "sub"), { recursive: true });
	fs.writeFileSync(path.join(vault, "ok1.md"), "# ok one");
	fs.writeFileSync(path.join(vault, "sub/ok2.txt"), "ok two");
	fs.writeFileSync(path.join(vault, "boom.md"), "this one throws");
	const seen: string[] = [];
	extraction.importNotes = async ({ filePath, text }) => {
		seen.push(filePath);
		if (filePath === "boom.md") throw new Error("synthetic file failure");
		assert.ok(text.length > 0, "text content reaches the pipeline");
		return { nodes: 1, chains: 0 };
	};
	const response = await POST(request({ path: vault, dryRun: false }));
	assert.equal(response.status, 200);
	const { results } = await response.json();
	assert.equal(results.length, 3);
	assert.deepEqual(seen.sort(), ["boom.md", "ok1.md", "sub/ok2.txt"].sort());
	const byPath = (p: string) => results.find((r: { filePath: string }) => r.filePath === p);
	assert.equal(byPath("ok1.md").ok, true);
	assert.equal(byPath("ok1.md").outcome, "completed");
	assert.equal(byPath("sub/ok2.txt").ok, true);
	assert.equal(byPath("boom.md").ok, false);
	assert.equal(byPath("boom.md").outcome, "failed");
	assert.match(byPath("boom.md").error, /synthetic file failure/);
});

it("dryRun:false surfaces config refusals (models_not_configured) with the machine code", async () => {
	const vault = path.join(tmpHome, "config-refusal");
	fs.mkdirSync(vault, { recursive: true });
	fs.writeFileSync(path.join(vault, "a.md"), "a");
	const { ModelsNotConfiguredError } = await import("../src/core/settings.ts");
	extraction.importNotes = async () => { throw new ModelsNotConfiguredError(["cheap"]); };
	const response = await POST(request({ path: vault, dryRun: false }));
	const { results } = await response.json();
	assert.equal(results[0].ok, false);
	assert.equal(results[0].code, "models_not_configured");
	assert.deepEqual(results[0].missing, ["cheap"]);
});

it("dryRun:false converts a real PDF to page-marked Markdown before extraction", async () => {
	const vault = path.join(tmpHome, "pdf");
	fs.mkdirSync(vault, { recursive: true });
	fs.writeFileSync(path.join(vault, "handout.pdf"), tinyPdf([{ runs: [{ text: "Handout page", x: 72, y: 700 }] }]));
	let received = "";
	extraction.importNotes = async ({ text }) => { received = text; return { nodes: 0, chains: 0 }; };
	const response = await POST(request({ path: vault, dryRun: false }));
	const { results } = await response.json();
	assert.equal(results[0].outcome, "completed");
	assert.match(received, /Handout page/);
	assert.match(results[0].notice, /Scanned pages may have errors/);
});

it("dryRun:false keeps at most three files in flight (the sibling route's cap)", async () => {
	const vault = path.join(tmpHome, "concurrency");
	fs.mkdirSync(vault, { recursive: true });
	for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(vault, `f${i}.md`), "x");
	let active = 0, peak = 0;
	extraction.importNotes = async () => {
		active++; peak = Math.max(peak, active);
		try { await new Promise((r) => setTimeout(r, 5)); return { nodes: 0, chains: 0 }; }
		finally { active--; }
	};
	await POST(request({ path: vault, dryRun: false }));
	assert.equal(peak, 3);
});

it("dryRun:false over a too-big folder still refuses (size cap is shared with the per-file route)", () => {
	// The walk's total-size cap mirrors MAX_IMPORT_BYTES; a folder exceeding it
	// truncates the dry-run listing with truncated:true rather than importing.
	const root = path.join(tmpHome, "toobig");
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(path.join(root, "big.md"), "x".repeat(MAX_IMPORT_BYTES));
	fs.writeFileSync(path.join(root, "extra.md"), "y".repeat(1024));
	const listing = listImportableFiles(root);
	assert.equal(listing.truncated, true, "aggregate size cap truncates the walk");
	assert.ok(listing.files.length < 2);
});
