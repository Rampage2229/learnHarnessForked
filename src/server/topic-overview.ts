/**
 * The topic_overview BUILDER (topics v1 + the prober's topic-aware
 * planning, personal fork): the composition root (src/server/chat-handler.ts)
 * closes over the stores + the topics record and hands the FINISHED TEXT to
 * the tool through the GraphToolContext (topicOverview) — the tool file
 * (src/agent/tools/graph.ts) stays logic-free: pure seams in, a string out.
 * Exported for tests: the formatting is pinned (topic-name header, the
 * caps, the honest omission notes).
 *
 * The deviation from the prober's names-only map ruling (owner ruling
 * 2026-09-23 — the map readers show no statement text) is documented at the
 * tool: the learner grouped these sessions deliberately — topic planning
 * depth is the point of the feature (personal fork).
 *
 * Membership is DERIVED (the topics v1 ruling, core/contracts/topics.ts):
 * a node belongs to the topic when any of its provenance chatIds is one of
 * the topic's sessions — nothing rides on the node records, so this fold
 * can never disagree with the learner's Topics view (it reads the same
 * stores the snapshot reads).
 */

import type { ChatStore, GraphStore } from "../core/ports.ts";
import type { Topic } from "../core/contracts.ts";

/** The proposition cap — beyond it, the first 200 name-sorted lines show
 *  and an honest count line notes the omission (the memory-block pattern:
 *  truncate AND say so). */
export const TOPIC_OVERVIEW_PROPOSITION_CAP = 200;
/** The member-session cap — same honest-omission discipline. */
export const TOPIC_OVERVIEW_SESSION_CAP = 50;

/** What the builder reads: narrow store slices + the topics record —
 *  nothing else (pure over its inputs, the graph tools' seam). The topics
 *  closure stays a closure so the record is re-read per call (a topic
 *  renamed or reassigned mid-turn reads fresh). */
export interface TopicOverviewDeps {
	chatStore: Pick<ChatStore, "getChat">;
	graphStore: Pick<GraphStore, "readNodes">;
	topics: () => readonly Topic[];
}

/** The overview text for one chat's topic, or null when the topicId no
 *  longer resolves (the topic was deleted mid-turn — the tool answers its
 *  honest fallback line). */
export function buildTopicOverview(deps: TopicOverviewDeps, chatTopicId: string): string | null {
	const topic = deps.topics().find((t) => t.id === chatTopicId);
	if (!topic) return null;

	// Member sessions: the topic's own insertion order (the learner's
	// curation order), each as title + id — an unresolvable id (a deleted
	// chat, a notes source) falls back honestly instead of vanishing.
	const sessionLines = topic.sessionIds.slice(0, TOPIC_OVERVIEW_SESSION_CAP).map((id) => {
		const chat = deps.chatStore.getChat(id);
		return `- ${chat?.title ?? "(untitled session)"} — id: ${id}`;
	});
	const sessionsSection =
		topic.sessionIds.length === 0
			? "Member sessions (0): none yet."
			: [
					`Member sessions (${topic.sessionIds.length}${topic.sessionIds.length > TOPIC_OVERVIEW_SESSION_CAP ? `, showing first ${TOPIC_OVERVIEW_SESSION_CAP}` : ""}):`,
					...sessionLines,
					...(topic.sessionIds.length > TOPIC_OVERVIEW_SESSION_CAP
						? [`(… ${topic.sessionIds.length - TOPIC_OVERVIEW_SESSION_CAP} more sessions not listed.)`]
						: []),
				].join("\n");

	// Propositions: the derived-membership fold, name-sorted, statement text
	// INCLUDED (the documented deviation — see the module comment).
	const memberSet = new Set(topic.sessionIds);
	const held = deps.graphStore
		.readNodes()
		.filter((n) => n.provenance.some((p) => memberSet.has(p.chatId)))
		.sort((a, b) => a.name.localeCompare(b.name));
	const propositionsSection =
		held.length === 0
			? "Propositions the topic holds (0): none yet — its sessions have not contributed any."
			: [
					`Propositions the topic holds (${held.length} total${held.length > TOPIC_OVERVIEW_PROPOSITION_CAP ? `, showing first ${TOPIC_OVERVIEW_PROPOSITION_CAP}` : ""}):`,
					...held.slice(0, TOPIC_OVERVIEW_PROPOSITION_CAP).map((n) => `- ${n.name} — ${n.statement}`),
					...(held.length > TOPIC_OVERVIEW_PROPOSITION_CAP
						? [`(… ${held.length - TOPIC_OVERVIEW_PROPOSITION_CAP} more propositions not listed.)`]
						: []),
				].join("\n");

	return [`Topic overview — ${topic.name}`, sessionsSection, propositionsSection].join("\n\n");
}
