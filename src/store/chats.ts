/**
 * ChatStore — the fs JSON adapter (one file per chat in data/chats/).
 *
 * Implements core/ports.ts ChatStore; the record shapes live in
 * core/contracts.ts (ChatRecord/ChatSummary). Idioms: sync fs, tiny
 * records, id-guarded filenames, JSON with tab indentation. Wired in the
 * composition root (src/server/stores.ts); nothing else constructs it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import type { ChatStore } from "../core/ports.ts";
import type { ChatRecord, ChatSettings, ChatSummary, ExtractionRunUsage, PlanTree, TurnUsage } from "../core/contracts.ts";
import { CURRENT_CHAT_VERSION } from "../core/contracts.ts";
import type { LhMessage } from "../core/native-messages.ts";
import { activeProblemOf, danglingQuestionOf } from "../core/native-messages.ts";
import { phaseAt3Lh } from "../core/phases.ts";

function chatFile(id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid chat id: ${id}`);
	return path.join(PATHS.chats, `${id}.json`);
}

// ─── Per-process record cache (performance, chat-switch round) ──────────────
// getChat re-reads + JSON.parses the chat file on EVERY call, and one chat
// open fans out to several reads (route, sessionCoverage, listChats, graph
// folds) — the same file parsed repeatedly per switch. This cache is keyed
// by (mtimeMs, size): an external write (another process, a hand edit)
// changes the stamp, the entry is dropped, and the file is re-parsed.
//
// Records are returned BY REFERENCE and must be treated as IMMUTABLE —
// callers that change a record must clone the parts they change (the store's
// own writers below do exactly that: they build a fresh record and hand it
// to writeChat). Do not JSON-round-trip on read: that would defeat the cache.
const CHAT_CACHE_MAX = 200;
const chatCache = new Map<string, { mtimeMs: number; size: number; record: ChatRecord }>();

/** The (mtimeMs, size) identity stamp of one chat file — the cache's key.
 *  Exported so the server-side read caches (coverage) can key on the same
 *  stamp without re-implementing the path/validation. */
export function chatStamp(id: string): { mtimeMs: number; size: number } | null {
	try {
		const st = fs.statSync(chatFile(id));
		return { mtimeMs: st.mtimeMs, size: st.size };
	} catch {
		return null;
	}
}

function cachePut(id: string, record: ChatRecord): void {
	const stamp = chatStamp(id);
	if (!stamp) {
		chatCache.delete(id);
		return;
	}
	chatCache.delete(id); // re-insert to refresh recency (evict oldest first)
	chatCache.set(id, { ...stamp, record });
	while (chatCache.size > CHAT_CACHE_MAX) {
		const oldest = chatCache.keys().next().value;
		if (oldest === undefined) break;
		chatCache.delete(oldest);
	}
}

/** THE SILENCE LAW (push S6, 2026-10-02): chats-changed announces ONLY
 *  list-SHAPE mutations — createChat, renameChat, deleteChat (below,
 *  each emits post-write). The content writers (saveMessages,
 *  appendTurnUsage, appendExtractionUsage, saveSettings, saveTree) are
 *  DELIBERATELY SILENT: saveMessages fires per turn-persist and would
 *  spam the bus, and every list-visible change it causes (title, order,
 *  phase, busy, pendingQuestion) is already announced by turn-started /
 *  turn-settled, which the sidebar refetches on. Silence here is law,
 *  not oversight. */
function createChat(title: string, kind?: "practice", topicId?: string): ChatRecord {
	const now = new Date().toISOString();
	const record: ChatRecord = {
		id: `chat_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		title: title.trim() || "Untitled session",
		createdAt: now,
		updatedAt: now,
		messages: [],
		// Practice sessions carry the marker; teach stays ABSENT (absence
		// reads as teach — pre-practice records never migrate).
		...(kind === "practice" ? { kind: "practice" as const } : {}),
		// The session's topic stamp (topics v1, personal fork): present only
		// when the creation named one — absence reads as unassigned.
		...(topicId ? { topicId } : {}),
	};
	fs.mkdirSync(PATHS.chats, { recursive: true });
	writeChat(record);
	emit("chats-changed", {});
	return { ...record, version: CURRENT_CHAT_VERSION }; // the in-memory twin of what landed on disk
}

/** THE WRITE CHOKE POINT (schema-versioning wave, owner 2026-10-10): every
 *  record persist goes through here and carries the CURRENT version stamp —
 *  lazy migration means existing files only get stamped on their next write.
 *  A future-version guard lives on the read side (getChat).
 *  The cache is refreshed AFTER the write (stamp of the landed file), so
 *  the next getChat hits it without re-parsing. */
function writeChat(record: ChatRecord): void {
	const stamped = { ...record, version: CURRENT_CHAT_VERSION };
	const contents = JSON.stringify(stamped, null, "\t");
	fs.writeFileSync(chatFile(record.id), contents, "utf-8");
	// Cache the PARSE of the written bytes — not the in-memory object.
	// JSON.stringify drops undefined-valued keys, so caching `stamped`
	// would make in-memory reads diverge from JSON.parse(file) (observed:
	// deepStrictEqual diffs with cacheReadTokens: undefined). One parse
	// of the string we just built is free next to the file write.
	cachePut(record.id, JSON.parse(contents));
}

function getChat(id: string): ChatRecord | null {
	const stamp = chatStamp(id);
	if (!stamp) {
		chatCache.delete(id);
		return null;
	}
	const hit = chatCache.get(id);
	if (hit && hit.mtimeMs === stamp.mtimeMs && hit.size === stamp.size) {
		chatCache.delete(id); // refresh recency
		chatCache.set(id, hit);
		return hit.record;
	}
	chatCache.delete(id);
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(chatFile(id), "utf-8"));
	} catch {
		return null;
	}
	// Honest refusal (owner ruling 2026-10-10): a record stamped NEWER than
	// this build (the downgrade scenario) reads as absent, never misparsed —
	// the next read-modify-write must not rewrite what it doesn't understand.
	const v = (parsed as { version?: unknown }).version;
	if (typeof v === "number" && v > CURRENT_CHAT_VERSION) {
		console.error(`[chat ${id}] record stamped with schema version ${v} > ${CURRENT_CHAT_VERSION} — this app build is older; refusing to read it`);
		return null;
	}
	const record = parsed as ChatRecord;
	chatCache.set(id, { ...stamp, record });
	return record;
}

function listChats(): ChatSummary[] {
	try {
		fs.mkdirSync(PATHS.chats, { recursive: true });
		return fs
			.readdirSync(PATHS.chats)
			.filter((f) => f.endsWith(".json"))
			.map((f) => getChat(f.slice(0, -5)))
			.filter((r): r is ChatRecord => r !== null)
			.map(({ messages, tree, turns, extractions, ...summary }) => {
				// Per-record isolation (Wave B): a record whose messages fail the
				// projection (e.g. pre-Wave-B UIMessage-format scratch — the
				// zero-back-compat wipe makes these "corrupt") must not blank the
				// whole sidebar — same isolation getChat's per-file catch gives.
				try {
					return {
						// turns and extractions stay out of the list payload (list =
						// summaries; usage aggregates ride the full record, the picker
						// never needs them).
						...summary,
						// Normalized kind: absent record field reads as teach.
						kind: summary.kind ?? "teach",
						messageCount: messages.length,
						// Record-derived status for the session picker: phase from the
						// transcript's explicit events (probe_done concluded / verdict
						// accepted — docs/probe-teach-split.md §4), pending question
						// from the native dangling-call scan. Wave D: both folds read
						// the NATIVE record (core/phases.ts phaseAt3Lh +
						// native-messages.ts danglingQuestionOf). Liveness (busy) is
						// NOT record-derived — the API route merges it (ChatListItem).
						phase: phaseAt3Lh(messages),
						pendingQuestion: danglingQuestionOf(messages) !== null,
					};
				} catch (err) {
					console.error(`[chat ${summary.id}] summary projection failed:`, err);
					return null;
				}
			})
			.filter((s): s is ChatSummary => s !== null)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	} catch {
		return [];
	}
}

/** Persist the full native message list (the record IS the agent state —
 *  Wave B: replay is state.messages = record.messages). SILENT by the
 *  events law — see the SILENCE LAW comment at createChat. */
function saveMessages(id: string, messages: LhMessage[]): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	// Build a fresh record (never mutate the cached one — see the cache note).
	writeChat({ ...record, messages, updatedAt: new Date().toISOString() });
}

/** Append one usage entry to the record's turn log — idempotent per
 * turn id: each REQUEST carries its own id, so a replay of the same turn's
 * persist appends once, while continuation turns (which share a response
 *  message id) each keep their usage. */
function appendTurnUsage(id: string, entry: TurnUsage): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	const turns = record.turns?.some((t) => t.id === entry.id)
		? record.turns
		: [...(record.turns ?? []), entry];
	writeChat({ ...record, turns });
}

/** Append one extraction-run usage entry to the record's extractions
 * log — idempotent per startedAt: a retry that reaches the append twice
 * (abort replays) does not double-count spend. */
function appendExtractionUsage(id: string, entry: ExtractionRunUsage): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	const extractions = record.extractions?.some((r) => r.startedAt === entry.startedAt)
		? record.extractions
		: [...(record.extractions ?? []), entry];
	writeChat({ ...record, extractions });
}

/** Persist the per-chat model/thinking settings — replace-whole (the
 * picker sends the complete object; absent = config defaults). */
function saveSettings(id: string, settings: ChatSettings): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	// Like saveTree: a settings tweak is not conversation activity, so it
	// deliberately does NOT bump updatedAt (sidebar order must not churn).
	writeChat({ ...record, settings });
}

/** Rename a session (the header's click-to-edit title, 2026-09-17). Like
 * saveSettings, a rename is NOT conversation activity: updatedAt stays put
 * so sidebar order never churns. Same fallback as createChat — the empty
 * string becomes "Untitled session" (the API gate rejects it first; this
 * is the honest floor for any other caller). */
function renameChat(id: string, title: string): ChatRecord {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	const renamed = { ...record, title: title.trim() || "Untitled session" };
	writeChat(renamed);
	emit("chats-changed", {});
	return renamed;
}

/** Delete the session record file entirely (session-deletion wave 6,
 *  owner 2026-09-22). False when the id is unknown — the route turns that
 *  into a 404. The record's graph traces and jobs are the route's
 *  choreography (core/graph-deletion.ts), not the store's. */
function deleteChat(id: string): boolean {
	try {
		fs.unlinkSync(chatFile(id));
		chatCache.delete(id);
		emit("chats-changed", {}); // only a real removal — the present-entry law
		return true;
	} catch {
		return false; // never existed, already deleted, or unreadable — same answer
	}
}

/** Persist the session plan tree (plan tools call this in execute). */
function saveTree(id: string, tree: PlanTree): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	// Deliberately does NOT bump updatedAt: tree mutations piggyback on the
	// turn's saveMessages, and sidebar ordering shouldn't churn on tree edits.
	writeChat({ ...record, tree });
}

export const chatStore: ChatStore = {
	createChat,
	getChat,
	listChats,
	saveMessages,
	saveTree,
	saveSettings,
	renameChat,
	deleteChat,
	appendTurnUsage,
	appendExtractionUsage,
};
