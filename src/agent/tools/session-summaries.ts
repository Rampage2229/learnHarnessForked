import { Type } from "typebox";
import { activeCompactionOf } from "../../core/compaction.ts";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { healToolRecord } from "./heal.ts";

/**
 * The session_summaries tool (assistant wave, personal fork): the
 * assistant's window into its topic's history. The learner's free-form
 * chat should know what he already studied — but member sessions can be
 * LONG, and reading full transcripts per turn would drown the context.
 * The honest middle: each member session's TITLE plus its COMPACTION
 * SUMMARY (the session's own model already distilled it when the
 * transcript crossed the threshold — core/compaction.ts's marker message
 * rides the record). Sessions never compacted report honestly as such;
 * the current session is excluded (the transcript IS its context).
 *
 * Data shape: LhMarkerMessage { customType: "compaction", content =
 * COMPACTED_HISTORY_HEADER + "\n\n" + summary } — the header is stripped
 * here so the model reads only the summary prose.
 */

/** Per-session summary ceiling (chars) — a summary is already a
 *  distillation; the cap only guards against pathological records. */
const SUMMARY_CAP = 3000;
/** Member-session ceiling per call — a giant topic reports its head and
 *  says so (the topic overview carries the same discipline). */
const SESSION_CAP = 20;

export interface SessionSummariesWiring {
	/** The session running the tool — excluded from its own topic's
	 *  list (the transcript IS its context). */
	currentChatId: string;
	/** The current chat's topic id (absent = unassigned — the tool
	 *  reports that honestly rather than lying silent). */
	topicIdOf: () => string | undefined;
	/** The topic record reader (fresh per call — renames/assignment
	 *  changes apply next call). */
	readTopics: () => Array<{ id: string; name: string; sessionIds: string[] }>;
	/** The chat record reader: null = unresolvable id (a deleted chat or
	 *  a notes source in the member list). */
	getChat: (id: string) => { title: string; messages: ReadonlyArray<unknown>; updatedAt?: string } | null;
}

const sessionSummariesInput = Type.Object({});

/** Extract one session's active compaction summary (or null): walks the
 *  record's messages for the newest compaction marker with a retained id
 *  (core/compaction.ts's activeCompactionOf) and strips the header. */
function summaryOf(messages: ReadonlyArray<unknown>): string | null {
	const marker = activeCompactionOf(messages as never);
	if (!marker) return null;
	const body = marker.content.startsWith("[SESSION HISTORY COMPACTED]")
		? marker.content.slice(marker.content.indexOf("\n\n") + 2)
		: marker.content;
	const trimmed = body.trim();
	return trimmed.length > SUMMARY_CAP ? `${trimmed.slice(0, SUMMARY_CAP)}… (summary truncated)` : trimmed;
}

export function sessionSummariesToolFor(ctx: SessionSummariesWiring): AgentTool<any> {
	const tool: AgentTool<typeof sessionSummariesInput> = {
		name: "session_summaries",
		label: "session_summaries",
		description:
			"List this topic's member sessions with their study summaries — what the learner already covered. " +
			"Call before claiming something is new to him, when summarizing the topic, or when your picture of his progress feels thin. " +
			"Compacted sessions carry a distilled summary; newer ones report 'no summary yet'.",
		parameters: sessionSummariesInput,
		executionMode: "sequential",
		execute: serverExecute("session_summaries", sessionSummariesInput, async (): Promise<string> => {
			const topicId = ctx.topicIdOf();
			if (!topicId) return "This session has no topic assigned — no member history to read.";
			const topic = ctx.readTopics().find((t) => t.id === topicId);
			if (!topic) return "This session's topic no longer exists — no member history to read.";
			const memberIds = topic.sessionIds.filter((id) => id !== ctx.currentChatId);
			if (memberIds.length === 0) return `Topic "${topic.name}" has no other member sessions yet — this is its first.`;
			const head = memberIds.slice(0, SESSION_CAP);
			const lines: string[] = [
				`Topic "${topic.name}" — ${memberIds.length} member session${memberIds.length === 1 ? "" : "s"}${memberIds.length > SESSION_CAP ? ` (showing first ${SESSION_CAP})` : ""}:`,
			];
			for (const id of head) {
				const chat = ctx.getChat(id);
				if (!chat) {
					lines.push(`- (unresolvable session ${id} — deleted or not a session)`);
					continue;
				}
				const summary = summaryOf(chat.messages);
				lines.push(
					summary
						? `- "${chat.title}" (id: ${id}) — covered:\n${summary}`
						: `- "${chat.title}" (id: ${id}) — no summary yet (transcript not compacted; ask him or read the session for detail)`,
				);
			}
			if (memberIds.length > SESSION_CAP) lines.push(`(… ${memberIds.length - SESSION_CAP} more sessions not listed.)`);
			return lines.join("\n");
		}),
	};
	return healToolRecord({ session_summaries: tool }).session_summaries!;
}
