/**
 * Review ledger store — the append-only file adapter over src/core/reviews.ts
 * (the pure folds live there; this module owns fs + the data seam).
 *
 * LEARNER STATE, not knowledge: outside the graph ledger family (no format
 * stamp), writes are single-line appends (fs.appendFileSync — one JSONL
 * line, torn-write-tolerant: a partial final line is skipped on read).
 */
import fs from "node:fs";
import { PATHS } from "../../config.ts";
import {
	foldReviewStates,
	parseReviewLine,
	type NodeReviewState,
	type ReviewEntry,
} from "../core/reviews.ts";

export function appendReview(entry: ReviewEntry): void {
	// Shape-guard before touching the file (never throw on read; throw here
	// on a malformed write so the caller's try/catch can contain it).
	if (!entry.nodeId || !entry.chatId || !entry.at) throw new Error("review entry is missing nodeId/chatId/at");
	fs.appendFileSync(PATHS.reviews, `${JSON.stringify(entry)}\n`, "utf8");
}

export function reviewStates(): Map<string, NodeReviewState> {
	const entries: ReviewEntry[] = [];
	try {
		const text = fs.readFileSync(PATHS.reviews, "utf8");
		for (const line of text.split("\n")) {
			const e = parseReviewLine(line);
			if (e) entries.push(e);
		}
	} catch {
		return new Map(); // missing file = no reviews
	}
	return foldReviewStates(entries);
}

export { dueNodeIds, reviewNodeColor } from "../core/reviews.ts";
export type { ReviewEntry, ReviewOutcome, ReviewSource, NodeReviewState } from "../core/reviews.ts";