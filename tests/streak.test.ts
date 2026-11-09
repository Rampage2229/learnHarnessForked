/**
 * Tests for the study-streak + daily-reminder glue (habit glue, personal
 * fork): core/streak.ts — the studyStreak fold (empty, today only,
 * consecutive, gap breaks it, yesterday-alive, longest run, multiple
 * entries per day), shouldRemind decision (before/at/after time, already
 * fired today, zero due, disabled, malformed dailyAt), and
 * dueReminderText. Pure — no fs, no network.
 *
 * The settings round-trip pins (sanitize/parse/resolution for
 * agent.reminders) live in the three settings test files this feature
 * appends to.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	dueReminderText,
	hhMmToMinutes,
	isHhMm,
	localDayKey,
	shouldRemind,
	studyStreak,
	type ReviewEntry,
} from "../src/core/streak.ts";

/** Build a ReviewEntry at a given local moment — `at` is ISO. */
function entry(at: string): ReviewEntry {
	return { nodeId: "n", chatId: "c", at, outcome: "correct", source: "self" };
}

/** Today, June 10 2026 10:00 local — a fixed reference for the folds. */
const TODAY = new Date(2026, 5, 10, 10, 0);

/** The local date fragments for our fixed TODAY. */
const JUN10 = localDayKey(TODAY);
const JUN9 = "2026-06-09";
const JUN8 = "2026-06-08";
const JUN7 = "2026-06-07";

describe("studyStreak", () => {
	it("empty entries → 0/0, not active today", () => {
		assert.deepEqual(studyStreak([], TODAY), { current: 0, longest: 0, activeToday: false });
	});

	it("one entry today → current 1, longest 1, active today", () => {
		const at = new Date(2026, 5, 10, 7, 30).toISOString();
		assert.deepEqual(studyStreak([entry(at)], TODAY), { current: 1, longest: 1, activeToday: true });
	});

	it("one entry today + consecutive days before → current counts them all", () => {
		// reviewed Jun 7, 8, 9, 10 → 4-day current streak, longest 4
		const entries = [
			entry(new Date(2026, 5, 7, 9).toISOString()),
			entry(new Date(2026, 5, 8, 9).toISOString()),
			entry(new Date(2026, 5, 9, 9).toISOString()),
			entry(new Date(2026, 5, 10, 9).toISOString()),
		];
		assert.deepEqual(studyStreak(entries, TODAY), { current: 4, longest: 4, activeToday: true });
	});

	it("a gap breaks the current streak but longest remembers the prior run", () => {
		// Jun 7, 8 (run of 2), GAP Jun 9, then Jun 10 → current 1, longest 2
		const entries = [
			entry(new Date(2026, 5, 7, 9).toISOString()),
			entry(new Date(2026, 5, 8, 9).toISOString()),
			entry(new Date(2026, 5, 10, 9).toISOString()),
		];
		assert.deepEqual(studyStreak(entries, TODAY), { current: 1, longest: 2, activeToday: true });
	});

	it("yesterday-alive case: studied yesterday, not today → current 1 (alive until today passes)", () => {
		const at = new Date(2026, 5, 9, 9).toISOString();
		const s = studyStreak([entry(at)], TODAY);
		assert.equal(s.current, 1, "yesterday alone keeps a 1-day alive streak");
		assert.equal(s.activeToday, false);
		assert.equal(s.longest, 1);
		assert.equal(JUN9 in { [JUN9]: true }, true);
	});

	it("yesterday-alive with a prior run: Jun 8 + Jun 9, today not studied → current 2", () => {
		const entries = [
			entry(new Date(2026, 5, 8, 9).toISOString()),
			entry(new Date(2026, 5, 9, 9).toISOString()),
		];
		const s = studyStreak(entries, TODAY);
		assert.equal(s.current, 2, "the alive streak counts back through yesterday");
		assert.equal(s.activeToday, false);
		assert.equal(s.longest, 2);
	});

	it("a two-day gap with no yesterday: studied Jun 7 only → current 0 (not alive)", () => {
		const at = new Date(2026, 5, 7, 9).toISOString();
		const s = studyStreak([entry(at)], TODAY);
		assert.equal(s.current, 0, "neither today nor yesterday studied → 0");
		assert.equal(s.longest, 1);
		assert.equal(s.activeToday, false);
	});

	it("longest run across history beats the current streak", () => {
		// a 5-day run (Jun 1-5), gap, then a 2-day alive run (Jun 9-10)
		const entries = [
			entry(new Date(2026, 5, 1, 9).toISOString()),
			entry(new Date(2026, 5, 2, 9).toISOString()),
			entry(new Date(2026, 5, 3, 9).toISOString()),
			entry(new Date(2026, 5, 4, 9).toISOString()),
			entry(new Date(2026, 5, 5, 9).toISOString()),
			entry(new Date(2026, 5, 9, 9).toISOString()),
			entry(new Date(2026, 5, 10, 9).toISOString()),
		];
		const s = studyStreak(entries, TODAY);
		assert.equal(s.current, 2, "the alive run is 2 (Jun 9-10)");
		assert.equal(s.longest, 5, "the earlier 5-day run is the longest ever");
		assert.equal(s.activeToday, true);
	});

	it("multiple entries the same day collapse to one streak day", () => {
		// three reviews on Jun 10 (different times) → still 1-day streak
		const day = new Date(2026, 5, 10);
		const entries = [
			entry(new Date(2026, 5, 10, 8, 0).toISOString()),
			entry(new Date(2026, 5, 10, 12, 30).toISOString()),
			entry(new Date(2026, 5, 10, 23, 59).toISOString()),
		];
		const s = studyStreak(entries, day);
		assert.equal(s.current, 1, "three reviews same day = one streak day");
		assert.equal(s.longest, 1);
		assert.equal(s.activeToday, true);
	});

	it("multiple entries per day across a consecutive run count the days, not the reviews", () => {
		// Jun 9 (2 reviews) + Jun 10 (3 reviews) → 2-day streak, not 5
		const entries = [
			entry(new Date(2026, 5, 9, 9).toISOString()),
			entry(new Date(2026, 5, 9, 21).toISOString()),
			entry(new Date(2026, 5, 10, 8).toISOString()),
			entry(new Date(2026, 5, 10, 14).toISOString()),
			entry(new Date(2026, 5, 10, 20).toISOString()),
		];
		const s = studyStreak(entries, TODAY);
		assert.equal(s.current, 2);
		assert.equal(s.longest, 2);
	});

	it("entries with unparseable `at` are skipped, never throw", () => {
		const bad = entry("not-a-date");
		assert.deepEqual(studyStreak([bad], TODAY), { current: 0, longest: 0, activeToday: false });
		// mixed: one good, one bad → the good one counts
		const mixed = [bad, entry(new Date(2026, 5, 10, 9).toISOString())];
		const s = studyStreak(mixed, TODAY);
		assert.equal(s.current, 1);
		assert.equal(s.activeToday, true);
	});

	it("out-of-order entries still resolve (sorted internally)", () => {
		// entries given newest-first — the fold sorts them ascending
		const entries = [
			entry(new Date(2026, 5, 10, 9).toISOString()),
			entry(new Date(2026, 5, 8, 9).toISOString()),
			entry(new Date(2026, 5, 9, 9).toISOString()),
		];
		const s = studyStreak(entries, TODAY);
		assert.equal(s.current, 3, "Jun 8, 9, 10 in any order → 3-day streak");
		assert.equal(s.longest, 3);
	});
});

describe("dueReminderText", () => {
	it("pluralizes propositions and carries the minutes estimate", () => {
		assert.equal(dueReminderText(5, 12), "5 propositions due — ~12 min");
	});

	it("singular 'proposition' for 1", () => {
		assert.equal(dueReminderText(1, 5), "1 proposition due — ~5 min");
	});

	it("zero due reads honestly (the component never fires at 0, but the text is well-formed)", () => {
		assert.equal(dueReminderText(0, 5), "0 propositions due — ~5 min");
	});
});

describe("localDayKey", () => {
	it("zero-pads month and day in the host's LOCAL timezone", () => {
		assert.equal(localDayKey(new Date(2026, 0, 5, 1, 2)), "2026-01-05");
		assert.equal(localDayKey(new Date(2026, 11, 31, 23, 59)), "2026-12-31");
	});
});

describe("isHhMm + hhMmToMinutes", () => {
	it("accepts 24h HH:MM and rejects everything else", () => {
		for (const good of ["00:00", "09:30", "23:59", "00:59", "23:00"]) assert.equal(isHhMm(good), true, good);
		for (const bad of ["24:00", "23:60", "9:30", "9:3", "-1:00", "ab:cd", "1234", "", null, undefined, 1]) {
			assert.equal(isHhMm(bad), false, JSON.stringify(bad));
		}
	});

	it("converts to minutes since midnight; NaN for non-HH:MM", () => {
		assert.equal(hhMmToMinutes("00:00"), 0);
		assert.equal(hhMmToMinutes("09:30"), 9 * 60 + 30);
		assert.equal(hhMmToMinutes("23:59"), 23 * 60 + 59);
		assert.ok(Number.isNaN(hhMmToMinutes("nope")));
		assert.ok(Number.isNaN(hhMmToMinutes("24:00")));
	});
});

describe("shouldRemind (the daily-reminder decision gate)", () => {
	it("before the pin time: false", () => {
		// pin 10:00, now 09:59, never fired, due 3
		const now = new Date(2026, 5, 10, 9, 59);
		assert.equal(shouldRemind(now, "10:00", "", 3), false);
	});

	it("at the pin time: true (never fired, due > 0)", () => {
		const now = new Date(2026, 5, 10, 10, 0);
		assert.equal(shouldRemind(now, "10:00", "", 3), true);
	});

	it("after the pin time: true (never fired, due > 0)", () => {
		const now = new Date(2026, 5, 10, 22, 30);
		assert.equal(shouldRemind(now, "10:00", "", 3), true);
	});

	it("already fired today (lastFiredDate === today's local key): false", () => {
		const now = new Date(2026, 5, 10, 11, 0);
		const last = localDayKey(now); // "2026-06-10"
		assert.equal(shouldRemind(now, "10:00", last, 3), false, "same calendar day → no refire");
	});

	it("fired a previous day (lastFiredDate ≠ today): true", () => {
		const now = new Date(2026, 5, 10, 11, 0);
		assert.equal(shouldRemind(now, "10:00", "2026-06-09", 3), true, "yesterday's fire does not block today");
	});

	it("zero due: false (no nudge when nothing to review)", () => {
		const now = new Date(2026, 5, 10, 11, 0);
		assert.equal(shouldRemind(now, "10:00", "", 0), false);
	});

	it("disabled (dailyAt undefined): false", () => {
		const now = new Date(2026, 5, 10, 11, 0);
		assert.equal(shouldRemind(now, undefined, "", 3), false);
	});

	it("malformed dailyAt: false (never throws, treated as disabled)", () => {
		const now = new Date(2026, 5, 10, 11, 0);
		for (const bad of ["24:00", "9:3", "nope", "", "1"]) {
			assert.equal(shouldRemind(now, bad, "", 3), false, JSON.stringify(bad));
		}
	});

	it("negative due: false (defensive — dueCount is a length)", () => {
		const now = new Date(2026, 5, 10, 11, 0);
		assert.equal(shouldRemind(now, "10:00", "", -1), false);
	});

	it("boundary: now exactly at pin, last fired empty string (never fired): true", () => {
		const now = new Date(2026, 5, 10, 10, 0);
		assert.equal(shouldRemind(now, "10:00", "", 1), true);
		// "" is NOT today's key (unless today is the empty string, impossible)
		assert.notEqual("", localDayKey(now));
	});
});
