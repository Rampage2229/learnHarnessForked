export const ANTIGRAVITY_PROVIDER = "antigravity";

/** Installation/version info for Google Antigravity CLI (agy). */
export interface AntigravityStatus {
	state: "available" | "not-found";
	version: string | null;
	path: string | null;
	models: string[];
}
