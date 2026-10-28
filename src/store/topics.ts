/**
 * The TopicStore adapter (topics v1, personal fork): the named session
 * groups at config.PATHS.topics — data/topics.json, one versioned JSON
 * blob like memory.json. Atomic writes (tmp+rename, the auth.ts
 * discipline), NEVER throws on read (absent/corrupt file = [] = "no
 * topics yet", the settings doctrine).
 *
 * Topics group SESSIONS; node membership is DERIVED (core/topics.ts —
 * provenance folds), so this store never touches the graph ledgers or
 * the chat records: deleteTopic removes the group only, every session
 * and every node stays exactly where it was. Curated by the graph
 * view's Topics control (app/api/topics) + the new-session flow (the
 * topicId on POST /api/chats).
 *
 * Ordering invariant: topics are kept CREATION-ORDER on disk; the
 * sessionIds list is insertion-ordered and deduped (assignSessions).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { PATHS } from "../../config.ts";
import type { Topic } from "../core/contracts.ts";

export type { Topic };

/** The name cap (post-trim) — oversized names are rejected, not
 *  truncated (the memory.ts discipline: a silent clip would corrupt the
 *  learner's own label). */
export const MAX_TOPIC_NAME = 120;

/** The topics file format this build writes and understands. */
const TOPICS_VERSION = 1;

function writeTopicsFile(topics: Topic[]): void {
	const dir = path.dirname(PATHS.topics);
	fs.mkdirSync(dir, { recursive: true });
	// Atomic swap (the auth.ts discipline): tmp-in-same-dir + rename — a
	// partial write can never leave a truncated JSON (which would read as
	// "no topics yet" and silently drop the learner's groups).
	const tmp = path.join(dir, `.topics.json.tmp-${process.pid}`);
	fs.writeFileSync(tmp, `${JSON.stringify({ version: TOPICS_VERSION, topics }, null, "\t")}\n`, "utf-8");
	fs.renameSync(tmp, PATHS.topics);
}

/** The sanitized read: absent/corrupt/wrong-shape → []; a version stamped
 *  NEWER than this build is refused honestly (the chats.ts precedent — a
 *  read-modify-write store must never rewrite what it doesn't understand);
 *  malformed topics are filtered, never fatal for the whole file. */
function readTopicsFile(): Topic[] {
	try {
		const parsed = JSON.parse(fs.readFileSync(PATHS.topics, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
		const version = (parsed as { version?: unknown }).version;
		if (typeof version === "number" && version > TOPICS_VERSION) {
			console.error(
				`[topics] file stamped with format version ${version} > ${TOPICS_VERSION} — this app build is older; refusing to read it`,
			);
			return [];
		}
		const raw = (parsed as { topics?: unknown }).topics;
		if (!Array.isArray(raw)) return [];
		return raw.filter(
			(t): t is Topic =>
				!!t && typeof t === "object" &&
				typeof (t as Topic).id === "string" &&
				typeof (t as Topic).name === "string" &&
				typeof (t as Topic).createdAt === "string" &&
				Array.isArray((t as Topic).sessionIds) &&
				(t as Topic).sessionIds.every((s) => typeof s === "string"),
		);
	} catch {
		return []; // absent or corrupt — the documented state is "no topics yet"
	}
}

/** The name gate, shared by create/rename: trimmed, non-empty, within
 *  the cap. Violations throw (the route surfaces the message as a 400). */
function assertValidName(name: string): string {
	const trimmed = name.trim();
	if (trimmed.length === 0) throw new Error("Topic name cannot be empty");
	if (trimmed.length > MAX_TOPIC_NAME) throw new Error(`Topic name is limited to ${MAX_TOPIC_NAME} characters`);
	return trimmed;
}

export const topicStore = {
	readTopics(): Topic[] {
		return readTopicsFile();
	},

	createTopic(name: string): Topic {
		const clean = assertValidName(name);
		const topic: Topic = {
			id: `top_${randomBytes(6).toString("hex")}`,
			name: clean,
			sessionIds: [],
			createdAt: new Date().toISOString(),
		};
		writeTopicsFile([...readTopicsFile(), topic]);
		return topic;
	},

	renameTopic(id: string, name: string): Topic {
		return this.updateTopic(id, { name });
	},

	/** ONE read-modify-write for rename + assignment combined (a route
	 *  doing them as two writes could race a concurrent DELETE between
	 *  them and lose one operation). Unknown id → Error with status 404. */
	updateTopic(id: string, change: { name?: string; add?: string[]; remove?: string[] }): Topic {
		const topics = readTopicsFile();
		const topic = topics.find((t) => t.id === id);
		if (!topic) {
			const err = new Error(`Unknown topic "${id}"`) as Error & { status: number };
			err.status = 404;
			throw err;
		}
		let updated = topic;
		if (change.name !== undefined) updated = { ...updated, name: assertValidName(change.name) };
		if (change.add !== undefined || change.remove !== undefined) {
			const sessions = new Set(updated.sessionIds);
			for (const sid of change.add ?? []) if (sid) sessions.add(sid);
			for (const sid of change.remove ?? []) sessions.delete(sid);
			updated = { ...updated, sessionIds: [...sessions] };
		}
		writeTopicsFile(topics.map((t) => (t.id === id ? updated : t)));
		return updated;
	},

	/** Remove the group ONLY — the sessions and their graph nodes are
	 *  never touched (membership was derived, nothing to untag). False
	 *  when the id is unknown — the route's 404. */
	deleteTopic(id: string): boolean {
		const topics = readTopicsFile();
		if (!topics.some((t) => t.id === id)) return false;
		writeTopicsFile(topics.filter((t) => t.id !== id));
		return true;
	},

	/** Assign sessions to the topic: add/remove id lists, deduped,
	 *  insertion order preserved (adds append, removes filter out).
	 *  Unknown session ids ride along harmlessly — membership folds match
	 *  provenance chatIds, and an id nothing mentions simply never does. */
	assignSessions(id: string, change: { add?: string[]; remove?: string[] }): Topic {
		return this.updateTopic(id, change);
	},
	/** add runs before remove — an id in both lists ends up removed. */

	/** The topic whose sessionIds contains the chatId — FIRST match in
	 *  creation order (a session in two topics resolves to the earlier
	 *  one). null when the session is unassigned. */
	findTopicBySession(chatId: string): Topic | null {
		return readTopicsFile().find((t) => t.sessionIds.includes(chatId)) ?? null;
	},
};
