/**
 * Nextcloud sync config + state store (personal fork). Both files live at
 * the data seam and are NEVER synced (the config holds the app password —
 * the only credential in the data dir outside auth.json).
 *
 * config:   data/sync.json        { serverUrl, username, password,
 *                                    enabled, autoSyncMinutes, lastSyncAt,
 *                                    lastSyncError }
 * state:    data/sync-state.json  { [path]: { local: {mtimeMs,size},
 *                                             remote: {mtimeMs,size} } }
 *
 * Atomic writes (tmp + rename, mode 0600 — the password is a credential),
 * never-throw on read (unreadable = unconfigured).
 */
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import type { SyncStateMap } from "../core/sync-plan.ts";

export interface SyncConfig {
	serverUrl: string;
	username: string;
	password: string;
	enabled: boolean;
	/** Auto-sync cadence in minutes; 0 = manual only. */
	autoSyncMinutes: number;
	lastSyncAt?: string;
	lastSyncError?: string;
}

const DEFAULT_CONFIG: SyncConfig = {
	serverUrl: "",
	username: "",
	password: "",
	enabled: false,
	autoSyncMinutes: 15,
};

function atomicWrite(file: string, contents: string): void {
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}`);
	fs.writeFileSync(tmp, contents, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

export function readSyncConfig(): SyncConfig {
	try {
		const raw = JSON.parse(fs.readFileSync(PATHS.syncConfig, "utf8")) as Partial<SyncConfig>;
		return {
			serverUrl: typeof raw.serverUrl === "string" ? raw.serverUrl : "",
			username: typeof raw.username === "string" ? raw.username : "",
			password: typeof raw.password === "string" ? raw.password : "",
			enabled: raw.enabled === true,
			autoSyncMinutes: typeof raw.autoSyncMinutes === "number" && raw.autoSyncMinutes >= 0 ? raw.autoSyncMinutes : DEFAULT_CONFIG.autoSyncMinutes,
			...(typeof raw.lastSyncAt === "string" ? { lastSyncAt: raw.lastSyncAt } : {}),
			...(typeof raw.lastSyncError === "string" ? { lastSyncError: raw.lastSyncError } : {}),
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

/** Never returns the password to the client (the GET status omits it). */
export function writeSyncConfig(cfg: SyncConfig): void {
	atomicWrite(PATHS.syncConfig, `${JSON.stringify(cfg, null, 2)}\n`);
}

export function readSyncState(): SyncStateMap {
	try {
		return JSON.parse(fs.readFileSync(PATHS.syncState, "utf8")) as SyncStateMap;
	} catch {
		return {};
	}
}

export function writeSyncState(state: SyncStateMap): void {
	atomicWrite(PATHS.syncState, `${JSON.stringify(state, null, 2)}\n`);
}