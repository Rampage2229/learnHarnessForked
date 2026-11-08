/** GoalBand render tests — the aim line above the Today band (feature ②,
 * personal fork). Pure body: props in, markup out, like KnowledgeSummary
 * and TodayBand — the fetches and drafts live in MinimalHome, so SSR pins
 * every visible state with props alone (no /api/goals needed; the backend
 * is a parallel workstream). Same renderToStaticMarkup pattern as
 * render-minimal-home.test.tsx.
 */
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { describe, it } from "node:test";
import { GoalBand } from "../components/minimal-home.tsx";
import type { Goal } from "../components/minimal-home.tsx";

function makeGoal(overrides: Partial<Goal> = {}): Goal {
	return {
		id: "g1",
		title: "Master the chain rule",
		detail: "Twenty derivatives a day",
		createdAt: "2026-01-01T00:00:00.000Z",
		status: "active",
		...overrides,
	};
}

function render(props: Partial<Parameters<typeof GoalBand>[0]> = {}) {
	return renderToStaticMarkup(
		React.createElement(GoalBand, {
			goal: null,
			editing: false,
			draftTitle: "",
			draftDetail: "",
			...props,
		}),
	);
}

/** The opening tag of the element carrying `marker` — for pinning WHICH
 * element a text landed in (the smaller-second-line law). */
function tagOf(html: string, marker: string): string {
	const at = html.indexOf(marker);
	assert.ok(at !== -1, `${marker} renders`);
	const open = html.lastIndexOf("<", at);
	return html.slice(open, at);
}

describe("GoalBand — the active goal line", () => {
	const html = render({ goal: makeGoal() });

	it('reads "Working toward: <title>"', () => {
		assert.ok(html.includes('data-testid="goal-line"'));
		assert.ok(html.includes("Working toward:"));
		assert.ok(html.includes("Master the chain rule"));
	});

	it("the detail is the smaller second line, under the title", () => {
		assert.ok(tagOf(html, "Twenty derivatives a day").includes("text-xs"), "detail line is the small size");
		assert.ok(tagOf(html, "Working toward:").includes("text-sm"), "title line is the readout size");
		assert.ok(html.indexOf("Twenty derivatives") > html.indexOf("Working toward:"), "detail renders after the title");
	});

	it("the active goal carries Mark done and Clear", () => {
		assert.ok(html.includes('data-testid="goal-done"') && html.includes("Mark done"));
		assert.ok(html.includes('data-testid="goal-clear"') && html.includes("Clear"));
	});

	it("no detail — no second line at all", () => {
		const bare = render({ goal: makeGoal({ detail: undefined }) });
		assert.ok(!bare.includes("Twenty derivatives"));
		assert.ok(!bare.includes("text-muted-foreground/70"), "the quieter detail style only exists with a detail");
	});
});

describe("GoalBand — no active goal", () => {
	const html = render({ goal: null });

	it('the quiet affordance is the "Set a goal" pill — no line, no editor, no actions', () => {
		assert.ok(html.includes('data-testid="goal-line"'), "the band still anchors the goal slot");
		assert.ok(html.includes("Set a goal"));
		assert.ok(!html.includes("Working toward:"), "no aim line without an aim");
		assert.ok(!html.includes('data-testid="goal-edit"'), "the editor stays closed");
		assert.ok(!html.includes('data-testid="goal-done"') && !html.includes('data-testid="goal-clear"'), "nothing to mark or clear");
	});

	it("non-active statuses don't surface — only status active is the goal", () => {
		// The wrapper derives the active goal from status ("active"); a
		// done/archived row reaching the band as `goal` would be a caller
		// bug — the line itself just renders what it's handed, so this pin
		// lives with the wrapper contract, not here. Pinned instead: the
		// band renders the affordance when handed null.
		const html = render();
		assert.ok(html.includes("Set a goal"));
	});
});

describe("GoalBand — the inline editor", () => {
	const html = render({
		goal: makeGoal(),
		editing: true,
		draftTitle: "Master the chain rule",
		draftDetail: "Twenty derivatives a day",
	});

	it("the form replaces the line — title input, optional detail textarea, Save/Cancel", () => {
		assert.ok(html.includes('data-testid="goal-edit"'));
		assert.ok(html.includes('data-testid="goal-title-input"') && html.includes("Master the chain rule"));
		assert.ok(html.includes('data-testid="goal-detail-input"') && html.includes("Twenty derivatives a day"));
		assert.ok(html.includes('data-testid="goal-save"') && html.includes("Save"));
		assert.ok(html.includes("Cancel"));
		assert.ok(!html.includes('data-testid="goal-line"'), "the line yields to the editor");
		assert.ok(!html.includes('data-testid="goal-done"'), "Mark done waits outside the editor");
	});

	it("Save is dead without a title — create and edit alike require one", () => {
		// NOTE: the disabled: tailwind variants in the class list contain the
		// substring "disabled:" — pin the ATTRIBUTE (React SSR: disabled="").
		const blank = render({ editing: true, draftTitle: "   ", draftDetail: "detail only" });
		assert.ok(blank.includes('disabled=""'), "whitespace title: Save disabled");
		assert.ok(!html.includes('disabled=""'), "a real title enables Save");
	});
});
