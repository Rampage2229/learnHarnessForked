/**
 * Custom OpenAI-compatible chat providers (personal fork).
 *
 * BYOK already covers every pi-ai builtin provider; this module adds
 * providers that pi-ai does not ship — e.g. an OpenAI-compatible gateway
 * (Logfare) serving whisper/chat catalogs. Definitions live in a JSON
 * file at the data-dir seam:
 *
 *   <data>/custom-providers.json
 *   {
 *     "providers": [{
 *       "id": "logfare",
 *       "name": "Logfare",
 *       "baseUrl": "https://logfare.ai/v1",
 *       "apiKeyEnvVar": "LOGFARE_API_KEY",
 *       "aliases": ["together"],
 *       "models": [ { "id": "...", "name": "...", "reasoning": false,
 *                     "input": ["text"], "contextWindow": 128000,
 *                     "maxTokens": 8192 } ]
 *     }]
 *   }
 *
 * Semantics (mirrors the app's architecture):
 *  - The provider is registered into the pi-ai Models collection next to
 *    the builtins; the picker federates it through catalogProviders()
 *    (src/server/model-catalog.ts) exactly like a builtin.
 *  - `aliases` re-register the same catalog under another id. An alias
 *    that collides with a builtin id REPLACES it (setProvider is a Map
 *    set) — this is how an existing data dir's settings/chats that pin
 *    e.g. "together" keep working against the custom endpoint.
 *  - The API key rides the same env seam as every other key: set
 *    <apiKeyEnvVar> in auth.json (Settings → Keys shows it as a generic
 *    row) or in the environment; the keys seam reflects file vars into
 *    process.env at boot.
 *  - Every model is served over the OpenAI Completions API with the
 *    compat overrides learned the hard way on real gateways: generic
 *    OpenAI-style thinking (reasoning_effort — NOT Together's
 *    reasoning:{enabled}), no `store`, max_tokens field.
 *  - Missing file = no custom providers. The file is now UI-MANAGED:
 *    src/server/custom-providers.ts reads/discovers/writes it through
 *    this module (atomic writes), and syncCustomProviders reconciles a
 *    live pi-ai Models collection with the on-disk set — no restart.
 */
import fs from "node:fs";
import path from "node:path";
import { createProvider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { PATHS } from "../../config.ts";

/** One model entry as written in custom-providers.json (lean shape). */
export interface CustomModelSpec {
	id: string;
	name?: string;
	reasoning?: boolean;
	/** pi-ai input modalities — only "text" and "image" are chat-valid. */
	input?: Array<"text" | "image">;
	contextWindow?: number;
	maxTokens?: number;
	thinkingLevelMap?: Record<string, string | null>;
}

/** One provider entry as written in custom-providers.json. */
export interface CustomProviderSpec {
	id: string;
	name?: string;
	baseUrl: string;
	apiKeyEnvVar: string;
	aliases?: string[];
	models: CustomModelSpec[];
}

export interface LoadedCustomProvider {
	spec: CustomProviderSpec;
	/** Primary id first, then aliases — every id this catalog answers to. */
	ids: string[];
	/** Built (primary) provider object for pi-ai setProvider. */
	provider: ReturnType<typeof buildProvider>;
}

const FILE_NAME = "custom-providers.json";

export function customProvidersPath(): string {
	return path.join(PATHS.data, FILE_NAME);
}

/** Atomic write — tmp file in the same dir + rename (the auth-store
 *  pattern, src/store/auth.ts) so a crash never leaves a truncated
 *  providers file that reads as "no custom providers". */
export function writeCustomProviders(specs: CustomProviderSpec[]): void {
	const file = customProvidersPath();
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `.custom-providers.json.tmp-${process.pid}`);
	fs.writeFileSync(tmp, `${JSON.stringify({ providers: specs }, null, 2)}\n`, "utf8");
	fs.renameSync(tmp, file);
}

export function readCustomProviderSpecs(): CustomProviderSpec[] {
	const file = customProvidersPath();
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { providers?: CustomProviderSpec[] };
		const list = (Array.isArray(raw.providers) ? raw.providers : []).filter((p) => p
			&& typeof p.id === "string" && typeof p.baseUrl === "string"
			&& typeof p.apiKeyEnvVar === "string" && Array.isArray(p.models));
		// Lenient read-side guards: drop malformed aliases/models rather
		// than letting a hand-edited file corrupt the registration.
		return list.map((p) => ({
			...p,
			aliases: Array.isArray(p.aliases) ? p.aliases.filter((a) => typeof a === "string") : undefined,
			models: p.models.filter((m) => m && typeof m.id === "string"),
		}));
	} catch {
		return []; // absent or unreadable file = no custom providers
	}
}

let cache: LoadedCustomProvider[] | undefined;

/** ids this process has registered into a pi-ai Models collection
 *  (primary + aliases) — syncCustomProviders' reconciliation memory. */
const registeredIds = new Set<string>();

/** Reset the memoized cache (after a write) so the next read sees disk. */
export function reloadCustomProviders(): void {
	cache = undefined;
}

/** All loaded custom providers (memoized per process). */
export function loadedCustomProviders(): LoadedCustomProvider[] {
	if (!cache) {
		cache = readCustomProviderSpecs().map((spec) => ({
			spec,
			ids: [spec.id, ...(spec.aliases ?? [])],
			provider: buildProvider(spec, spec.id),
		}));
	}
	return cache;
}

/** (id, apiKeyEnvVar) rows for the model picker's provider surface. */
export function customCatalogRows(): { id: string; envVar: string }[] {
	return loadedCustomProviders().map((p) => ({ id: p.spec.id, envVar: p.spec.apiKeyEnvVar }));
}

/** Register every custom provider (primary id + aliases) into a
 * pi-ai Models collection. Alias ids REPLACE colliding builtins. */
export function registerCustomProviders(collection: { setProvider(p: unknown): void }): void {
	for (const loaded of loadedCustomProviders()) {
		collection.setProvider(loaded.provider);
		for (const alias of loaded.ids.slice(1)) {
			collection.setProvider(buildProvider(loaded.spec, alias));
		}
		for (const id of loaded.ids) registeredIds.add(id);
	}
}

/** Reconcile a live pi-ai Models collection with the on-disk set: reload
 *  first, delete every previously-registered id that is no longer current
 *  (aliases included), then re-register every current id. */
export function syncCustomProviders(collection: {
	setProvider(p: unknown): void;
	deleteProvider(id: string): void;
}): void {
	reloadCustomProviders();
	const loaded = loadedCustomProviders();
	const current = new Set(loaded.flatMap((p) => p.ids));
	// Builtins an alias REPLACED (setProvider overwrote them) must be
	// restored when that custom provider goes away — otherwise the
	// builtin stays missing from the picker until restart.
	const builtins = new Map(builtinProviders().map((p) => [p.id, p]));
	for (const id of [...registeredIds]) {
		if (current.has(id)) continue;
		const builtin = builtins.get(id);
		if (builtin) collection.setProvider(builtin);
		else collection.deleteProvider(id);
		registeredIds.delete(id);
	}
	for (const entry of loaded) {
		collection.setProvider(entry.provider);
		for (const id of entry.ids) registeredIds.add(id);
		for (const alias of entry.ids.slice(1)) {
			collection.setProvider(buildProvider(entry.spec, alias));
		}
	}
}

/** Build a pi-ai provider object from a spec under a specific id. */
function buildProvider(spec: CustomProviderSpec, id: string) {
	const models = spec.models.map((m) => ({
		type: "chat" as const,
		id: m.id,
		name: m.name ?? m.id,
		api: "openai-completions" as const,
		provider: id,
		baseUrl: spec.baseUrl,
		reasoning: m.reasoning ?? false,
		...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
		input: m.input ?? ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: m.contextWindow ?? 128_000,
		maxTokens: m.maxTokens ?? 8_192,
		// Compat overrides learned on real gateways: generic OpenAI-style
		// thinking (reasoning_effort — NOT Together's reasoning:{enabled}
		// that provider-id sniffing would pick), no `store`, max_tokens.
		compat: {
			supportsStore: false,
			thinkingFormat: "openai" as const,
			supportsReasoningEffort: true,
			maxTokensField: "max_tokens" as const,
		},
	}));
	return createProvider({
		id,
		name: spec.name ?? id,
		baseUrl: spec.baseUrl,
		auth: { apiKey: apiKeyEnvAuth(spec.name ?? id, spec.apiKeyEnvVar) },
		models,
		api: openAICompletionsApi(),
	});
}

/** Standard api-key auth against ONE env var (the auth/keys seam reflects
 * auth.json vars into process.env at boot, so ctx.env sees file keys). */
function apiKeyEnvAuth(name: string, envVar: string) {
	return {
		name,
		login: async () => {
			throw new Error(`Set ${envVar} in auth.json (or the environment) — no interactive login for custom providers.`);
		},
		resolve: async ({ ctx, credential }: {
			ctx: { env(name: string): Promise<string | undefined> };
			credential?: { key?: string };
		}) => {
			if (credential?.key) {
				return { auth: { apiKey: credential.key }, source: "stored credential" };
			}
			const value = await ctx.env(envVar);
			if (value) return { auth: { apiKey: value }, source: envVar };
			return undefined;
		},
	};
}
