/**
 * The user-memory PROMPT BLOCK (memory v1, personal fork) — the server
 * seam between the store and the agents: src/agent must never import
 * src/store (the import law), so the chat-handler renders the block HERE
 * per turn and threads it into AgentBuildOptions.memoryBlock, where
 * baseAgentOptions appends it as the system prompt's final segment.
 *
 * Cached by the file's (mtimeMs, size) stamp — the chatStamp pattern
 * (src/store/chats.ts): the injection happens per turn, the file is tiny,
 * and any write (Settings → Memory, a hand edit) changes the stamp and
 * forces a re-read. A missing file stamps null and renders null.
 */

import * as fs from "node:fs";
import { PATHS } from "../../config.ts";
import { memoryStore } from "../store/memory.ts";
import type { MemoryEntry } from "../core/contracts.ts";

/** The block's character ceiling (~4000): bullets are dropped
 *  OLDEST-first until the block fits, and the truncation is NOTED. */
export const MEMORY_BLOCK_MAX_CHARS = 4000;

const MEMORY_HEADER = "USER MEMORY — standing context the learner asked you to keep in mind:";

interface MemoryStamp {
	mtimeMs: number;
	size: number;
}

let cache: { stamp: MemoryStamp | null; block: string | null } | null = null;

function memoryStamp(): MemoryStamp | null {
	try {
		const st = fs.statSync(PATHS.memory);
		return { mtimeMs: st.mtimeMs, size: st.size };
	} catch {
		return null;
	}
}

/** The block text for one entry set: newest FIRST (the reader cares most
 *  about what the learner curated latest), one bullet per entry. */
function renderBlock(entries: readonly MemoryEntry[]): string | null {
	if (entries.length === 0) return null;
	const lines = [...entries].reverse().map((e) => `- ${e.text}`);
	const note = (omitted: number) =>
		`\n(… ${omitted} older ${omitted === 1 ? "entry" : "entries"} omitted — the block caps at ${MEMORY_BLOCK_MAX_CHARS} characters; the full list lives in Settings → Memory.)`;
	let kept = lines;
	for (;;) {
		const omitted = lines.length - kept.length;
		const body = [MEMORY_HEADER, ...kept, ...(omitted > 0 ? [note(omitted)] : [])].join("\n");
		if (body.length <= MEMORY_BLOCK_MAX_CHARS) return body;
		kept = kept.slice(0, -1); // drop the oldest line and re-check
	}
}

/** null = no memories (the prompt stays byte-identical to the pre-memory
 *  composition); otherwise the capped, newest-first block. */
export function renderMemoryBlock(): string | null {
	const stamp = memoryStamp();
	if (cache && cache.stamp?.mtimeMs === stamp?.mtimeMs && cache.stamp?.size === stamp?.size) {
		return cache.block;
	}
	const block = renderBlock(memoryStore.readMemory());
	cache = { stamp, block };
	return block;
}
