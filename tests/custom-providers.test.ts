/**
 * The UI-managed custom providers (personal fork): discovery mapping,
 * id/key-var derivation, conflict + CRUD round-trips through the route
 * handlers, and the pi-ai Models reconciliation seam. Hermetic: LH_DATA_DIR
 * + LH_AUTH_FILE relocate to a fresh tmp dir BEFORE any module import (the
 * server-keys.test.ts discipline — config.ts is module-load bound).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-custom-providers-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");

// Strip inherited catalog keys — tests use throwaway values only.
for (const varName of [
	"OPENROUTER_API_KEY",
	"DEEPGRAM_API_KEY",
	"TAVILY_API_KEY",
	"BRAVE_API_KEY",
	"GOOGLE_SEARCH_API_KEY",
	"GOOGLE_CSE_ID",
	"OPENAI_API_KEY",
	"LOGFARE_API_KEY",
	"GROQ_API_KEY",
	"TOGETHER_API_KEY",
]) {
	delete process.env[varName];
}

const {
	customProvidersPath,
	readCustomProviderSpecs,
	registerCustomProviders,
	reloadCustomProviders,
	syncCustomProviders,
	writeCustomProviders,
} = await import("../src/core/custom-providers.ts");
const {
	customProviderIdFromName,
	customProviderKeyVar,
	discoverModels,
} = await import("../src/server/custom-providers.ts");
const { authStore } = await import("../src/store/auth.ts");
const customProvidersRoute = await import("../app/api/custom-providers/route.ts");
const customProviderItemRoute = await import("../app/api/custom-providers/[id]/route.ts");
const customProviderRefreshRoute = await import("../app/api/custom-providers/[id]/refresh/route.ts");

const originalFetch = globalThis.fetch;
const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
function stubFetchJson(payload: unknown, status = 200) {
	fetchCalls.length = 0;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		fetchCalls.push({ url, init });
		return new Response(JSON.stringify(payload), {
			status,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
}

function jsonRequest(method: string, url: string, body?: unknown): Request {
	return new Request(url, {
		method,
		headers: body !== undefined ? { "content-type": "application/json" } : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
}

after(() => {
	globalThis.fetch = originalFetch;
	for (const varName of [
		"OPENROUTER_API_KEY",
		"DEEPGRAM_API_KEY",
		"TAVILY_API_KEY",
		"BRAVE_API_KEY",
		"GOOGLE_SEARCH_API_KEY",
		"GOOGLE_CSE_ID",
		"OPENAI_API_KEY",
		"LOGFARE_API_KEY",
		"GROQ_API_KEY",
		"TOGETHER_API_KEY",
	]) {
		delete process.env[varName];
	}
	fs.rmSync(TMP, { recursive: true, force: true });
});

const MODELS_PAYLOAD = {
	data: [
		{
			id: "z-last",
			display_name: "Z Last",
			endpoints: ["chat/completions"],
			context_length: 100000,
			architecture: { input_modalities: ["text"] },
			chat_capabilities: { reasoning: { supported_efforts: ["none", "low", "high", "max"] } },
		},
		{ id: "generic-model" },
		{
			id: "image-model",
			display_name: "Image Model",
			endpoints: ["chat/completions"],
			context_length: 999,
			architecture: { input_modalities: ["text", "image", "file"] },
			chat_capabilities: { reasoning: { supported_efforts: [] } },
		},
		{
			id: "audio-model",
			display_name: "Audio Model",
			endpoints: ["audio/transcriptions"],
			architecture: {},
			chat_capabilities: {},
		},
		{
			id: "no-none-model",
			display_name: "No None",
			endpoints: ["chat/completions"],
			architecture: { input_modalities: ["text"] },
			chat_capabilities: { reasoning: { supported_efforts: ["low", "high"] } },
		},
		{
			id: "a-first",
			display_name: "A First",
			endpoints: ["chat/completions"],
			architecture: { input_modalities: ["text"] },
			chat_capabilities: { reasoning: false },
		},
	],
};

describe("id / key-var derivation", () => {
	it("slugs names and derives the env var", () => {
		assert.equal(customProviderIdFromName("My Cool Provider!"), "my-cool-provider");
		assert.equal(customProviderIdFromName("  Logfare  "), "logfare");
		assert.equal(customProviderIdFromName("Already--Kebab"), "already-kebab");
		assert.equal(customProviderIdFromName("+++"), "");
		assert.equal(customProviderKeyVar("my-cool-provider"), "CUSTOM_MY-COOL-PROVIDER_API_KEY");
	});
});

describe("discoverModels mapping", () => {
	it("projects Logfare-enriched + generic entries, filters non-chat, sorts by id", async () => {
		stubFetchJson(MODELS_PAYLOAD);
		const models = await discoverModels("https://logfare.test/v1", "sk-throwaway");
		assert.deepEqual(models, [
			{
				id: "a-first",
				name: "A First",
				reasoning: false,
				input: ["text"],
				contextWindow: 128000,
				maxTokens: 65536,
			},
			{
				id: "generic-model",
				name: "generic-model",
				reasoning: false,
				input: ["text"],
				contextWindow: 128000,
				maxTokens: 65536,
			},
			{
				id: "image-model",
				name: "Image Model",
				reasoning: false,
				input: ["text", "image"],
				contextWindow: 999,
				maxTokens: 65536,
			},
			{
				id: "no-none-model",
				name: "No None",
				reasoning: true,
				input: ["text"],
				contextWindow: 128000,
				maxTokens: 65536,
				thinkingLevelMap: {
					off: null,
					minimal: null,
					low: "low",
					medium: null,
					high: "high",
					xhigh: null,
					max: null,
				},
			},
			{
				id: "z-last",
				name: "Z Last",
				reasoning: true,
				input: ["text"],
				contextWindow: 100000,
				maxTokens: 65536,
				thinkingLevelMap: {
					off: "none",
					minimal: null,
					low: "low",
					medium: null,
					high: "high",
					xhigh: null,
					max: "max",
				},
			},
		]);
		assert.equal(fetchCalls.length, 1);
		assert.equal(fetchCalls[0]!.url, "https://logfare.test/v1/models");
		const headers = fetchCalls[0]!.init?.headers as Record<string, string> | undefined;
		assert.equal(headers?.["user-agent"], "learnharness-fork");
		assert.equal(headers?.Authorization, "Bearer sk-throwaway");
	});

	it("sends Authorization only when a key is provided", async () => {
		stubFetchJson({ data: [] });
		await discoverModels("https://logfare.test/v1");
		assert.equal(fetchCalls[0]!.url, "https://logfare.test/v1/models");
		const headers = fetchCalls[0]!.init?.headers as Record<string, string> | undefined;
		assert.equal(headers?.Authorization, undefined);
	});

	it("throws on a non-OK response and on a missing data array", async () => {
		stubFetchJson({ error: "boom" }, 502);
		await assert.rejects(discoverModels("https://logfare.test/v1"), /model discovery failed \(502\)/);
		stubFetchJson({ not: "the shape" }, 200);
		await assert.rejects(discoverModels("https://logfare.test/v1"), /no data array|model discovery failed/);
	});
});

describe("syncCustomProviders (reconciliation seam)", () => {
	it("registers primary + aliases, then deletes stale ids on the next sync", () => {
		writeCustomProviders([
			{
				id: "alpha",
				name: "Alpha",
				baseUrl: "https://a.test/v1",
				apiKeyEnvVar: "CUSTOM_ALPHA_API_KEY",
				aliases: ["alias-a"],
				models: [{ id: "m1" }],
			},
		]);
		reloadCustomProviders();
		const set: string[] = [];
		const deleted: string[] = [];
		const collection = {
			setProvider: (p: unknown) => {
				set.push((p as { id: string }).id);
			},
			deleteProvider: (id: string) => {
				deleted.push(id);
			},
		};
		registerCustomProviders(collection);
		assert.deepEqual([...set].sort(), ["alias-a", "alpha"]);

		// Now the provider disappears from disk — the tracked ids must all be
		// deleted (primary + alias), never orphaned.
		writeCustomProviders([]);
		syncCustomProviders(collection);
		assert.deepEqual([...deleted].sort(), ["alias-a", "alpha"]);
	});
});

describe("CRUD round-trip through the route handlers", () => {
	it("POST discovers + persists; GET lists; 409 conflict; PUT updates; refresh re-discovers; DELETE removes", async () => {
		stubFetchJson(MODELS_PAYLOAD);
		const post = await customProvidersRoute.POST(
			jsonRequest("POST", "http://localhost/api/custom-providers", {
				name: "Logfare Test",
				baseUrl: "https://logfare.test/v1",
				apiKey: "sk-throwaway-logfare",
				alias: "together",
			}),
		);
		assert.equal(post.status, 200);
		const saved = (await post.json()) as { id: string; apiKeyEnvVar: string; models: unknown[] };
		assert.equal(saved.id, "logfare-test");
		assert.equal(saved.apiKeyEnvVar, "CUSTOM_LOGFARE-TEST_API_KEY");
		assert.equal(saved.models.length, 5, "audio-only entry filtered out");

		const file = JSON.parse(fs.readFileSync(customProvidersPath(), "utf8")) as {
			providers: Array<{ id: string; aliases: string[] }>;
		};
		assert.equal(file.providers.length, 1);
		assert.equal(file.providers[0]!.id, "logfare-test");
		assert.deepEqual(file.providers[0]!.aliases, ["together"]);
		assert.equal(authStore.authVars()["CUSTOM_LOGFARE-TEST_API_KEY"], "sk-throwaway-logfare");
		// The env seam: a NEW var is fill-gapped into process.env so pi-ai's
		// live auth resolution sees it without a restart.
		assert.equal(process.env["CUSTOM_LOGFARE-TEST_API_KEY"], "sk-throwaway-logfare");

		const get = await customProvidersRoute.GET();
		const rows = (await get.json()) as Array<{ id: string; modelCount: number; keyPresent: boolean }>;
		assert.equal(rows.length, 1);
		assert.equal(rows[0]!.id, "logfare-test");
		assert.equal(rows[0]!.modelCount, 5);
		assert.equal(rows[0]!.keyPresent, true);

		const dup = await customProvidersRoute.POST(
			jsonRequest("POST", "http://localhost/api/custom-providers", {
				name: "Logfare Test",
				baseUrl: "https://logfare.test/v1",
				apiKey: "sk-other",
			}),
		);
		assert.equal(dup.status, 409);

		const put = await customProviderItemRoute.PUT(
			jsonRequest("PUT", "http://localhost/api/custom-providers/logfare-test", {
				name: "Logfare Renamed",
				alias: "",
				apiKey: "sk-rotated",
			}),
			{ params: Promise.resolve({ id: "logfare-test" }) },
		);
		assert.equal(put.status, 200);
		const updated = (await put.json()) as { name: string; aliases?: string[] };
		assert.equal(updated.name, "Logfare Renamed");
		assert.equal(updated.aliases, undefined);
		assert.equal(authStore.authVars()["CUSTOM_LOGFARE-TEST_API_KEY"], "sk-rotated");
		assert.equal(process.env["CUSTOM_LOGFARE-TEST_API_KEY"], "sk-rotated");

		const refresh = await customProviderRefreshRoute.POST(
			new Request("http://localhost/api/custom-providers/logfare-test/refresh", { method: "POST" }),
			{ params: Promise.resolve({ id: "logfare-test" }) },
		);
		assert.equal(refresh.status, 200);

		const del = await customProviderItemRoute.DELETE(
			new Request("http://localhost/api/custom-providers/logfare-test", { method: "DELETE" }),
			{ params: Promise.resolve({ id: "logfare-test" }) },
		);
		assert.equal(del.status, 200);
		assert.deepEqual(readCustomProviderSpecs(), []);
		assert.equal("CUSTOM_LOGFARE-TEST_API_KEY" in authStore.authVars(), false);
		// The fill-gapped env copy is removed too (a REAL env var would stay).
		assert.equal(process.env["CUSTOM_LOGFARE-TEST_API_KEY"], undefined);

		const missing = await customProviderItemRoute.DELETE(
			new Request("http://localhost/api/custom-providers/logfare-test", { method: "DELETE" }),
			{ params: Promise.resolve({ id: "logfare-test" }) },
		);
		assert.equal(missing.status, 404);
	});

	it("malformed POST bodies are 400s — never written", async () => {
		const bad = await customProvidersRoute.POST(
			jsonRequest("POST", "http://localhost/api/custom-providers", {
				name: "X",
				baseUrl: "ftp://nope/v1",
				apiKey: "k",
			}),
		);
		assert.equal(bad.status, 400);
		assert.deepEqual(readCustomProviderSpecs(), []);
	});
});