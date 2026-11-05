/**
 * Empty-graph chrome pins (empty-graph chrome wave, owner 2026-09-25):
 * Import Notes renders ALWAYS — the one action that works on an empty
 * graph, the entry point itself; search + settings render only when the
 * snapshot has nodes (dead controls are lies — the honesty principle).
 * GraphChromeRow is the pure seam (the DeleteNodeBody pattern): SSR of
 * both states pins the ruling. Fetches don't run under renderToStaticMarkup
 * (effects never fire), so these pins exercise the component directly.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GraphChromeRow, GraphView } from "../components/graph-view.tsx";
import type { GraphRenderSettings } from "../components/graph-canvas.ts";
import { ServerEventsProvider } from "../components/server-events.tsx";

/** Ref doubles — the SSR harness never attaches them. */
const ref = { current: null };

const PROPS = {
	query: "",
	onQuery: () => {},
	noMatch: false,
	importing: false,
	searchInputRef: ref,
	onImportFiles: () => {},
	settings: {} as GraphRenderSettings,
	changeSettings: () => {},
	onOpenChains: () => {},
};

describe("GraphChromeRow — the empty-graph ruling (owner, 2026-09-25)", () => {
	it("EMPTY graph: Import Notes renders (the entry point), search + chains + settings absent", () => {
		const html = renderToStaticMarkup(createElement(GraphChromeRow, { ...PROPS, isEmpty: true }));
		assert.ok(html.includes('data-testid="import-notes"'));
		assert.ok(html.includes("Extract files…"));
		assert.ok(html.includes("lucide-waypoints"));
		assert.ok(!html.includes("lucide-upload"));
		assert.ok(!html.includes("Search nodes…"), "search is a lie on an empty graph");
		// the settings gear is the lucide-settings svg (tooltip wave: its old
		// native title is gone — the styled tooltip carries the label now)
		assert.ok(!html.includes("lucide-settings"), "settings is a lie on an empty graph");
		assert.ok(!html.includes('data-testid="open-chain-table"'), "chains is a lie on an empty graph");
		assert.ok(!html.includes("graph-chrome-fade-in"), "nothing gated = nothing fading in");
	});

	it("empty graph uses the same session-first lead and secondary material guidance as home", async () => {
		// GraphView is a client component with useRouter (the topic chat
		// door) — the SSR render needs the app-router context stubbed.
		const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
		const router = { push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: async () => {}, bfcacheId: "test-bfcache" };
		const html = renderToStaticMarkup(
			createElement(AppRouterContext.Provider, { value: router }, createElement(ServerEventsProvider, { children: createElement(GraphView, {}) })),
		);
		assert.ok(html.includes("<p>Start a session to begin learning.</p>"));
		assert.ok(html.includes("Attach your material with the paperclip or drag and drop.</p>"));
		assert.ok(!html.includes("import notes to build"));
	});

	it("POPULATED graph: all five render, the gated quartet carries the fade", () => {
		const html = renderToStaticMarkup(createElement(GraphChromeRow, { ...PROPS, isEmpty: false }));
		assert.ok(html.includes('data-testid="import-notes"'));
		assert.ok(html.includes("Search nodes…"));
		assert.ok(html.includes("lucide-settings"), "the settings gear renders");
		assert.ok(html.includes('data-testid="open-chain-table"'), "the chains entry renders");
		assert.ok(html.includes('data-testid="topics-toggle"'), "the topics entry renders (topics v1, personal fork)");
		// the appear-once fade rides exactly the four gated controls, never Import Notes
		assert.equal(html.split("graph-chrome-fade-in").length - 1, 4, "four fade carriers: search + chains + topics + settings");
	});

	it("the no-match note renders only when the wrapper says so (its truth stays upstream)", () => {
		const html = renderToStaticMarkup(
			createElement(GraphChromeRow, { ...PROPS, isEmpty: false, query: "zzz", noMatch: true }),
		);
		assert.ok(html.includes("No matching nodes."));
		const quiet = renderToStaticMarkup(
			createElement(GraphChromeRow, { ...PROPS, isEmpty: false, query: "zzz", noMatch: false }),
		);
		assert.ok(!quiet.includes("No matching nodes."));
	});
});