/**
 * THE COMPOSITION ROOT for storage — the single place concrete store
 * adapters are wired. Everything else (core, services, agents) codes against
 * the port types in core/ports.ts and receives instances through this
 * module. Swapping the fs adapter for SQLite later changes exactly this
 * file (and the adapter implementations in src/store/).
 */

import { chatStore } from "../store/chats.ts";
import { graphStore } from "../store/graph.ts";
import { jobStore } from "../store/jobs.ts";
import { settingsStore } from "../store/settings.ts";
import { resolveSettings, type EffectiveSettings } from "../core/settings-resolution.ts";
import { syncCustomProvider } from "./custom-provider.ts";
import { readSyncConfig } from "../store/sync.ts";
import { runSync as runSyncEngine } from "./sync-engine.ts";
/** The wired adapters. Satisfies core/graph.ts's GraphDeps structurally. */
export const stores = {
	chatStore,
	graphStore,
	jobStore,
	settingsStore,
};

export type Stores = typeof stores;

/**
 * The resolved view of the settings record (core/settings-resolution.ts):
 * every knob concrete over its factory default — EXCEPT MODELS (BYOK all
 * the way down, owner 2026-09-22): no factory pins exist, so unset model
 * slots resolve to null and per-need refusal gates fire downstream. Read
 * fresh on every call — the record is a small file and turns are rare, so
 * no caching layer (stale toggles after a settings PUT would be worse).
 */
export function effectiveSettings(): EffectiveSettings {
	return resolveSettings(settingsStore.readSettings());
}

// Boot: register the custom endpoint (when configured) into piModels(); the
// POST /api/custom-provider route re-syncs after every connect.
syncCustomProvider();

// ─── Nextcloud sync scheduler (personal fork) ───────────────────────────────
// One interval per process (unref'd — never keeps the server alive), plus a
// single delayed boot run. Gated on enabled + autoSyncMinutes > 0; a run
// every `autoSyncMinutes` minutes. The module-level `running` lock in the
// engine makes an interval tick that overlaps a manual run a no-op.
let syncSchedulerStarted = false;
export function startSyncScheduler(): void {
	if (syncSchedulerStarted || process.env.NODE_ENV === "test") return;
	syncSchedulerStarted = true;
	const tick = () => {
		const cfg = readSyncConfig();
		if (!cfg.enabled || cfg.autoSyncMinutes <= 0) return;
		void runSyncEngine().catch(() => {});
	};
	// First auto-run shortly after boot (let the server settle + first
	// paint happen first).
	setTimeout(tick, 30_000);
	const interval = setInterval(tick, 60_000);
	interval.unref?.();
}

startSyncScheduler();
