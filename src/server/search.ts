/**
 * The search engines' server composition (search port + model slots wave,
 * 2026-09-20): the Tavily + Brave adapters behind the core port
 * (core/search.ts) + the live-engine resolution the settings UI and the
 * agent-layer tool both read.
 *
 * Owner decisions (2026-09-20) baked in:
 *  - NO default engine: an engine is live iff its key is present (auth
 *    store or env — env wins, keyed via server/keys.ts keyValue).
 *  - Setting a key is ALL the user does — auto-detection: explicit
 *    agent.search.engine pins the preference (when BOTH keys are present
 *    the preference order is Tavily → Brave); without a pin, whichever
 *    engine has a key is the engine.
 *  - An explicit choice does NOT silently fall back to the other engine:
 *    engine pinned but its key missing = honestly unavailable (reason
 *    says so) — no guessing what the user meant.
 *
 * The adapters are injected dependencies (fetch-shaped) so the agent-layer
 * tool depends on the PORT only and tests never touch the network.
 */

import type { SearchEngineId, SearchHit, SearchProvider, SearchStatus } from "../core/search.ts";
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

/** The engine's key (env-or-file; env wins) — null when the engine is
 *  not keyed, which by owner decision means NOT LIVE. A keyless engine
 *  (DuckDuckGo) returns "" — live by construction, no key row. */
function engineKey(id: SearchEngineId): string | null {
	const entry = ENGINE_ORDER.find((e) => e.id === id);
	if (entry?.keyless) return "";
	const value = entry?.envVar ? keyValue(entry.envVar) : undefined;
	return value ? value : null;
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
	const envVarOf = (id: SearchEngineId) => ENGINE_ORDER.find((e) => e.id === id)?.envVar ?? id.toUpperCase() + "_API_KEY";
	const pinnedKey = pinned ? keys[pinned] ?? null : null;
	if (pinned) {
		// Keyless pin (DuckDuckGo): live by construction.
		if (ENGINE_ORDER.find((e) => e.id === pinned)?.keyless) {
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
	for (const { id, keyless } of ENGINE_ORDER) {
		if (keyless) return { available: true, engine: id, reason: `search engine: ${id} (no key needed)`, key: "" };
		const key = keys[id] ?? null;
		if (key) return { available: true, engine: id, reason: `search engine: ${id} (auto)`, key };
	}
	return {
		available: false,
		engine: null,
		reason: "no search engine configured — set a Tavily or Brave search API key",
		key: null,
	};
}

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

/** The live search state (the honest availability signal): reads the
 *  settings record's pin + the auth store fresh each call, so a key saved
 *  mid-session activates on the next check (no restart). */
export function searchStatus(): SearchStatus {
	const { available, engine, reason } = resolveSearchEngineFor(
		effectiveSettings().agent.search?.engine,
		{
			tavily: engineKey("tavily") ?? undefined,
			brave: engineKey("brave") ?? undefined,
		},
	);
	return { available, engine, reason };
}

/** Search available at all? (the settings UI's gray-out signal + the
 *  researcher's enable/disable pin — Teacher stream's rewiring reads this.) */
export function searchAvailable(): boolean {
	return searchStatus().available;
}

/** The LIVE adapter, or null when unavailable. Composed fresh each call —
 *  the tool layer (Teacher stream) calls this once per search, so key
 *  rotations take effect immediately. */
export function searchProvider(): SearchProvider | null {
	const resolved = resolveSearchEngineFor(effectiveSettings().agent.search?.engine, {
		tavily: engineKey("tavily") ?? undefined,
		brave: engineKey("brave") ?? undefined,
	});
	if (!resolved.available || resolved.key === null) return null;
	return resolved.engine === "tavily" ? tavilyProvider(resolved.key) : resolved.engine === "brave" ? braveProvider(resolved.key) : duckduckgoProvider();
}
