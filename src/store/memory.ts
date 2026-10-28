/**
 * The MemoryStore adapter (memory v1, personal fork): the learner-curated
 * standing context at config.PATHS.memory — plain-text entries every
 * teaching agent receives as prompt context (the knowledge graph stays the
 * home of formal propositions; arbitrary "my mandarin audio lives in
 * ~/docs/mandarin" facts live here). Atomic writes, NEVER throws on read
 * (absent/corrupt file = [] = "no memories yet", the settings doctrine).
 *
 * The Memory section (components/settings/memory-section.tsx) curates via
 * app/api/memory; the SERVER renders the prompt block (src/server/memory.ts)
 * — src/agent never imports this module (the import law). The record shape
 * (MemoryEntry) lives in core/contracts/memory.ts like every other record.
 *
 * Ordering invariant: entries are kept NEWEST-LAST by createdAt on disk;
 * readers wanting the UI order (newest-first) reverse. The cap is 200
 * entries — addMemoryEntry drops the OLDEST when full.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { PATHS } from "../../config.ts";
import type { MemoryEntry } from "../core/contracts.ts";

export type { MemoryEntry };

/** The entry cap — addMemoryEntry evicts the oldest beyond this. */
export const MAX_MEMORY_ENTRIES = 200;
/** The per-entry text cap (post-trim) — oversized text is rejected, not
 *  truncated (a silent clip would corrupt the learner's context). */
export const MAX_MEMORY_TEXT = 2000;

/** The memory file format this build writes and understands. */
const MEMORY_VERSION = 1;

function writeMemoryFile(entries: MemoryEntry[]): void {
	// Canonical order on disk: newest-last by createdAt (stable sort keeps
	// same-stamp insertion order — updates keep their position).
	const ordered = [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	const dir = path.dirname(PATHS.memory);
	fs.mkdirSync(dir, { recursive: true });
	// Atomic swap (the auth.ts discipline): tmp-in-same-dir + rename — a
	// partial write can never leave a truncated JSON (which would read as
	// "no memories yet" and silently drop the learner's context).
	const tmp = path.join(dir, `.memory.json.tmp-${process.pid}`);
	fs.writeFileSync(tmp, `${JSON.stringify({ version: MEMORY_VERSION, entries: ordered }, null, "\t")}\n`, "utf-8");
	fs.renameSync(tmp, PATHS.memory);
}

/** The sanitized read: absent/corrupt/wrong-shape → []; a version stamped
 *  NEWER than this build is refused honestly (the chats.ts precedent — a
 *  read-modify-write store must never rewrite what it doesn't understand);
 *  malformed entries are filtered, never fatal for the whole file. */
function readMemoryFile(): MemoryEntry[] {
	try {
		const parsed = JSON.parse(fs.readFileSync(PATHS.memory, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
		const version = (parsed as { version?: unknown }).version;
		if (typeof version === "number" && version > MEMORY_VERSION) {
			console.error(
				`[memory] file stamped with format version ${version} > ${MEMORY_VERSION} — this app build is older; refusing to read it`,
			);
			return [];
		}
		const raw = (parsed as { entries?: unknown }).entries;
		if (!Array.isArray(raw)) return [];
		const entries = raw.filter(
			(e): e is MemoryEntry =>
				!!e && typeof e === "object" &&
				typeof (e as MemoryEntry).id === "string" &&
				typeof (e as MemoryEntry).text === "string" &&
				typeof (e as MemoryEntry).createdAt === "string" &&
				typeof (e as MemoryEntry).updatedAt === "string",
		);
		return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	} catch {
		return []; // absent or corrupt — the documented state is "no memories yet"
	}
}

/** The shared add/update text gate: trimmed, empty rejected, 2000-char
 *  ceiling — the thrown Errors are the API's 400 bodies verbatim. */
function validatedText(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) throw new Error("Memory text is empty.");
	if (trimmed.length > MAX_MEMORY_TEXT) throw new Error(`Memory text is limited to ${MAX_MEMORY_TEXT} characters.`);
	return trimmed;
}

function readMemory(): MemoryEntry[] {
	return readMemoryFile();
}

/** Append one entry (newest-last). When the store is full the OLDEST
 *  entry is evicted — the standing context stays fresh by construction. */
function addMemoryEntry(text: string): MemoryEntry {
	const clean = validatedText(text);
	const now = new Date().toISOString();
	const entry: MemoryEntry = {
		id: `mem_${randomBytes(6).toString("hex")}`,
		text: clean,
		createdAt: now,
		updatedAt: now,
	};
	const entries = readMemoryFile();
	entries.push(entry);
	while (entries.length > MAX_MEMORY_ENTRIES) entries.shift(); // oldest (newest-last order)
	writeMemoryFile(entries);
	return entry;
}

/** Replace one entry's text (createdAt — and so the ordering — stays put;
 *  updatedAt moves). Unknown id is a thrown Error, the caller's 404. */
function updateMemoryEntry(id: string, text: string): MemoryEntry {
	const clean = validatedText(text);
	const entries = readMemoryFile();
	const entry = entries.find((e) => e.id === id);
	if (!entry) throw new Error(`Unknown memory entry: ${id}`);
	entry.text = clean;
	entry.updatedAt = new Date().toISOString();
	writeMemoryFile(entries);
	return { ...entry };
}

/** Remove one entry. False when the id is unknown — the route turns that
 *  into a 404 (the deleteChat precedent: absent = an honest no). */
function deleteMemoryEntry(id: string): boolean {
	const entries = readMemoryFile();
	const next = entries.filter((e) => e.id !== id);
	if (next.length === entries.length) return false;
	writeMemoryFile(next);
	return true;
}

export const memoryStore = {
	readMemory,
	addMemoryEntry,
	updateMemoryEntry,
	deleteMemoryEntry,
};
