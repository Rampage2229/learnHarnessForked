/**
 * THE STUDY STREAK + DAILY-REMINDER GLUE (personal fork): pure folds over
 * the review ledger that turn "did I study today?" into a flame badge and
 * a once-per-day desktop nudge. LEARNER STATE, not knowledge: the same
 * append-only review ledger (core/reviews.ts) feeds both, through the
 * SAME /api/graph/reviews read the home already makes.
 *
 * Browser-safe pure logic + types only (no node imports, no fs, no
 * network) — the components fetch and feed parameters in, exactly like
 * core/today.ts. Two exports are the contract:
 *
 *   - studyStreak(entries, today) → { current, longest, activeToday }:
 *     a STREAK DAY is any calendar day (LOCAL date) with at least one
 *     review entry. `current` counts consecutive streak days ENDING
 *     today OR yesterday (yesterday still counts as alive until today
 *     passes — a learner who studied yesterday but not yet today still
 *     has a 1-day streak, not a 0); `longest` is the max run ever;
 *     `activeToday` is whether today is itself a streak day.
 *
 *   - dueReminderText(dueCount, minutes) → the notification body string.
 *
 * The shared pure helpers (localDayKey, isHhMm, hhMmToMinutes) are also
 * exported: the daily-reminder component's localStorage guard keys on a
 * LOCAL calendar day (so a reminder fired at 23:59 does not refire at
 * 00:01 the next day for the same "today"), and its time comparison keys
 * on a 24h "HH:MM" string. Keeping them here makes both the streak math
 * and the reminder decision testable from one pure import.
 */

import { type ReviewEntry } from "./reviews.ts";

/** Re-export the ReviewEntry type so the streak contract's consumers
 *  (and tests) import it from one place (streak.ts owns the streak API;
 *  the entries' shape is the review ledger's, re-exported for
 *  convenience — type-only, browser-safe). */
export type { ReviewEntry };

/** Zero-pad a 2-digit number (local day key fragments). */
function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/** The LOCAL calendar-day key for a Date — "YYYY-MM-DD" in the host's
 *  timezone. A streak day and a reminder's "already fired today" guard
 *  both key on this (NOT a UTC day): a learner's day is their local
 *  waking day, so 23:59 and 00:01 must not collapse the same study day. */
export function localDayKey(date: Date): string {
	return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** A 24h "HH:MM" string, strict — the settings `agent.reminders.dailyAt`
 *  shape. Hours 00–23, minutes 00–59. Used by the lenient read side
 *  (sanitize), the strict write side (parse, 400 on mismatch), and the
 *  reminder decision (a malformed value is treated as "disabled"). */
export function isHhMm(value: unknown): value is string {
	return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** Minutes-since-local-midnight for a 24h "HH:MM" string. Returns NaN
 *  for anything that is not a valid HH:MM (the same validity as isHhMm) —
 *  the reminder decision treats NaN as "before time / disabled", never
 *  firing. Caller may pass a value already checked by isHhMm; this is
 *  belt-and-suspenders so the two helpers can never disagree. */
export function hhMmToMinutes(value: string): number {
	if (!isHhMm(value)) return Number.NaN;
	const m = /^(\d{2}):(\d{2})$/.exec(value);
	if (!m) return Number.NaN;
	return Number(m[1]) * 60 + Number(m[2]);
}

/** Midnight (00:00 LOCAL) for a Date — streak walks key on local
 *  midnights so the math is DST-safe (constructing day−1/day+1 via the
 *  Date constructor never crosses a 23h/25h boundary). */
function localMidnight(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Is `b` the calendar day AFTER `a` (both local midnights)? DST-safe:
 *  builds a's next-midnight via the constructor and compares exact ms. */
function isNextDay(a: Date, b: Date): boolean {
	return new Date(a.getFullYear(), a.getMonth(), a.getDate() + 1).getTime() === b.getTime();
}

/** The streak fold. `today` is the reference "now" (callers — and tests —
 *  pin the clock); a streak day is any LOCAL calendar day with ≥1 review
 *  entry. Multiple entries the same day collapse to one (the union of
 *  study days, not a count of reviews). Entries whose `at` is unparseable
 *  are skipped (never throw — the ledger is append-only and a torn line
 *  is already skipped on read; this is belt-and-suspenders). */
export function studyStreak(
	entries: readonly ReviewEntry[],
	today: Date,
): { current: number; longest: number; activeToday: boolean } {
	// Unique local-midnight Dates for every review day, sorted ascending.
	const midnights = new Map<string, Date>();
	for (const e of entries) {
		const ms = Date.parse(e.at);
		if (Number.isNaN(ms)) continue;
		const key = localDayKey(new Date(ms));
		if (!midnights.has(key)) midnights.set(key, localMidnight(new Date(ms)));
	}
	const sorted = [...midnights.values()].sort((a, b) => a.getTime() - b.getTime());
	const has = (key: string): boolean => midnights.has(key);

	const todayKey = localDayKey(today);
	const activeToday = has(todayKey);

	// current: consecutive days ENDING today OR yesterday. If today is a
	// study day, walk back from today; else if yesterday is, walk back from
	// yesterday (the streak is alive until today passes); else 0.
	let current = 0;
	if (activeToday) {
		current = runBackward(midnights, localMidnight(today));
	} else {
		const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
		if (has(localDayKey(yesterday))) current = runBackward(midnights, localMidnight(yesterday));
	}

	// longest: max run of consecutive calendar days across the whole
	// history (a later, longer run beats an earlier one — ties keep the
	// first max, which is just Math.max accumulation).
	let longest = 0;
	let run = 0;
	for (let i = 0; i < sorted.length; i++) {
		if (i > 0 && isNextDay(sorted[i - 1]!, sorted[i]!)) run++;
		else run = 1;
		if (run > longest) longest = run;
	}

	return { current, longest, activeToday };
}

/** Count consecutive streak days ending at `start` (inclusive), walking
 *  backward one local day at a time. Stops at the first gap. */
function runBackward(midnights: Map<string, Date>, start: Date): number {
	let n = 0;
	let d = new Date(start);
	while (midnights.has(localDayKey(d))) {
		n++;
		d = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
	}
	return n;
}

/** The daily-reminder notification body. The notification fires only when
 *  propositions are DUE (`dueCount > 0`), so the noun is always plural in
 *  practice — but the 1-case reads "proposition" for honesty. `minutes`
 *  is the Today fold's estimate (core/today.ts MIN_REVIEW_MINUTES floor). */
export function dueReminderText(dueCount: number, minutes: number): string {
	const noun = dueCount === 1 ? "proposition" : "propositions";
	return `${dueCount} ${noun} due — ~${minutes} min`;
}

/** THE DAILY-REMINDER DECISION GATE (habit glue, personal fork): the pure
 *  testable predicate behind the once-per-day desktop nudge. true iff
 *  ALL hold:
 *
 *    1. reminders are ENABLED — `dailyAt` is a valid 24h "HH:MM" string
 *       (a malformed/undefined pin is "disabled", never fires);
 *    2. `dueCount > 0` — no nudge when nothing is due;
 *    3. this LOCAL calendar day has NOT already fired — `lastFiredDate`
 *       (a local-day key, "YYYY-MM-DD") is not today's key (the
 *       once-per-day guard);
 *    4. the local time is at/after the pin — now's minutes-since-midnight
 *       is ≥ the pin's.
 *
 *  NEVER throws: a malformed dailyAt or NaN compares as "before time /
 *  disabled" → false. The behavior component (components/daily-reminder.tsx)
 *  calls this with the resolved setting + a localStorage guard, then fires
 *  a Notification and records the local day so it does not refire.
 *  Pure — exported for tests.
 */
export function shouldRemind(
	now: Date,
	dailyAt: string | undefined,
	lastFiredDate: string | undefined,
	dueCount: number,
): boolean {
	if (!isHhMm(dailyAt)) return false; // disabled / malformed → never fire
	if (dueCount <= 0) return false; // nothing due → no nudge
	if (lastFiredDate === localDayKey(now)) return false; // already fired today
	const target = hhMmToMinutes(dailyAt);
	if (!Number.isFinite(target)) return false; // belt-and-suspenders
	const nowMin = now.getHours() * 60 + now.getMinutes();
	return nowMin >= target;
}
