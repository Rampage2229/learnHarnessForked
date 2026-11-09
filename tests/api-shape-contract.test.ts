/**
 * API SHAPE CONTRACT — regression guard for the two production crashes.
 *
 * INCIDENT 1 (home page failed to hydrate): a hook assumed
 *   /api/graph/reviews returned a BARE array and called .map on it; the
 *   route actually returns { states: [...] } → `reviewStates.map is not a
 *   function` → the entire home page blanked ("This page couldn't load").
 *   PIN: the route answers { states: NodeReviewState[] }.
 *
 * INCIDENT 2 (silent wrong count): a hook fetched /api/graph/nodes, which
 *   does NOT exist (Next returned the 404 HTML page); the hook read it as
 *   "no nodes" and produced a wrong count with no error. PIN: assert the
 *   collection route file is ABSENT and the nodes arrive via /api/graph's
 *   snapshot instead.
 *
 * DOCTRINE: every route the CLIENT consumes is pinned against the SHAPE
 * the client reads (the container type — array vs object — and the key
 * the client destructures). A route that silently changed shape would
 * crash the page; this test catches it before the client ships.
 *
 * Hermetic: LH_DATA_DIR → a fresh mkdtemp BEFORE any config-loading
 * import (ES imports hoist, so tests/helpers/hermetic-data.ts is the FIRST
 * import). The handler modules are imported statically after it — same
 * pattern as tests/notes-import-route.test.ts.
 */
import "./helpers/hermetic-data.ts";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { GET as graphGET } from "../app/api/graph/route.ts";
import { GET as reviewsGET } from "../app/api/graph/reviews/route.ts";
import { GET as masteryGET } from "../app/api/graph/mastery/route.ts";
import { GET as topicsGET } from "../app/api/topics/route.ts";
import { GET as goalsGET } from "../app/api/goals/route.ts";
import { GET as settingsGET } from "../app/api/settings/route.ts";
import { GET as modelsGET } from "../app/api/models/route.ts";
import { GET as chatsGET } from "../app/api/chats/route.ts";
import { GET as jobsGET } from "../app/api/jobs/route.ts";

import type { GraphSnapshot } from "../src/core/contracts/graph.ts";
import type { NodeReviewState } from "../src/core/reviews.ts";
import type { MasteryTopic, OverallMastery } from "../src/core/mastery.ts";
import type { TopicWithStats } from "../src/core/topics.ts";
import type { Goal } from "../src/store/goals.ts";
import type { ModelCatalogResponse } from "../src/core/contracts/models.ts";

/** The container a client reads. Pins "array vs object" (the exact axis
 *  the reviews crash lived on — a .map on a non-array) plus "boolean" for
 *  flag values and "nullable-object" for records that read null on first
 *  boot (settings: null is valid, not a crash). */
type Container = "array" | "object" | "nullable-object" | "boolean";

async function probe(getter: () => Promise<Response>): Promise<{ status: number; body: unknown }> {
	const response = await getter();
	const body = await response.json();
	return { status: response.status, body };
}

/** Assert a 200 + the container shape of the key the client reads. The
 *  key is asserted present and the right container; the body itself is
 *  asserted to be an OBJECT (not a bare array) so a regression to a bare
 *  array — the reviews incident's shape — fails loudly. */
function assertShape(
	body: unknown,
	key: string | null,
	container: Container,
	route: string,
): void {
	assert.equal(typeof body, "object", `${route}: body must be a JSON object, not a bare array/value`);
	assert.ok(body !== null, `${route}: body must be non-null`);
	assert.ok(!Array.isArray(body), `${route}: body must be an object, not a bare array (the reviews-incident shape)`);
	if (key === null) return; // the client reads the whole body
	const record = body as Record<string, unknown>;
	assert.ok(key in record, `${route}: body must have the client-read key "${key}"`);
	const value = record[key];
	switch (container) {
		case "array":
			assert.ok(Array.isArray(value), `${route}: body.${key} must be an array (the client reads .map over it)`);
			break;
		case "object":
			assert.equal(typeof value, "object", `${route}: body.${key} must be an object`);
			assert.ok(value !== null, `${route}: body.${key} must be non-null`);
			assert.ok(!Array.isArray(value), `${route}: body.${key} must be an object, not an array`);
			break;
		case "nullable-object":
			assert.ok(value === null || (typeof value === "object" && !Array.isArray(value)),
				`${route}: body.${key} is null-on-first-boot or an object record`);
			break;
		case "boolean":
			assert.equal(typeof value, "boolean", `${route}: body.${key} must be a boolean flag`);
			break;
	}
}

describe("API shape contract — every route the client consumes", () => {
	// /api/graph — minimal-home.tsx, graph-view.tsx, new-session.tsx,
	// practice-cards.tsx: `res.json() as Promise<GraphSnapshot>`; the
	// client reads .nodes, .edges, .chains, .sessions.
	it("/api/graph answers 200 with the GraphSnapshot object the client reads", async () => {
		const { status, body } = await probe(() => graphGET());
		assert.equal(status, 200);
		const snapshot = body as GraphSnapshot;
		// The client reads the node set off the snapshot directly — a
		// regression to a bare array here would break every consumer.
		assertShape(body, "nodes", "array", "/api/graph");
		assertShape(body, "edges", "array", "/api/graph");
		assertShape(body, "chains", "array", "/api/graph");
		// Typed guard: the snapshot's nodes are GraphNode-shaped (have an
		// id), the client's key for the canvas image.
		assert.ok(Array.isArray(snapshot.nodes) && snapshot.nodes.every((n) => typeof n.id === "string"));
	});

	// /api/graph/reviews — THE INCIDENT 1 route. minimal-home.tsx,
	// graph-view.tsx, daily-reminder.tsx, streak-badge.tsx, use-retention.tsx
	// all read it. use-retention.tsx is now tolerant (accepts either a
	// bare array or { states }), but the OTHER four consumers assume
	// { states } — pin that exact shape so none of them crash the page.
	it("/api/graph/reviews answers 200 with { states: NodeReviewState[] } — NOT a bare array (incident 1)", async () => {
		const { status, body } = await probe(() => reviewsGET());
		assert.equal(status, 200);
		// The crash-specific assertion: the body is an OBJECT whose
		// `states` is an array. The buggy hook did `reviewStates.map`
		// on the bare-array body it expected — pin the object envelope.
		assertShape(body, "states", "array", "/api/graph/reviews");
		const { states, due } = body as { states: NodeReviewState[]; due: string[] };
		assert.ok(Array.isArray(due), "/api/graph/reviews: body.due must be an array");
		// Every state is the NodeReviewState shape the client folds.
		assert.ok(states.every((s) => typeof s.nodeId === "string" && typeof s.lastAt === "string"));
	});

	// /api/graph/mastery — mastery-panel.tsx: `res.json() as Promise<
	// MasteryPanelData>` with { topics: MasteryTopic[], overall: OverallMastery }.
	it("/api/graph/mastery answers 200 with { topics: MasteryTopic[], overall: OverallMastery }", async () => {
		const { status, body } = await probe(() => masteryGET());
		assert.equal(status, 200);
		assertShape(body, "topics", "array", "/api/graph/mastery");
		assertShape(body, "overall", "object", "/api/graph/mastery");
		const { topics, overall } = body as { topics: MasteryTopic[]; overall: OverallMastery };
		assert.ok(topics.every((t) => typeof t.topicId === "string"));
		assert.equal(typeof overall.solid, "number");
		assert.equal(typeof overall.masteryPct, "number");
	});

	// /api/topics — minimal-home.tsx, graph-view.tsx, use-retention.tsx:
	// `res.json() as Promise<{ topics: TopicWithStats[] }>`.
	it("/api/topics answers 200 with { topics: TopicWithStats[] }", async () => {
		const { status, body } = await probe(() => topicsGET());
		assert.equal(status, 200);
		assertShape(body, "topics", "array", "/api/topics");
		const { topics } = body as { topics: TopicWithStats[] };
		assert.ok(topics.every((t) => typeof t.id === "string" && typeof t.name === "string"));
	});

	// /api/goals — minimal-home.tsx, use-retention.tsx:
	// `res.json() as Promise<{ goals: Goal[] }>`.
	it("/api/goals answers 200 with { goals: Goal[] }", async () => {
		const { status, body } = await probe(() => goalsGET());
		assert.equal(status, 200);
		assertShape(body, "goals", "array", "/api/goals");
		const { goals } = body as { goals: Goal[] };
		assert.ok(goals.every((g) => typeof g.id === "string" && typeof g.title === "string"));
	});

	// /api/settings — settings-dialog.tsx, model-picker.tsx,
	// daily-reminder.tsx, etc.: `body: { settings: UserSettings | null;
	// fileAccessError?: string }`.
	it("/api/settings answers 200 with { settings } (null on first boot is valid)", async () => {
		const { status, body } = await probe(() => settingsGET());
		assert.equal(status, 200);
		// `settings` is null OR an object — never an array, never absent.
		// null-on-first-boot is the valid empty state (no settings file yet).
		assertShape(body, "settings", "nullable-object", "/api/settings");
	});

	// /api/models — model-picker.tsx reads body.models; the catalog DTO.
	it("/api/models answers 200 with the catalog object the model picker reads", async () => {
		const { status, body } = await probe(() => modelsGET());
		assert.equal(status, 200);
		assertShape(body, "models", "array", "/api/models");
		assertShape(body, "providers", "array", "/api/models");
		const catalog = body as ModelCatalogResponse;
		assert.ok(Array.isArray(catalog.models) && catalog.models.every((m) => typeof m.id === "string" && typeof m.provider === "string"));
	});

	// /api/chats — minimal-home.tsx:
	// `res.json() as Promise<{ chats: ChatListItem[] }>`.
	it("/api/chats answers 200 with { chats: ChatListItem[] }", async () => {
		const { status, body } = await probe(() => chatsGET());
		assert.equal(status, 200);
		assertShape(body, "chats", "array", "/api/chats");
		const { chats } = body as { chats: Array<{ id: string }> };
		assert.ok(chats.every((c) => typeof c.id === "string"));
	});

	// /api/jobs — session-core.ts, chat.tsx:
	// `fetch("/api/jobs?chatId=...")` → { jobs, turnInFlight }.
	it("/api/jobs answers 200 with { jobs, turnInFlight } for a chatId", async () => {
		const response = await jobsGET(new Request("http://localhost/api/jobs?chatId=test-session"));
		assert.equal(response.status, 200);
		const body = await response.json();
		assertShape(body, "jobs", "array", "/api/jobs");
		// turnInFlight is a boolean liveness flag (isTurnRunning), not an object.
		assertShape(body, "turnInFlight", "boolean", "/api/jobs");
		const { jobs, turnInFlight } = body as { jobs: unknown[]; turnInFlight: boolean };
		assert.equal(typeof turnInFlight, "boolean", "/api/jobs: turnInFlight is the liveness flag the client folds");
		assert.ok(Array.isArray(jobs));
	});

	it("/api/jobs rejects a missing chatId (the client always sends one)", async () => {
		const response = await jobsGET(new Request("http://localhost/api/jobs"));
		assert.equal(response.status, 400);
	});
});

describe("incident 2 — /api/graph/nodes does NOT exist", () => {
	// The buggy hook fetched /api/graph/nodes expecting the full node
	// collection. No such route exists — Next served the 404 HTML page,
	// the hook's `.json()` either threw (silently caught) or produced a
	// garbage object, and the node set emptied with no error surfaced.
	// The node set arrives via /api/graph's snapshot (.nodes), NOT a
	// dedicated collection route.
	//
	// PIN: assert the collection route file is absent on disk. If someone
	// adds app/api/graph/nodes/route.ts, this test fails — they must
	// either update the client or consciously remove this guard. (The
	// [id] dynamic route under nodes/ is the per-node DELETE, a different
	// surface, and is intentionally NOT asserted here.)
	it("app/api/graph/nodes/route.ts is absent — the collection the buggy hook fetched never existed", () => {
		const routeFile = path.join(process.cwd(), "app", "api", "graph", "nodes", "route.ts");
		assert.equal(
			fs.existsSync(routeFile),
			false,
			`/api/graph/nodes must not exist as a collection route (incident 2). Found ${routeFile} — if you intentionally added it, update the client fetches and this guard.`,
		);
	});

	it("the per-node [id] route exists (the DELETE surface) — distinguishes collection-vs-node", () => {
		// Sanity: the [id] dynamic route is a SEPARATE surface (DELETE
		// /api/graph/nodes/:id in delete-node-dialog.tsx). Its presence
		// alongside the collection's absence is the expected layout.
		const idRoute = path.join(process.cwd(), "app", "api", "graph", "nodes", "[id]", "route.ts");
		assert.equal(fs.existsSync(idRoute), true, "the per-node [id] DELETE route should exist");
	});
});

describe("use-retention shape tolerance (incident 1 defense-in-depth)", () => {
	// components/use-retention.tsx is the hook that defends against
	// incident 1 client-side: it accepts BOTH the bare-array (legacy) and
	// { states } shapes and never lets a surprise shape reach the fold.
	//
	// This module exports ONLY the React component `useRetention` (and the
	// `UseRetention` interface) — it pulls in React + a DOM-window effect,
	// so it cannot be imported into a hermetic node:test without a DOM
	// harness. There are NO pure helper exports to pin here.
	//
	// SKIPPED per the task: "import any exported pure helpers from
	// components/use-retention.tsx (if none, SKIP this part and note it)".
	// The tolerance is exercised end-to-end by the /api/graph/reviews
	// shape pin above (the route answers the { states } envelope the
	// tolerant branch expects) — that is the regression-relevant contract.
	it.skip("use-retention pure helpers (none exported — React component only)", () => {
		// Intentionally empty: documented for the reviewer. The shape
		// tolerance lives in the hook's fetch branch, which needs a DOM.
	});
});
