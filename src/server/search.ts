/**
 * The search engines' server composition (search port + model slots wave,
 * 2026-09-20): search adapters behind the core port
 * (core/search.ts) + the live-engine resolution the settings UI and the
 * agent-layer tool both read.
 *
 * Owner decisions (2026-09-20) baked in:
 *  - NO default engine: an engine is live iff its key is present (auth
 *    store or env — env wins, keyed via server/keys.ts keyValue).
 *  - Setting a key is ALL the user does — auto-detection: explicit
 *    agent.search.engine pins the preference (when several keys are
 *    present the order is Tavily → Brave → Exa → Firecrawl → Ollama);
 *    without a pin, the first keyed engine wins.
 *  - An explicit choice does NOT silently fall back to another engine:
 *    engine pinned but its key missing = honestly unavailable (reason
 *    says so) — no guessing what the user meant.
 *
 * The adapters are injected dependencies (fetch-shaped) so the agent-layer
 * tool depends on the PORT only and tests never touch the network.
 */

import { SEARCH_ENGINES, type SearchEngineId, type SearchHit, type SearchProvider, type SearchStatus } from "../core/search.ts";
import { keyValue } from "./keys.ts";
import { effectiveSettings } from "./stores.ts";

/** The wire-callable shape the adapters close over (tests inject a stub). */
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Tavily: POST https://api.tavily.com/search — Bearer auth in the
 *  Authorization header (the current documented scheme; the legacy
 *  api_key-in-body form is retired), query + max_results (0–20) in the
 *  JSON body. VERIFIED against docs.tavily.com's OpenAPI, 2026-09-20:
 *  response {results: [{title, url, content, score, …}]}, errors
 *  {detail: {error}}. */
export function tavilyProvider(apiKey: string, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "tavily",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const resp = await fetchFn("https://api.tavily.com/search", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({ query, max_results: Math.min(count, 20) }),
				signal: AbortSignal.timeout(30_000),
			});
			if (!resp.ok) {
				const body = await resp.text();
				// Their error body is {detail: {error: "…"}} — surface the
				// message when present, else the raw slice.
				let detail = body.slice(0, 200);
				try {
					const parsed = JSON.parse(body) as { detail?: { error?: string } };
					if (parsed.detail?.error) detail = parsed.detail.error.slice(0, 200);
				} catch {
					/* keep the raw slice */
				}
				throw new Error(`Tavily search API ${resp.status}: ${detail}`);
			}
			const data = (await resp.json()) as {
				results?: Array<{ title?: string; url?: string; content?: string }>;
			};
			return (data.results ?? [])
				.filter((r) => typeof r.url === "string" && r.url)
				.map((r) => ({
					title: r.title ?? r.url ?? "",
					url: r.url ?? "",
					snippet: (r.content ?? "").replace(/\n/g, " ").slice(0, 500),
				}));
		},
	};
}

/** Brave: GET https://api.search.brave.com/res/v1/web/search with the
 *  key in the X-Subscription-Token header. VERIFIED against Brave's
 *  dashboard docs, 2026-09-20: count max 20; response
 *  {web: {results: [{title, url, description, …}]}}. */
export function braveProvider(apiKey: string, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "brave",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const url = new URL("https://api.search.brave.com/res/v1/web/search");
			url.searchParams.set("q", query);
			url.searchParams.set("count", String(Math.min(count, 20)));
			const resp = await fetchFn(url.toString(), {
				headers: {
					accept: "application/json",
					"x-subscription-token": apiKey,
				},
				signal: AbortSignal.timeout(30_000),
			});
			if (!resp.ok) {
				const body = await resp.text();
				throw new Error(`Brave search API ${resp.status}: ${body.slice(0, 200)}`);
			}
			const data = (await resp.json()) as {
				web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
			};
			return (data.web?.results ?? [])
				.filter((r) => typeof r.url === "string" && r.url)
				.map((r) => ({
					title: r.title ?? r.url ?? "",
					url: r.url ?? "",
					snippet: (r.description ?? "").replace(/\n/g, " ").slice(0, 500),
				}));
		},
	};
}

/** The engines this wave ships, in PREFERENCE order (both keys present,
 *  no explicit pin → the first live engine wins; owner decision
 *  2026-09-20: Tavily first — the AI-native search API the wave chose).
 *  DuckDuckGo (assistant wave, personal fork): KEYLESS — `keyless: true`
 *  marks an engine that is always live (no key row, no env var); it sits
 *  LAST in preference order so a real keyed engine wins auto-resolution
 *  when one exists, but search never hard-fails for want of a key. */
const ENGINE_ORDER: ReadonlyArray<{ id: SearchEngineId; envVar?: string; keyless?: boolean }> = [
	{ id: "tavily", envVar: "TAVILY_API_KEY" },
	{ id: "brave", envVar: "BRAVE_API_KEY" },
	{ id: "duckduckgo", keyless: true },
];


/** DuckDuckGo: the KEYLESS html endpoint (assistant wave, personal fork).
 *  POST https://html.duckduckgo.com/html/ with form `q=<query>` — the
 *  results page (class-based markup: result__a links + result__snippet
 *  texts) is scraped with a tolerant regex pass; the hrefs are DDG's
 *  redirect wrappers (`//duckduckgo.com/l/?uddg=<encoded>&…`), so the
 *  real target URL is decoded from the uddg param. No account, no key —
 *  the tradeoff is scraping fragility: a parse miss returns an honest
 *  error (the tool layer reports it), never fabricated results. */
export function duckduckgoProvider(fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "duckduckgo",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const resp = await fetchFn("https://html.duckduckgo.com/html/", {
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					// The endpoint 403s default tooling UAs in waves — a browser
					// shape keeps the door open (honest scraping, no spoofed
					// referer/cookies).
					"user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
				},
				body: new URLSearchParams({ q: query }).toString(),
				signal: AbortSignal.timeout(30_000),
			});
			if (!resp.ok) {
				const body = await resp.text();
				throw new Error(`DuckDuckGo search ${resp.status}: ${body.slice(0, 200)}`);
			}
			const html = await resp.text();
			const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
			const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
			const snippets: string[] = [];
			for (let m = snippetRe.exec(html); m; m = snippetRe.exec(html)) snippets.push(stripHtml(m[1]!));
			const hits: SearchHit[] = [];
			let i = 0;
			for (let m = linkRe.exec(html); m && hits.length < Math.min(count, 20); m = linkRe.exec(html)) {
				const url = unwrapDdgHref(m[1]!);
				if (!url) continue;
				hits.push({ title: stripHtml(m[2]!), url, snippet: snippets[i] ?? "" });
				i++;
			}
			if (hits.length === 0) {
				throw new Error("DuckDuckGo search returned no parseable results (the html endpoint's markup may have changed or the query was rate-limited)");
			}
			return hits;
		},
	};
}

/** DDG redirect href → the real target URL: `//duckduckgo.com/l/?uddg=<enc>&rut=…`
 *  decodes the uddg param; a plain http(s) href passes through untouched;
 *  anything else (relative junk, protocol shims) → null (row skipped). */
function unwrapDdgHref(href: string): string | null {
	if (href.startsWith("//duckduckgo.com/l/?") || href.startsWith("https://duckduckgo.com/l/?") || href.startsWith("http://duckduckgo.com/l/?")) {
		try {
			const uddg = new URLSearchParams(href.slice(href.indexOf("?") + 1)).get("uddg");
			return uddg && /^https?:\/\//.test(uddg) ? uddg : null;
		} catch {
			return null;
		}
	}
	return /^https?:\/\//.test(href) ? href : null;
}

/** Crude entity/tag cleanup for scraped titles and snippets (no DOM in
 *  the server bundle): drop tags, decode the entities DDG actually emits. */
function stripHtml(s: string): string {
	const text = s.replace(/<[^>]*>/g, " ");
	const decoded = text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;|&#39;/g, "'")
		.replace(/&nbsp;/g, " ");
	return decoded.replace(/\s+/g, " ").trim();
}

/** Invalid JSON must not echo provider response bodies into tool results. */
async function searchJson(response: Response, label: string): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		throw new Error(`${label} search API returned an invalid response`);
	}
}

/** Exa's Search API returns highlights when requested. Its result snippets
 * are normalized to the same bounded, provider-neutral shape as the other
 * adapters. Do not expose error bodies, which may contain credentials. */
export function exaProvider(apiKey: string, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "exa",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const resp = await fetchFn("https://api.exa.ai/search", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": apiKey },
				body: JSON.stringify({ query, type: "auto", numResults: Math.min(100, Math.max(1, Math.floor(count))), contents: { highlights: true } }),
				signal: AbortSignal.timeout(30_000),
			});
			if (!resp.ok) throw new Error(`Exa search API ${resp.status}`);
			const data = await searchJson(resp, "Exa");
			if (!data || typeof data !== "object" || !Array.isArray((data as { results?: unknown }).results)) {
				throw new Error("Exa search API returned an invalid response");
			}
			return (data as { results: unknown[] }).results.flatMap((result): SearchHit[] => {
				if (!result || typeof result !== "object") return [];
				const row = result as { title?: unknown; url?: unknown; highlights?: unknown; text?: unknown };
				if (typeof row.url !== "string" || !row.url.trim()) return [];
				try {
					const protocol = new URL(row.url).protocol;
					if (protocol !== "http:" && protocol !== "https:") return [];
				} catch { return []; }
				const highlights = Array.isArray(row.highlights) ? row.highlights.filter((v): v is string => typeof v === "string").join(" ") : "";
				const snippet = highlights || (typeof row.text === "string" ? row.text : "");
				return [{ title: typeof row.title === "string" && row.title ? row.title : row.url, url: row.url, snippet: snippet.replace(/\s+/g, " ").trim().slice(0, 500) }];
			});
		},
	};
}

/** Firecrawl's v2 search API: no scrapeOptions, so web_fetch still owns
 *  page bodies. Wire shape checked against the official 2026-11-03 snapshot;
 *  live account access and pricing are not inferred from configuration. */
export function firecrawlProvider(apiKey: string, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "firecrawl",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const resp = await fetchFn("https://api.firecrawl.dev/v2/search", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({ query, limit: Math.min(100, Math.max(1, Math.floor(count))) }),
				signal: AbortSignal.timeout(30_000),
			});
			if (!resp.ok) throw new Error(`Firecrawl search API ${resp.status}`);
			const data = await searchJson(resp, "Firecrawl");
			if (!data || typeof data !== "object" || (data as { success?: unknown }).success !== true) {
				throw new Error("Firecrawl search API returned an invalid response");
			}
			const payload = (data as { data?: unknown }).data;
			if (!payload || typeof payload !== "object" || !Array.isArray((payload as { web?: unknown }).web)) {
				throw new Error("Firecrawl search API returned an invalid response");
			}
			return (payload as { web: unknown[] }).web.flatMap((result): SearchHit[] => {
				if (!result || typeof result !== "object") return [];
				const row = result as { title?: unknown; url?: unknown; description?: unknown };
				return searchHit(row.title, row.url, row.description);
			});
		},
	};
}

/** Hosted search only, adapted from chiranjivsethi's PR #81 (a216fa8).
 *  No local model URL, model registration, or provider-backed page fetch. */
export function ollamaProvider(apiKey: string, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "ollama",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const resp = await fetchFn("https://ollama.com/api/web_search", {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
				body: JSON.stringify({ query, max_results: Math.min(10, Math.max(1, Math.floor(count))) }),
				signal: AbortSignal.timeout(30_000),
			});
			if (!resp.ok) throw new Error(`Ollama search API ${resp.status}`);
			const data = await searchJson(resp, "Ollama");
			if (!data || typeof data !== "object" || !Array.isArray((data as { results?: unknown }).results)) {
				throw new Error("Ollama search API returned an invalid response");
			}
			return (data as { results: unknown[] }).results.flatMap((result): SearchHit[] => {
				if (!result || typeof result !== "object") return [];
				const row = result as { title?: unknown; url?: unknown; content?: unknown };
				return searchHit(row.title, row.url, row.content);
			});
		},
	};
}

/** Match Exa's bounded result contract for the other new adapters. */
function searchHit(title: unknown, url: unknown, snippet: unknown): SearchHit[] {
	if (typeof url !== "string" || !url.trim()) return [];
	try {
		const protocol = new URL(url).protocol;
		if (protocol !== "http:" && protocol !== "https:") return [];
	} catch { return []; }
	return [{
		title: typeof title === "string" && title ? title : url,
		url,
		snippet: typeof snippet === "string" ? snippet.replace(/\s+/g, " ").trim().slice(0, 500) : "",
	}];
}

/** The engine's key (env-or-file; env wins) — null when the engine is
 *  not keyed, which by owner decision means NOT LIVE. A keyless engine
 *  (DuckDuckGo) returns "" — live by construction, no key row. */
function engineKey(id: SearchEngineId): string | null {
	const entry = SEARCH_ENGINES.find((e) => e.id === id);
	if (entry?.keyless) return "";
	const value = entry?.envVar ? keyValue(entry.envVar) : undefined;

	return value ? value : null;
}

/** Every engine's live key, read fresh (the resolver's input). */
function engineKeys(): Partial<Record<SearchEngineId, string>> {
	const keys: Partial<Record<SearchEngineId, string>> = {};
	for (const { id } of SEARCH_ENGINES) {
		const key = engineKey(id);
		if (key) keys[id] = key;
	}
	return keys;
}

/** Resolve the search state PURELY from the given pins (testable): the
 *  explicit engine (if pinned) wins but must be keyed — a KEYLESS engine
 *  is always satisfiable; absent pin → first keyed engine in preference
 *  order, falling to the keyless engine (search works out of the box).
 *  Never throws. */
export function resolveSearchEngineFor(
	pinned: SearchEngineId | undefined,
	/** Per-engine live keys (absent engine = absent property is fine). */
	keys: Partial<Record<SearchEngineId, string | undefined>>,
): SearchStatus & { key: string | null } {
	const envVarOf = (id: SearchEngineId) => SEARCH_ENGINES.find((e) => e.id === id)?.envVar ?? `${id.toUpperCase()}_API_KEY`;
	const pinnedKey = pinned ? keys[pinned] ?? null : null;
	if (pinned) {
		// Keyless pin (DuckDuckGo): live by construction.
		const entry = SEARCH_ENGINES.find((e) => e.id === pinned);
		if (entry && "keyless" in entry && entry.keyless) {
			return { available: true, engine: pinned, reason: `search engine: ${pinned} (chosen, no key needed)`, key: "" };
		}
		if (!pinnedKey) {
			return {
				available: false,
				engine: null,
				reason: `search engine is set to "${pinned}" but its API key is missing — set the ${envVarOf(pinned)} key (or pin DuckDuckGo, which needs no key)`,
				key: null,
			};
		}
		return { available: true, engine: pinned, reason: `search engine: ${pinned} (chosen)`, key: pinnedKey };
	}
	for (const { id, keyless } of SEARCH_ENGINES) {
		if (keyless) return { available: true, engine: id, reason: `search engine: ${id} (no key needed)`, key: "" };
		const key = keys[id] ?? null;
		if (key) return { available: true, engine: id, reason: `search engine: ${id} (auto)`, key };
	}
	return {
		available: false,
		engine: null,
		reason: "no search engine configured — set a Tavily, Brave, Exa, Firecrawl, or Ollama search API key",
		key: null,
	};
}

/** The live search state (the honest availability signal): reads the
 *  settings record's pin + the auth store fresh each call, so a key saved
 *  mid-session activates on the next check (no restart). */
export function searchStatus(): SearchStatus {
	const { available, engine, reason } = resolveSearchEngineFor(
		effectiveSettings().agent.search?.engine,
		engineKeys(),
	);
	return { available, engine, reason };
}

/** Search status only — research itself remains available without a key. */
export function searchAvailable(): boolean {
	return searchStatus().available;
}

/** The LIVE adapter, or null when unavailable. Composed fresh each call —
 *  the tool layer (Teacher stream) calls this once per search, so key
 *  rotations take effect immediately. */
export function searchProvider(): SearchProvider | null {
	const resolved = resolveSearchEngineFor(effectiveSettings().agent.search?.engine, engineKeys());
	if (!resolved.available || resolved.key === null) return null;
	switch (resolved.engine) {
		case "tavily":
			return tavilyProvider(resolved.key);
		case "brave":
			return braveProvider(resolved.key);
		case "exa":
			return exaProvider(resolved.key);
		case "firecrawl":
			return firecrawlProvider(resolved.key);
		case "ollama":
			return ollamaProvider(resolved.key);
		case "duckduckgo":
			return duckduckgoProvider();
		default:
			return null;
	}
}
