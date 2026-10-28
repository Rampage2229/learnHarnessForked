/**
 * AUTO TOPIC ASSIGNMENT (topics v1, personal fork) — two halves:
 *
 * 1. THE CREATION-TIME CLASSIFIER ("agent" mode): POST /api/chats with no
 *    explicit topicId asks a CHEAP-tier one-shot model whether the opening
 *    prompt fits one of the learner's existing topics (assign), deserves a
 *    new one (create), or neither (none). The verdict resolves BEFORE
 *    createChat so the record is born stamped (the explicit-topicId path's
 *    semantics — the graph context seeding rides the same `topic` view).
 *    ANY failure — no cheap slot, no such model, provider error, timeout,
 *    garbage JSON — silently degrades to "none": chat creation must never
 *    fail or block on this.
 *
 * 2. THE TEACHER'S TOPIC-MODE BLOCK: the per-session prompt line the
 *    teacher composes from the record's assignment state + the settings
 *    mode (ask → never assign without asking; agent → the classifier
 *    chose not to assign; assigned → the topic's name as plain context).
 *
 * Both live server-side (src/agent must never import src/store — the
 * import law): the agent layer receives finished text through
 * AgentBuildOptions.topicModeBlock and the topic tools receive the
 * composition root's wiring (chat-handler.ts topicToolsWiring).
 */

import { piModels } from "../agent/models.ts";
import { effectiveSettings } from "./stores.ts";
import { chatStore } from "../store/chats.ts";
import { graphStore } from "../store/graph.ts";
import { topicStore } from "../store/topics.ts";

/** What the classifier needs: the one-shot model call and the topic
 *  catalog. Injected so tests stay hermetic (no piModels, no stores). */
export interface TopicAssignmentDeps {
	/** One-shot text completion — the AbortSignal.timeout(20s) bound lives
	 *  in the IMPLEMENTATION (makeTopicAssignmentDeps), never here: a
	 *  caller-provided call owns its own failure envelope. */
	modelCall: (prompt: string) => Promise<string>;
	/** The learner's topics with the content the classifier judges by:
	 *  names, member-session titles, sample proposition names. */
	listTopics: () => Array<{
		id: string;
		name: string;
		sessionTitles: string[];
		samplePropositions: string[];
	}>;
}

/** The verdict: put the session into an existing topic, create a new one,
 *  or leave it unassigned. */
export type TopicVerdict =
	| { action: "assign"; topicId: string }
	| { action: "create"; name: string }
	| { action: "none" };

/** The topic-count ceiling for the classification call: the prompt lists
 *  every topic with its content, so beyond this the call's cost/size
 *  outweighs the judgment — honestly none (the session stays unassigned
 *  and the in-session tools still apply). */
export const TOPIC_ASSIGNMENT_TOPIC_CAP = 50;

/** A topic's member-session titles shown to the classifier (the chats'
 *  titles ARE the member-chat content, per the topics v1 ruling). */
const TITLE_CAP = 20;
/** A topic's sample proposition names shown to the classifier. */
const PROPOSITION_CAP = 8;

/** The classification prompt: the opening verbatim, the topic catalog,
 *  and the strict reply contract. Exported for the prompt-shape pins. */
export function buildAssignmentPrompt(
	openingPrompt: string,
	topics: Array<{ id: string; name: string; sessionTitles: string[]; samplePropositions: string[] }>,
): string {
	const catalog = topics.map((t) => {
		const sessions = t.sessionTitles.length > 0 ? t.sessionTitles.join(", ") : "no member sessions yet";
		const props = t.samplePropositions.length > 0 ? t.samplePropositions.join(", ") : "no propositions yet";
		return `- ${t.name} — id: ${t.id} (${t.sessionTitles.length} session${t.sessionTitles.length === 1 ? "" : "s"}; member sessions: ${sessions}; propositions: ${props})`;
	});
	return [
		"The learner is starting a new learning session. Decide how it relates to their existing topics.",
		"",
		"The session's opening prompt, verbatim:",
		"\"\"\"",
		openingPrompt,
		"\"\"\"",
		"",
		"Existing topics:",
		...(catalog.length > 0 ? catalog : ["(none — the learner has no topics yet)"]),
		"",
		"Instructions:",
		"- Decide the SINGLE best topic by MEANING — what this session will actually cover — not merely by name overlap.",
		'- If one existing topic clearly fits, reply exactly {"action":"assign","topicId":"<that topic\'s id>"} using its id from the list.',
		'- If no existing topic fits but the session clearly deserves a new one, reply exactly {"action":"create","name":"<short topic name, at most 60 characters>"}.',
		'- Reply {"action":"none"} when the opening is small talk, unrelated to every topic, or too vague to judge.',
		"- Reply ONLY with the minified JSON object — no prose, no code fence, no explanation.",
	].join("\n");
}

const NONE: TopicVerdict = { action: "none" };

/** Parse + validate the model's reply against the catalog it chose from:
 *  the first {...} object in the text (models preface despite orders),
 *  strict shape otherwise — every doubt degrades to none. Exported for
 *  the validation pins. */
export function parseVerdict(raw: string, topics: Array<{ id: string }>): TopicVerdict {
	const match = /\{[^{}]*\}/.exec(raw);
	if (!match) return NONE;
	let parsed: unknown;
	try {
		parsed = JSON.parse(match[0]);
	} catch {
		return NONE;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return NONE;
	const action = (parsed as { action?: unknown }).action;
	if (action === "none") return NONE;
	if (action === "assign") {
		const topicId = (parsed as { topicId?: unknown }).topicId;
		if (typeof topicId === "string" && topics.some((t) => t.id === topicId)) {
			return { action: "assign", topicId };
		}
		return NONE; // a hallucinated id is not an assignment
	}
	if (action === "create") {
		const name = (parsed as { name?: unknown }).name;
		if (typeof name === "string") {
			const trimmed = name.trim();
			if (trimmed.length > 0 && trimmed.length <= 120) return { action: "create", name: trimmed };
		}
		return NONE;
	}
	return NONE;
}

/** The classification: never throws, never rejects — every failure path
 *  (no topics data, over the cap, model error, bad reply) lands on none. */
export async function classifyTopicAssignment(deps: TopicAssignmentDeps, openingPrompt: string): Promise<TopicVerdict> {
	try {
		const topics = deps.listTopics();
		if (topics.length > TOPIC_ASSIGNMENT_TOPIC_CAP) return NONE;
		const prompt = buildAssignmentPrompt(openingPrompt, topics);
		const raw = await deps.modelCall(prompt);
		return parseVerdict(raw, topics);
	} catch {
		return NONE;
	}
}

/**
 * The PRODUCTION deps: the CHEAP tier is the right engine for a
 * classification call (the settings-resolution slot view), resolved fresh
 * per construction (the route builds deps per POST — a settings PUT lands
 * immediately). The 20s bound rides the stream's own abort signal; a
 * missing slot/model throws so the caller's catch degrades to none.
 */
export function makeTopicAssignmentDeps(): TopicAssignmentDeps {
	const slot = effectiveSettings().models.cheap;
	const modelCall = async (prompt: string): Promise<string> => {
		if (!slot) throw new Error("no cheap model configured");
		const model = piModels().getModel(slot.provider, slot.id);
		if (!model) throw new Error(`${slot.provider} catalog has no model ${slot.id}`);
		let out = "";
		const stream = piModels().streamSimple(
			model,
			{ messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
			{ signal: AbortSignal.timeout(20_000) },
		);
		for await (const event of stream) {
			if (event.type === "text_delta") out += event.delta;
		}
		return out;
	};
	const listTopics = () =>
		topicStore.readTopics().map((topic) => {
			const memberIds = new Set(topic.sessionIds);
			return {
				id: topic.id,
				name: topic.name,
				sessionTitles: topic.sessionIds
					.slice(0, TITLE_CAP)
					.map((id) => chatStore.getChat(id)?.title ?? "(untitled session)"),
				samplePropositions: graphStore
					.readNodes()
					.filter((n) => n.provenance.some((p) => memberIds.has(p.chatId)))
					.slice(0, PROPOSITION_CAP)
					.map((n) => n.name),
			};
		});
	return { modelCall, listTopics };
}

// ─── the test seam ───────────────────────────────────────────────────────────

let depsFactory: () => TopicAssignmentDeps = makeTopicAssignmentDeps;

/** TEST SEAM: swap the deps factory so route tests drive the classifier
 *  hermetically (a fake modelCall, no piModels, no network). null
 *  restores the production factory. */
export function setTopicAssignmentDepsFactory(factory: (() => TopicAssignmentDeps) | null): void {
	depsFactory = factory ?? makeTopicAssignmentDeps;
}

/** The deps the route uses — through the (swappable) factory. */
export function topicAssignmentDeps(): TopicAssignmentDeps {
	return depsFactory();
}

// ─── the teacher's topic-mode block ─────────────────────────────────────────

const ASK_MODE_BLOCK =
	"TOPIC ASSIGNMENT (ask mode): this session has no topic yet. If the conversation clearly fits one of the " +
	"learner's topics — or deserves a new one — ask the learner (ask_user_question) before using " +
	"assign_topic/create_topic. Never assign without asking.";

const AGENT_MODE_BLOCK =
	"TOPIC ASSIGNMENT (agent mode): this session is unassigned — a classifier chose not to assign it at creation. " +
	"If the conversation makes a topic fit obvious, use assign_topic/create_topic silently; otherwise leave it " +
	"unassigned.";

/** The per-session prompt line for the TEACHER (the composition root
 *  threads it into AgentBuildOptions.topicModeBlock; baseAgentOptions
 *  appends it as the final --- segment):
 *
 *  - unassigned → the mode's doctrine line (the topic tools are wired for
 *    exactly the same gate — an unassigned chat always carries them);
 *  - assigned → the one-line context (the prober's topic doctrine covers
 *    planning; the teacher just gets to know where it is);
 *  - an assigned id that no longer resolves (deleted mid-flight) → null:
 *    the prompt stays byte-identical to the pre-topics composition. */
export function topicModeBlockFor(
	record: { topicId?: string },
	mode: "agent" | "ask",
): string | null {
	if (record.topicId) {
		const topic = topicStore.readTopics().find((t) => t.id === record.topicId);
		return topic ? `This session belongs to the topic "${topic.name}".` : null;
	}
	return mode === "ask" ? ASK_MODE_BLOCK : AGENT_MODE_BLOCK;
}
