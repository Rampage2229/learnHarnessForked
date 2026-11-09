"use client";

/**
 * THE DAILY REMINDER (habit glue, personal fork): a once-per-day desktop
 * nudge that fires a browser Notification ("N propositions due — ~M min")
 * when propositions are due, at the user's chosen local time. Mounted
 * from the minimal home (a one-line import + JSX node), it composes with
 * the streak badge to keep the learner's daily review a habit.
 *
 * Pure decision (shouldRemind) + a behavior component (DailyReminder):
 *
 *   shouldRemind(now, dailyAt, lastFiredDate, dueCount) → boolean:
 *     the testable gate. true iff ALL hold — reminders enabled (dailyAt
 *     is a valid 24h "HH:MM"), the local time is at/after the pin, this
 *     calendar day has NOT already fired (lastFiredDate ≠ today's local
 *     key), and dueCount > 0. NEVER throws — a malformed dailyAt is
 *     "disabled", NaN comparisons are "before time".
 *
 *   DailyReminder: on mount + every 5 minutes it re-checks the gate and,
 *     when it passes, fires a Notification and records the local day in
 *     localStorage so it does not refire the same day. It requests
 *     notification permission only after a user interaction (the browser
 *     permission law) — the component never auto-prompts; it relies on a
 *     prior interaction or stays silent until one. Guarded behind
 *     `typeof Notification !== "undefined"` (SSR + non-browser) and NEVER
 *     throws — every API call is try/caught. The due count + minutes
 *     come from the EXISTING GET /api/graph/reviews route (the Today
 *     band's own read) so the reminder's numbers match the band.
 *
 * The localStorage guard key ("lh:reminder:last-fired") holds a LOCAL
 * calendar-day string ("YYYY-MM-DD") — never a UTC day — so a reminder
 * fired at 23:59 does not refire at 00:01 the next day for the same
 * "today" (the same law as core/streak.ts's studyStreak day key).
 */

import { useEffect, useState } from "react";
import {
	dueReminderText,
	isHhMm,
	localDayKey,
	resolveSettings,
	shouldRemind,
} from "@/src/core";
import type { NodeReviewState, UserSettings } from "@/src/core";

/** The minutes estimate's floor — mirrors core/today.ts MIN_REVIEW_MINUTES
 *  so the reminder's "~M min" never promises "0 min" for a handful of
 *  due cards. Imported lazily-free: the constant is local to avoid a
 *  cross-module value coupling for one number (the Today fold owns the
 *  canonical number; this only needs the floor for the reminder text). */
const REMINDER_MIN_MINUTES = 5;

/** The localStorage key for the once-per-calendar-day guard. */
export const REMINDER_LAST_FIRED_KEY = "lh:reminder:last-fired";

/** Read the due count + minutes estimate from the EXISTING reviews
 *  route. Returns null on any failure (the reminder just stays silent).
 *  Mirrors the Today band's read + the MIN_REVIEW_MINUTES floor. */
async function readDue(): Promise<{ dueCount: number; minutes: number } | null> {
	try {
		const res = await fetch("/api/graph/reviews");
		if (!res.ok) return null;
		const body = (await res.json()) as { states?: NodeReviewState[]; due?: string[] };
		const dueCount = Array.isArray(body.due) ? body.due.length : 0;
		const minutes = Math.max(REMINDER_MIN_MINUTES, dueCount);
		return { dueCount, minutes };
	} catch {
		return null;
	}
}

/** Read the last-fired local-day guard from localStorage. "" (never
 *  fired) when absent or unreadable — NEVER throws. */
function readLastFired(): string {
	try {
		return localStorage.getItem(REMINDER_LAST_FIRED_KEY) ?? "";
	} catch {
		return "";
	}
}

/** Write the last-fired local-day guard. NEVER throws. */
function writeLastFired(key: string): void {
	try {
		localStorage.setItem(REMINDER_LAST_FIRED_KEY, key);
	} catch {
		/* ignore — a full private-mode store just means no guard */
	}
}

/** Fire a Notification once permission is granted; record the local
 *  day so it does not refire. NEVER throws. Returns true iff fired. */
function fireReminder(dueCount: number, minutes: number): boolean {
	if (typeof Notification === "undefined") return false;
	try {
		if (Notification.permission !== "granted") return false;
		const n = new Notification("LearningHarness", { body: dueReminderText(dueCount, minutes) });
		// Auto-close after a few seconds — never leave a stale toast.
		if (typeof n.close === "function") setTimeout(() => n.close(), 8000);
		return true;
	} catch {
		return false;
	}
}

/** The behavior component. Reads the resolved reminders setting
 *  (`agent.reminders` as the settings-resolution layer produces it —
 *  `enabled` is always concrete; `dailyAt` may be undefined = disabled),
 *  and on mount + every 5 minutes re-checks the gate. Mounted from the
 *  minimal home; renders nothing. NEVER throws. */
export function DailyReminder() {
	const [reminders, setReminders] = useState<{ dailyAt?: string; enabled: boolean }>({ enabled: false });

	// Read the settings record once on mount and on every settings save
	// (the lh:settings-saved signal the agent section already honors), then
	// resolve the concrete reminders view. NEVER throws — a failed read
	// keeps reminders disabled (the resting state, no nag by default).
	useEffect(() => {
		const read = () => {
			fetch("/api/settings")
				.then((res) => (res.ok ? res.json() : Promise.reject(new Error(`status ${res.status}`))))
				.then((body: { settings: UserSettings | null }) => {
					setReminders(resolveSettings(body.settings ?? null).agent.reminders);
				})
				.catch(() => setReminders({ enabled: false }));
		};
		read();
		window.addEventListener("lh:settings-saved", read);
		return () => window.removeEventListener("lh:settings-saved", read);
	}, []);

	useEffect(() => {
		// Disabled or no time pin: nothing to do (the resting state).
		if (!reminders.enabled || !isHhMm(reminders.dailyAt)) return;
		if (typeof Notification === "undefined") return;

		const check = async () => {
			try {
				const now = new Date();
				const last = readLastFired();
				const due = await readDue();
				if (!due) return;
				if (shouldRemind(now, reminders.dailyAt, last, due.dueCount)) {
					const fired = fireReminder(due.dueCount, due.minutes);
					if (fired) writeLastFired(localDayKey(now));
				}
			} catch {
				/* never throw from a reminder */
			}
		};

		void check();
		// Re-check every 5 minutes — coarse enough to avoid a tight poll,
		// fine enough to catch the pin within the same study session.
		const id = setInterval(() => void check(), 5 * 60 * 1000);
		return () => clearInterval(id);
		// The reminders setting is the only reactive input; the home
		// remounts on settings save (the lh:settings-saved cadence the
		// agent section already honors). A pinned test setting does not
		// need to re-run mid-mount.
	}, [reminders.enabled, reminders.dailyAt]);

	return null;
}
