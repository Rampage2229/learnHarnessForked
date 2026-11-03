import { getAntigravityBinary } from "../agent/antigravity/binary.ts";
import { settingsStore } from "../store/settings.ts";

/** Fresh admission state: enabled unless explicitly disabled in settings. */
export function antigravityEnabled(): boolean {
	return settingsStore.readSettings()?.antigravity?.enabled !== false;
}

/** Binary presence + opt-in availability. */
export function antigravityAvailable(): boolean {
	return antigravityEnabled() && getAntigravityBinary() !== null;
}
