/**
 * The server-side custom-provider manager (personal fork): the UI seam
 * behind GET/POST/PUT/DELETE /api/custom-providers. It discovers models
 * from an OpenAI-compatible gateway's /models, persists specs through
 * core/custom-providers.ts, stores the API key in auth.json (the same
 * env seam as every other key), and reconciles the live pi-ai Models
 * collection so the picker federates immediately — no restart.
 */

import { authStore } from "../store/auth.ts";
import { reflectKeyToEnv, unreflectKey } from "./keys.ts";
import { piModels } from "../agent/models.ts";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
	readCustomProviderSpecs,
	reloadCustomProviders,
	syncCustomProviders,
	writeCustomProviders,
	type CustomModelSpec,
	type CustomProviderSpec,
} from "../core/custom-providers.ts";

/** The client-facing row (GET /api/custom-providers). */
export interface CustomProviderRow {
	id: string;
	name: string;
	baseUrl: string;
	apiKeyEnvVar: string;
	keyPresent: boolean;
	modelCount: number;
	aliases: string[];
}

/** "My Cool Provider!" → "my-cool-provider". */
export function customProviderIdFromName(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** The auth.json/env var a custom provider's key rides. */
export function customProviderKeyVar(id: string): string {
	return `CUSTOM_${id.toUpperCase()}_API_KEY`;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Project one Logfare-enriched /models entry ({endpoints}) into a lean
 *  spec. Returns null for non-chat entries (the caller keeps chat only). */
function parseLogfareEntry(raw: Record<string, unknown>): CustomModelSpec | null {
	const endpoints = raw.endpoints;
	if (!Array.isArray(endpoints)) return null;
	if (!endpoints.includes("chat/completions")) return null;
	const id = typeof raw.id === "string" ? raw.id : "";
	if (!id) return null;
	const spec: CustomModelSpec = {
		id,
		name: typeof raw.display_name === "string" ? raw.display_name : id,
		reasoning: false,
		input: ["text"],
		contextWindow: typeof raw.context_length === "number" ? raw.context_length : 128000,
		maxTokens: 65536,
	};
	const architecture =
		raw.architecture && typeof raw.architecture === "object" && !Array.isArray(raw.architecture)
			? (raw.architecture as Record<string, unknown>)
			: {};
	const modalities = architecture.input_modalities;
	// input_modalities is an ARRAY (e.g. ["text","image","file"]) — a
	// 0.8s one-liner bug here previously left every model text-only, so
	// the vision slot (which filters input.includes("image")) showed none.
	if (Array.isArray(modalities) && modalities.includes("image")) {
		spec.input = ["text", "image"];
	}
	const caps =
		raw.chat_capabilities && typeof raw.chat_capabilities === "object" && !Array.isArray(raw.chat_capabilities)
			? (raw.chat_capabilities as Record<string, unknown>)
			: {};
	const reasoning = caps.reasoning;
	if (reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)) {
		const efforts = (reasoning as Record<string, unknown>).supported_efforts;
		if (Array.isArray(efforts) && efforts.length > 0) {
			spec.reasoning = true;
			const map: Record<string, string | null> = {};
			for (const level of THINKING_LEVELS) {
				if (level === "off") map[level] = efforts.includes("none") ? "none" : null;
				else map[level] = efforts.includes(level) ? level : null;
			}
			spec.thinkingLevelMap = map;
		}
	}
	return spec;
}

/** Fetch {baseUrl}/models and project Logfare-enriched + generic entries
 *  into lean CustomModelSpecs, sorted by id. Throws on non-OK responses or
 *  a missing data array. */
export async function discoverModels(baseUrl: string, apiKey?: string): Promise<CustomModelSpec[]> {
	const headers: Record<string, string> = { "user-agent": "learnharness-fork" };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	const res = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(30_000) });
	const bodyText = await res.text();
	if (!res.ok) {
		throw new Error(`model discovery failed (${res.status}): ${bodyText.slice(0, 200)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(bodyText);
	} catch {
		throw new Error(`model discovery failed (${res.status}): ${bodyText.slice(0, 200)}`);
	}
	const data = (parsed as { data?: unknown }).data;
	if (!Array.isArray(data)) {
		throw new Error(`model discovery failed (${res.status}): ${bodyText.slice(0, 200)}`);
	}
	const out: CustomModelSpec[] = [];
	for (const entry of data) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const raw = entry as Record<string, unknown>;
		if (Array.isArray(raw.endpoints)) {
			const spec = parseLogfareEntry(raw);
			if (spec) out.push(spec);
		} else if (typeof raw.id === "string" && raw.id) {
			out.push({
				id: raw.id,
				name: raw.id,
				reasoning: false,
				input: ["text"],
				contextWindow: 128000,
				maxTokens: 65536,
			});
		}
	}
	return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Live key for a spec: env wins (the keys seam reflects auth.json into
 *  process.env at boot), then the file. */
function currentKey(spec: CustomProviderSpec): string | undefined {
	return process.env[spec.apiKeyEnvVar] ?? authStore.authVars()[spec.apiKeyEnvVar];
}

/** The GET view: one row per on-disk provider. */
export function listCustomProviders(): CustomProviderRow[] {
	return readCustomProviderSpecs().map((spec) => ({
		id: spec.id,
		name: spec.name ?? spec.id,
		baseUrl: spec.baseUrl,
		apiKeyEnvVar: spec.apiKeyEnvVar,
		keyPresent: Boolean(process.env[spec.apiKeyEnvVar] || authStore.authVars()[spec.apiKeyEnvVar]),
		modelCount: spec.models.length,
		aliases: spec.aliases ?? [],
	}));
}

function notFound(id: string): Error & { status: number } {
	const err = new Error(`custom provider "${id}" not found`) as Error & { status: number };
	err.status = 404;
	return err;
}

function conflict(id: string): Error & { status: number } {
	const err = new Error(`custom provider "${id}" already exists`) as Error & { status: number };
	err.status = 409;
	return err;
}

export async function addCustomProvider(input: {
	name: string;
	baseUrl: string;
	apiKey: string;
	alias?: string;
}): Promise<CustomProviderSpec> {
	const id = customProviderIdFromName(input.name);
	const specs = readCustomProviderSpecs();
	if (specs.some((s) => s.id === id)) throw conflict(id);
	// A primary id colliding with a builtin would silently REPLACE it
	// (setProvider semantics) and orphan the builtin on delete — replacing
	// a builtin is the alias field's explicit job.
	if (builtinProviders().some((p) => p.id === id)) {
		throw Object.assign(
			new Error(`"${id}" is a built-in provider — use the alias field if you want to replace it`),
			{ status: 409 });
	}
	// Discover FIRST — a discovery failure writes nothing (not the file,
	// not the key).
	const models = await discoverModels(input.baseUrl, input.apiKey || undefined);
	const spec: CustomProviderSpec = {
		id,
		name: input.name,
		baseUrl: input.baseUrl,
		apiKeyEnvVar: customProviderKeyVar(id),
		...(input.alias ? { aliases: [input.alias] } : {}),
		models,
	};
	authStore.setAuthVar(spec.apiKeyEnvVar, input.apiKey);
	reflectKeyToEnv(spec.apiKeyEnvVar, input.apiKey);
	writeCustomProviders([...specs, spec]);
	reloadCustomProviders();
	syncCustomProviders(piModels());
	return spec;
}

export async function refreshCustomProvider(id: string): Promise<CustomProviderSpec> {
	const specs = readCustomProviderSpecs();
	const idx = specs.findIndex((s) => s.id === id);
	if (idx < 0) throw notFound(id);
	const spec = specs[idx]!;
	const next: CustomProviderSpec = {
		...spec,
		models: await discoverModels(spec.baseUrl, currentKey(spec)),
	};
	specs[idx] = next;
	writeCustomProviders(specs);
	reloadCustomProviders();
	syncCustomProviders(piModels());
	return next;
}

export async function updateCustomProvider(
	id: string,
	patch: { name?: string; baseUrl?: string; apiKey?: string; alias?: string },
): Promise<CustomProviderSpec> {
	const specs = readCustomProviderSpecs();
	const idx = specs.findIndex((s) => s.id === id);
	if (idx < 0) throw notFound(id);
	const spec = specs[idx]!;
	const next: CustomProviderSpec = { ...spec };
	if (patch.name !== undefined) next.name = patch.name;
	if (patch.baseUrl !== undefined) next.baseUrl = patch.baseUrl;
	// Alias is replace-whole: "" or absent clears it, a value pins one.
	if (patch.alias) next.aliases = [patch.alias];
	else delete next.aliases;
	const baseChanged = patch.baseUrl !== undefined && patch.baseUrl !== spec.baseUrl;
	if (baseChanged || next.models.length === 0) {
		next.models = await discoverModels(next.baseUrl, currentKey(next));
	}
	if (patch.apiKey !== undefined) {
		authStore.setAuthVar(spec.apiKeyEnvVar, patch.apiKey);
		reflectKeyToEnv(spec.apiKeyEnvVar, patch.apiKey);
	}
	specs[idx] = next;
	writeCustomProviders(specs);
	reloadCustomProviders();
	syncCustomProviders(piModels());
	return next;
}

export function removeCustomProvider(id: string): void {
	const specs = readCustomProviderSpecs();
	const idx = specs.findIndex((s) => s.id === id);
	if (idx < 0) throw notFound(id);
	const spec = specs[idx]!;
	specs.splice(idx, 1);
	writeCustomProviders(specs);
	reloadCustomProviders();
	syncCustomProviders(piModels());
	authStore.deleteAuthVar(spec.apiKeyEnvVar);
	unreflectKey(spec.apiKeyEnvVar);
}