/**
 * Practice-mode extraction view (personal fork, stage 3): the practice
 * transcript's extraction view — problem/solution/conclude/learner lines —
 * for sessions whose knowledge was DEMONSTRATED through practice rather
 * than taught.
 *
 * The epistemics doctrine (the owner's validated-only rule): a practice
 * session proves what the learner DEMONSTRATED. The view exposes exactly
 * the raw material (problem statement, committed solution, learner work,
 * the teacher's conclude verdict) and the extractor's instructions carry
 * the validated-only rule: extract a proposition ONLY from problems
 * concluded `solved` or `solvedWithHints`, never from surrendered,
 * moved-on, or dismissed ones — a misconception enters only as its true
 * correction when the verdict says it was repaired.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { LhMessage } from "./native-messages.ts";

import { failedOutputCallIds, PRACTICE_CONCLUDE_TOOL, PRACTICE_PROBLEM_TOOL } from "./native-messages.ts";

function toolBlocks(message: LhMessage): { block: { id: string; name: string; arguments?: unknown }; mid: string }[] {
	if ((message as { role?: string }).role !== "assistant") return [];
	const a = message as AssistantMessage;
	const mid = (a as unknown as { id?: string }).id ?? "";
	return ((a.content ?? []) as Array<{ type?: string; id?: string; name?: string; arguments?: unknown }>)
		.filter((b) => b.type === "toolCall" && typeof b.id === "string" && (b.name === PRACTICE_PROBLEM_TOOL || b.name === PRACTICE_CONCLUDE_TOOL))
		.map((b) => ({ block: { id: b.id!, name: b.name!, arguments: b.arguments }, mid }));
}

function argsOf(block: { arguments?: unknown }): Record<string, unknown> {
	return (block.arguments ?? {}) as Record<string, unknown>;
}

function str(v: unknown): string {
	return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
}

/** One practice message's extraction-view lines (the coverage anchors —
 *  the same id law as messageViewLines: the lines carry the message id). */
export function practiceViewLines(
	message: LhMessage,
	mid: string,
	failedOutputCalls: ReadonlySet<string> = failedOutputCallIds([message]),
): string[] {
	const lines: string[] = [];
	for (const { block, mid: blockMid } of toolBlocks(message)) {
		if (blockMid !== mid) continue;
		const args = argsOf(block);
		if (block.name === PRACTICE_PROBLEM_TOOL) {
			// A failed call never happened (the parity doctrine).
			if (failedOutputCalls.has(block.id)) continue;
			const statement = str(args.statement);
			if (!statement) continue;
			const targets = Array.isArray(args.target) ? args.target.filter((t) => typeof t === "string") : [];
			lines.push(`PROBLEM [${mid}] ${statement}${targets.length ? ` (targets: ${targets.join(", ")})` : ""}`);
			const solution = str(args.modelSolution);
			if (solution) lines.push(`SOLUTION [${mid}] ${solution}`);
		} else if (block.name === PRACTICE_CONCLUDE_TOOL) {
			const outcome = str(args.outcome);
			if (!outcome) continue;
			const verdict = str(args.verdict);
			const rung = str(args.rung);
			lines.push(`CONCLUDE [${mid}] outcome=${outcome}${rung ? ` rung=${rung}` : ""}${verdict ? ` — ${verdict}` : ""}`);
		}
	}
	return lines;
}

/** The practice view for a whole transcript: problem/solution/verdict
 *  lines plus the learner's committed work (the demonstration material —
 *  the extractor's doctrine decides what to credit). */
export function practiceView(messages: ReadonlyArray<LhMessage>, title?: string): string {
	const failedOutputCalls = failedOutputCallIds(messages);
	const lines: string[] = [];
	for (const message of messages) {
		const mid = (message as unknown as { id?: string }).id ?? "";
		for (const line of practiceViewLines(message, mid, failedOutputCalls)) lines.push(line);
	}
	const head = title && title.length > 0 ? `# ${title}\n\n` : "";
	return head + lines.join("\n\n");
}

