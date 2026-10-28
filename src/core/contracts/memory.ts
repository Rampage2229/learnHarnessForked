/**
 * User-memory contracts (memory v1, personal fork): the learner-curated
 * standing context every teaching agent receives as prompt context.
 * Pure types — the file shape, caps, and id scheme are owned (and
 * enforced) by the store adapter (src/store/memory.ts).
 */

/** One standing-context note. `id` is `mem_` + 12 hex; `text` is trimmed
 *  and ≤2000 chars (the store rejects anything else); timestamps are ISO.
 *  Entries order newest-LAST by createdAt on disk; the API/UI view is
 *  newest-first. */
export interface MemoryEntry {
	id: string;
	text: string;
	createdAt: string;
	updatedAt: string;
}
