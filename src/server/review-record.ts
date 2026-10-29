/**
 * Review recording — the pure extraction of graded answers from a chat
 * transcript, plus the turn-safe append seam (review v1, personal fork).
 *
 * The question tool call carries the node anchor (quiz/explain: nodeId;
 * practice problem: target ids); the learner's answer arrives as that
 * call's ToolResultMessage with the graded QuestionAnswerData in details.
 * probe/recall carry no nodeId (the prober's names-only graph ruling) and
 * are deliberately skipped in v1.
 */
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { LhMessage } from "../core/native-messages.ts";
import type { QuestionAnswerData } from "../core/question-core.ts";
import type { ReviewEntry, ReviewOutcome, ReviewSource } from "../core/reviews.ts";
import { appendReview } from "../store/reviews.ts";

const ANCHORED_TOOLS: ReadonlyMap<string, { source: ReviewSource; field: "nodeId" | "target" }> = new Map([
	["quiz", { source: "quiz", field: "nodeId" }],
	["explain", { source: "explain", field: "nodeId" }],
	["problem", { source: "practice", field: "target" }],
]);

function outcomeOf(details: unknown): ReviewOutcome | null {
	const d = details as Partial<QuestionAnswerData> | undefined;
	if (!d || d.dismissed) return null; // skipped — no signal
	if (d.dontKnow) return "dontKnow";
	if (d.correct === true) return "correct";
	if (d.correct === false) return "wrong";
	return "seen"; // explain/recall — the model grades next turn; mark seen
}

/** Walk the transcript and emit one review entry per anchored, answered
 *  question. Pure — the caller owns persistence + chatId. */
export function reviewEntriesFromMessages(
	messages: readonly LhMessage[],
	chatId: string,
	now: Date = new Date(),
): ReviewEntry[] {
	const calls = new Map<string, { name: string; args: unknown }>();
	for (const m of messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		const assistant = m as AssistantMessage;
		for (const block of assistant.content) {
			if (block.type !== "toolCall") continue;
			calls.set(block.id, { name: block.name, args: block.arguments });
		}
	}

	const out: ReviewEntry[] = [];
	for (const m of messages) {
		if ((m as { role?: string }).role !== "toolResult") continue;
		const result = m as ToolResultMessage;
		if (result.isError) continue;
		const anchored = ANCHORED_TOOLS.get(result.toolName);
		if (!anchored) continue;
		const call = calls.get(result.toolCallId);
		if (!call) continue;
		const outcome = outcomeOf(result.details);
		if (!outcome) continue;
		const nodeIds = anchored.field === "nodeId"
			? (typeof (call.args as Record<string, unknown> | null | undefined)?.nodeId === "string"
				? [(call.args as { nodeId: string }).nodeId]
				: [])
			: Array.isArray((call.args as Record<string, unknown> | null | undefined)?.target)
				? ((call.args as { target: string[] }).target.filter((t) => typeof t === "string"))
				: [];
		const details = result.details as Partial<QuestionAnswerData> | undefined;
		const picked = Array.isArray(details?.answers)
			? details.answers.map((a) => a.label).filter((l): l is string => typeof l === "string")
			: [];
		for (const nodeId of nodeIds) {
			if (!nodeId) continue;
			out.push({
				nodeId,
				chatId,
				at: now.toISOString(),
				outcome,
				...(outcome === "correct" || outcome === "wrong"
					? { confidence: details?.confidence }
					: {}),
				...(outcome === "wrong" || outcome === "dontKnow"
					? picked.length > 0 ? { wrongPicks: picked } : {}
					: {}),
				source: anchored.source,
			});
		}
	}
	return out;
}

/** Turn-safe append: a review failure must never break the turn. Returns
 *  the number of entries recorded (0 on any failure). */
export function recordReviews(messages: readonly LhMessage[], chatId: string): number {
	try {
		const entries = reviewEntriesFromMessages(messages, chatId);
		for (const e of entries) appendReview(e);
		return entries.length;
	} catch {
		return 0;
	}
}