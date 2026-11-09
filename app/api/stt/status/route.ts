/**
 * GET /api/stt/status (personal fork): which dictation engines actually
 * have credentials, so the UI can stop lying about a selected-but-unkeyed
 * engine. The bridge's engine menu offers Auto/Groq/Logfare/NVIDIA/Local,
 * but only the keyed ones can run — a pinned engine with no key silently
 * falls back to the bridge default at request time (see /api/stt/token).
 * This route tells the settings page exactly that, per engine.
 *
 * Reads through `keyValue` — the SAME env-first lookup every consumer
 * (the token route, pi-ai) performs — so an env-shadowed key counts as
 * present (gate by what would run, not what is in the file alone). `local`
 * needs no key (the bridge's bundled engine), so it is always keyed.
 *
 * `reason` is a single human line the page renders under the select:
 * when the selected engine is concrete (not "auto"/"local") AND unkeyed,
 * it names the engine and explains the silent fallback; otherwise a
 * short ok line. "auto" delegates to the bridge's own choice (no per-
 * engine gate), and "local" is always runnable.
 */
import { effectiveSettings, keyValue } from "@/src/server";

export const dynamic = "force-dynamic";

/** The concrete engine ids the menu offers (auto is the delegate, not an
 *  engine). Order matches the select's option order. */
const ENGINE_LABELS: ReadonlyArray<{ id: "groq" | "logfare" | "nvidia" | "local"; label: string }> = [
	{ id: "groq", label: "Groq" },
	{ id: "logfare", label: "Logfare" },
	{ id: "nvidia", label: "NVIDIA NIM" },
	{ id: "local", label: "Local" },
];

/** Is this engine's credential present at request time? `local` is the
 *  bridge's bundled engine — never gated. Logfare (this setup configures
 *  Logfare as a CUSTOM PROVIDER) keys on the custom endpoint's key
 *  (CUSTOM_OPENAI_API_KEY) OR the legacy Together key (TOGETHER_API_KEY). */
function engineKeyed(id: "groq" | "logfare" | "nvidia" | "local"): boolean {
	switch (id) {
		case "groq":
			return keyValue("GROQ_API_KEY") !== undefined;
		case "logfare":
			return keyValue("TOGETHER_API_KEY") !== undefined || keyValue("CUSTOM_OPENAI_API_KEY") !== undefined;
		case "nvidia":
			return keyValue("NVIDIA_API_KEY") !== undefined;
		case "local":
			return true;
	}
}

export async function GET() {
	const selected = effectiveSettings().stt.provider;
	const bridge = Boolean(process.env.LH_STT_BRIDGE_URL);

	const engines = ENGINE_LABELS.map(({ id, label }) => ({
		id,
		label,
		keyed: engineKeyed(id),
	}));

	// The reason names the SELECTED engine when it is concrete yet unkeyed.
	// "auto" delegates to the bridge (no per-engine gate); "local" always
	// runs, so neither produces a fallback warning.
	let reason: string;
	const selectedEngine = engines.find((e) => e.id === selected);
	if (selectedEngine && !selectedEngine.keyed) {
		reason = `${selectedEngine.label} is selected but has no key — dictation will fall back to the bridge default`;
	} else {
		reason = bridge ? "STT bridge configured" : "No STT bridge configured";
	}

	return Response.json({
		bridge,
		selected,
		engines,
		reason,
	});
}
