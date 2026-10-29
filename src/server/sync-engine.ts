/**
 * Nextcloud sync engine (personal fork, option B) — WebDAV transport,
 * ledger-aware two-way sync. Executes the pure plan from
 * src/core/sync-plan.ts against a Nextcloud WebDAV folder.
 *
 * Allowlist (everything durable except secrets/config/ephemera):
 *   chats/*.json, graph/* (jsonl ledgers merge; json files whole-file),
 *   reviews.jsonl, memory.json, topics.json, settings.json (with the
 *   customProvider block stripped on transfer — provider config never
 *   syncs). Excluded by construction: auth.json, *credentials*,
 *   sync.json/sync-state.json, jobs/, debug/, migrated backups.
 *
 * Safety: local writes are atomic (tmp+rename); the app's own writes are
 * atomic too, so a sync racing a turn can never tear a file — worst case
 * is a last-writer-wins flip the NEXT sync reconciles. One sync runs at a
 * time (module-level lock).
 */
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { planSync, type LocalFile, type RemoteFile, type SyncAction, type SyncStamp, type SyncFileKind } from "../core/sync-plan.ts";
import { readSyncConfig, readSyncState, writeSyncConfig, writeSyncState } from "../store/sync.ts";

/** The remote folder is DOT-PREFIXED: hidden by default in the Nextcloud
 *  web UI (it is machine state, not documents to browse) and skipped by
 *  other desktop sync clients that would otherwise double-sync it. */
const FOLDER = ".LearnHarness";

// ─── Allowlist + kind classification ────────────────────────────────────────

function kindOf(rel: string): SyncFileKind {
	return rel.endsWith(".jsonl") ? "jsonl" : "json";
}

function isSyncableLocalPath(rel: string): boolean {
	if (rel === "settings.json" || rel === "memory.json" || rel === "topics.json" || rel === "reviews.jsonl") return true;
	if (rel.startsWith("chats/") && rel.endsWith(".json")) return true;
	if (rel.startsWith("graph/") && (rel.endsWith(".json") || rel.endsWith(".jsonl"))) return true;
	return false;
}

function localSyncFiles(): LocalFile[] {
	const out: LocalFile[] = [];
	const walk = (dir: string, prefix: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const rel = prefix ? `${prefix}/${e.name}` : e.name;
			const abs = path.join(dir, e.name);
			if (e.isDirectory()) {
				if (rel === "jobs" || rel === "debug") continue;
				walk(abs, rel);
			} else if (e.isFile()) {
				if (!isSyncableLocalPath(rel)) continue;
				try {
					const st = fs.statSync(abs);
					out.push({ path: rel, mtimeMs: st.mtimeMs, size: st.size, kind: kindOf(rel) });
				} catch {
					/* raced delete */
				}
			}
		}
	};
	walk(PATHS.data, "");
	return out;
}

function localAbs(rel: string): string {
	return path.join(PATHS.data, rel);
}

function atomicWriteLocal(rel: string, contents: string): void {
	const abs = localAbs(rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.sync-${process.pid}`);
	fs.writeFileSync(tmp, contents, "utf8");
	fs.renameSync(tmp, abs);
}

// ─── settings.json strip (provider config never syncs) ──────────────────────

function stripSettings(raw: string): string {
	try {
		const record = JSON.parse(raw) as Record<string, unknown>;
		delete record.customProvider;
		return JSON.stringify(record, null, 2) + "\n";
	} catch {
		return raw; // unreadable — transfer verbatim rather than destroy
	}
}

function restoreSettings(downloaded: string): string {
	try {
		const remote = JSON.parse(downloaded) as Record<string, unknown>;
		const localRaw = fs.readFileSync(localAbs("settings.json"), "utf8");
		const local = JSON.parse(localRaw) as Record<string, unknown>;
		if (local.customProvider !== undefined) remote.customProvider = local.customProvider;
		return JSON.stringify(remote, null, 2) + "\n";
	} catch {
		return downloaded;
	}
}

// ─── JSONL union merge (dedupe by exact line) ───────────────────────────────

function mergeJsonl(localRaw: string, remoteRaw: string): string {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of [localRaw, remoteRaw]) {
		for (const line of raw.split("\n")) {
			const t = line.trim();
			if (!t) continue;
			if (seen.has(t)) continue;
			seen.add(t);
			out.push(t);
		}
	}
	return out.join("\n") + "\n";
}

// ─── WebDAV client ──────────────────────────────────────────────────────────

function webDavBase(cfg: { serverUrl: string; username: string }): string {
	return `${cfg.serverUrl.replace(/\/+$/, "")}/remote.php/dav/files/${encodeURIComponent(cfg.username)}/${FOLDER}`;
}

function authHeaders(cfg: { username: string; password: string }): Record<string, string> {
	return { Authorization: `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64")}` };
}

/** WebDAV PUT requires every parent collection to exist — MKCOL each
 *  segment of the relative path (405 = exists, benign). Cheap per sync
 *  (a handful of PROPFIND/MKCOLs against a handful of folders). */
async function ensureFolders(cfg: { serverUrl: string; username: string; password: string }, relPaths: readonly string[]): Promise<void> {
	const base = webDavBase(cfg);
	const needed = new Set<string>();
	for (const rel of relPaths) {
		const segments = rel.split("/").slice(0, -1); // the file's own segment is not a folder
		let acc = "";
		for (const seg of segments) {
			acc = acc ? `${acc}/${seg}` : seg;
			needed.add(acc);
		}
	}
	for (const dir of needed) {
		const url = `${base}/${dir}`;
		const probe = await fetch(url, { method: "PROPFIND", headers: { ...authHeaders(cfg), Depth: "0" } });
		if (probe.ok) continue;
		const mk = await fetch(url, { method: "MKCOL", headers: authHeaders(cfg) });
		if (!mk.ok && mk.status !== 405) throw new Error(`Could not create the remote folder "${dir}" (HTTP ${mk.status})`);
	}
}

async function ensureFolder(cfg: { serverUrl: string; username: string; password: string }): Promise<void> {
	const base = webDavBase(cfg);
	const res = await fetch(base, { method: "PROPFIND", headers: { ...authHeaders(cfg), Depth: "0" } });
	if (res.ok) return;
	// MKCOL the folder; 405 = already exists (some servers race the check).
	const mk = await fetch(base, { method: "MKCOL", headers: authHeaders(cfg) });
	if (!mk.ok && mk.status !== 405) throw new Error(`Could not create the Nextcloud folder (HTTP ${mk.status})`);
}

function parseDavList(xml: string): Array<{ href: string; mtimeMs: number; size: number }> {
	const out: Array<{ href: string; mtimeMs: number; size: number }> = [];
	// Split on <d:response> blocks (tolerant of the multistatus wrapper).
	const responses = xml.split(/<d:response>/).slice(1);
	for (const block of responses) {
		const end = block.indexOf("</d:response>");
		const body = end >= 0 ? block.slice(0, end) : block;
		const hrefM = body.match(/<d:href>([^<]*)<\/d:href>/);
		const modM = body.match(/<d:getlastmodified>([^<]*)<\/d:getlastmodified>/);
		const lenM = body.match(/<d:getcontentlength>([^<]*)<\/d:getcontentlength>/);
		if (!hrefM || !modM) continue;
		const href = decodeURIComponent(hrefM[1]!.trim());
		const mtime = Date.parse(modM[1]!.trim());
		const size = Number(lenM?.[1] ?? 0);
		if (Number.isNaN(mtime) || !href) continue;
		out.push({ href, mtimeMs: mtime, size });
	}
	return out;
}

async function listRemote(cfg: { serverUrl: string; username: string; password: string }): Promise<RemoteFile[]> {
	const base = webDavBase(cfg);
	const res = await fetch(base, {
		method: "PROPFIND",
		headers: {
			...authHeaders(cfg),
			Depth: "1",
			"Content-Type": "application/xml",
		},
		body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getlastmodified/><d:getcontentlength/></d:prop></d:propfind>`,
	});
	if (!res.ok) throw new Error(`Could not list the Nextcloud folder (HTTP ${res.status})`);
	const xml = await res.text();
	const basePrefix = webDavBase(cfg);
	const files: RemoteFile[] = [];
	for (const entry of parseDavList(xml)) {
		const rel = entry.href.startsWith(basePrefix)
			? entry.href.slice(basePrefix.length).replace(/^\/+/, "")
			: null;
		if (!rel || rel === "" || rel.endsWith("/")) continue; // the folder itself + nested dirs
		if (!isSyncableLocalPath(rel)) continue;
		files.push({ path: rel, mtimeMs: entry.mtimeMs, size: entry.size, kind: kindOf(rel) });
	}
	return files;
}

async function remoteGet(cfg: { serverUrl: string; username: string; password: string }, rel: string): Promise<string> {
	const res = await fetch(`${webDavBase(cfg)}/${rel}`, { headers: authHeaders(cfg) });
	if (!res.ok) throw new Error(`GET ${rel}: HTTP ${res.status}`);
	return res.text();
}

async function remotePut(cfg: { serverUrl: string; username: string; password: string }, rel: string, contents: string): Promise<void> {
	const res = await fetch(`${webDavBase(cfg)}/${rel}`, {
		method: "PUT",
		headers: { ...authHeaders(cfg), "Content-Type": "application/octet-stream" },
		body: contents,
	});
	if (!res.ok) throw new Error(`PUT ${rel}: HTTP ${res.status}`);
}

async function remoteDelete(cfg: { serverUrl: string; username: string; password: string }, rel: string): Promise<void> {
	const res = await fetch(`${webDavBase(cfg)}/${rel}`, { method: "DELETE", headers: authHeaders(cfg) });
	if (!res.ok && res.status !== 404) throw new Error(`DELETE ${rel}: HTTP ${res.status}`);
}

// ─── The run ────────────────────────────────────────────────────────────────

export interface SyncReport {
	ok: boolean;
	uploaded: number;
	downloaded: number;
	merged: number;
	conflicts: number;
	deleted: number;
	error?: string;
}

let running = false;

/** One two-way sync. Never throws — failures land in the report + config. */
export async function runSync(): Promise<SyncReport> {
	if (running) return { ok: false, uploaded: 0, downloaded: 0, merged: 0, conflicts: 0, deleted: 0, error: "A sync is already running." };
	running = true;
	const report: SyncReport = { ok: false, uploaded: 0, downloaded: 0, merged: 0, conflicts: 0, deleted: 0 };
	try {
		const cfg = readSyncConfig();
		if (!cfg.enabled || !cfg.serverUrl || !cfg.username || !cfg.password) {
			throw new Error("Sync is not configured.");
		}
		await ensureFolder(cfg);
		const local = localSyncFiles();
		const remote = await listRemote(cfg);
		const actions = planSync({ local, remote, state: readSyncState() });

		await ensureFolders(cfg, actions.map((a) => a.path));
		for (const a of actions) {
			await executeAction(cfg, a, report);
		}

		// Re-scan both sides → the next state is the current reality. Only
		// paths present on BOTH sides are recorded (a one-sided path would
		// look like a deletion next run — instead it re-syncs as new).
		const localAfter = new Map(localSyncFiles().map((f) => [f.path, f]));
		const remoteAfter = new Map((await listRemote(cfg)).map((f) => [f.path, f]));
		const state: Record<string, { local: SyncStamp; remote: SyncStamp }> = {};
		for (const [rel, lf] of localAfter) {
			const rf = remoteAfter.get(rel);
			if (!rf) continue;
			state[rel] = {
				local: { mtimeMs: lf.mtimeMs, size: lf.size },
				remote: { mtimeMs: rf.mtimeMs, size: rf.size },
			};
		}
		writeSyncState(state);
		writeSyncConfig({ ...cfg, lastSyncAt: new Date().toISOString(), lastSyncError: undefined });
		report.ok = true;
		return report;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		report.error = message;
		const cfg = readSyncConfig();
		writeSyncConfig({ ...cfg, lastSyncError: message });
		return report;
	} finally {
		running = false;
	}
}

async function executeAction(
	cfg: { serverUrl: string; username: string; password: string },
	a: SyncAction,
	report: SyncReport,
): Promise<void> {
	const rel = a.path;
	switch (a.type) {
		case "upload": {
			const raw = fs.readFileSync(localAbs(rel), "utf8");
			await remotePut(cfg, rel, rel === "settings.json" ? stripSettings(raw) : raw);
			report.uploaded++;
			break;
		}
		case "download": {
			let raw = await remoteGet(cfg, rel);
			if (rel === "settings.json") raw = restoreSettings(raw);
			atomicWriteLocal(rel, raw);
			report.downloaded++;
			break;
		}
		case "mergeJsonl": {
			const localRaw = fs.readFileSync(localAbs(rel), "utf8");
			const remoteRaw = await remoteGet(cfg, rel);
			const merged = mergeJsonl(localRaw, remoteRaw);
			atomicWriteLocal(rel, merged);
			await remotePut(cfg, rel, merged);
			report.merged++;
			break;
		}
		case "conflictKeepLocal": {
			const remoteRaw = await remoteGet(cfg, rel);
			const conflictRel = `${rel}.conflict-${new Date().toISOString().replace(/[:.]/g, "-")}`;
			atomicWriteLocal(conflictRel, remoteRaw);
			await remotePut(cfg, rel, fs.readFileSync(localAbs(rel), "utf8"));
			report.conflicts++;
			break;
		}
		case "conflictKeepRemote": {
			const localRaw = fs.readFileSync(localAbs(rel), "utf8");
			const conflictRel = `${rel}.conflict-${new Date().toISOString().replace(/[:.]/g, "-")}`;
			atomicWriteLocal(conflictRel, localRaw);
			const remoteRaw = await remoteGet(cfg, rel);
			atomicWriteLocal(rel, rel === "settings.json" ? restoreSettings(remoteRaw) : remoteRaw);
			report.conflicts++;
			break;
		}
		case "deleteRemote":
			await remoteDelete(cfg, rel);
			report.deleted++;
			break;
		case "deleteLocal":
			try {
				fs.unlinkSync(localAbs(rel));
			} catch {
				/* already gone */
			}
			report.deleted++;
			break;
	}
}