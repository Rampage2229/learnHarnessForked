import { chainsForSelection, formatChainLine } from "@/src/core";
import { newGraphContextMessage, type GraphContextPick } from "@/src/core";
import type { Topic } from "@/src/core";
import {
	classifyTopicAssignment,
	compactionInFlight,
	createChat,
	effectiveSettings,
	isTurnRunning,
	listChats,
	readSettingsRecord,
	stores,
	titleFromPrompt,
	topicAssignmentDeps,
	topicStore,
} from "@/src/server";
import type { ChatListItem } from "@/src/core";

/** The session picker's list: record-derived summaries (phase, pending
 *  question) + live liveness — a running turn marks the session busy
 *  (contracts.ts ChatListItem; the store can't see liveness, the route is
 *  the merge point). Owner, minimal-color round: background jobs NO LONGER
 *  count — the sidebar's Background agents section is their channel now
 *  (a running spinner per row would double-signal them), so busy means
 *  exactly "a teach turn is in flight". */
export async function GET() {
	const chats: ChatListItem[] = listChats().map((c) => ({
		...c,
		busy: isTurnRunning(c.id),
		compacting: compactionInFlight(c.id),
	}));
	return Response.json({ chats });
}

export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { title?: unknown; kind?: unknown; graphContext?: unknown; topicId?: unknown };
	const title = typeof body.title === "string" ? body.title : "";
	// Practice sessions (owner, 2026-10-04): kind "practice" marks the
	// record — the practice agent + its tools from turn 1, no extraction.
	const kind = body.kind === "practice" ? ("practice" as const) : undefined;
	// Topics v1 (personal fork): an optional topicId in the creation body
	// stamps the record AND shapes the graph context below. Validated
	// BEFORE the record exists — an unknown topic creates nothing.
	const rawTopicId = typeof body.topicId === "string" ? body.topicId : undefined;
	let topic: Topic | null = null;
	if (rawTopicId !== undefined) {
		topic = topicStore.readTopics().find((t) => t.id === rawTopicId) ?? null;
		if (!topic) return Response.json({ error: `unknown topic "${rawTopicId}"` }, { status: 400 });
	}
	// AUTO TOPIC ASSIGNMENT (topics v1, personal fork, "agent" mode): a
	// topicless creation asks the CHEAP-tier classifier whether the opening
	// prompt fits an existing topic or deserves a new one — judged by
	// meaning over the topics' names, member-session titles, and sample
	// proposition names. The verdict resolves BEFORE createChat so the
	// record is born stamped (the explicit-topicId semantics, graph-context
	// seeding included). NEVER blocks or fails the creation: any error —
	// no cheap slot, provider failure, the 20s bound, garbage JSON, an
	// unknown assign id — degrades to "none". "ask" mode skips the call:
	// the session stays unassigned and the teacher proposes in-session.
	if (rawTopicId === undefined && title.length > 12 && effectiveSettings().agent.topicAssignment !== "ask") {
		try {
			const verdict = await classifyTopicAssignment(topicAssignmentDeps(), title);
			if (verdict.action === "assign") {
				// Re-read at stamp time: the classifier's catalog is a snapshot.
				topic = topicStore.readTopics().find((t) => t.id === verdict.topicId) ?? null;
			} else if (verdict.action === "create") {
				// The name is already validated (non-empty, ≤120) — but the
				// store's gate stays authoritative; a throw degrades to none.
				topic = topicStore.createTopic(verdict.name);
			}
		} catch {
			topic = null;
		}
	}
	const chat = createChat(titleFromPrompt(title || "Untitled session"), kind, topic?.id);
	// PER-SESSION MODELS (owner, 2026-09-28): a session owns its model +
	// thinking level from birth — stamped verbatim from the STRONG slot,
	// the new-session default. From here the strong slot never reaches
	// this session again: in-session picks write the session's own record
	// (PUT /api/chats/:id/settings). No strong slot configured (fresh BYOK
	// boot) → no stamp; the turn gate's 503 models_not_configured envelope
	// refuses honestly until the setup flow fills the slot.
	const strong = readSettingsRecord()?.models?.strong;
	if (strong?.model) {
		stores.chatStore.saveSettings(chat.id, {
			model: { provider: strong.model.provider, id: strong.model.id },
			thinkingLevel: strong.thinkingLevel,
		});
	}
	// The session's map context (owner, 2026-10-04): the picked
	// propositions ride the CREATION — message[0] is a graph-context
	// marker (a separate custom message BEFORE the learner's first user
	// message), carrying the picks plus the reasoning chains among them.
	// The picks carry their own name/statement (what the learner saw at
	// pick time); the chains derive from the CURRENT graph snapshot.
	const rawPicks = (body.graphContext as { propositions?: unknown } | undefined)?.propositions;
	const clientPicks: GraphContextPick[] = Array.isArray(rawPicks)
		? rawPicks
				.filter(
						(p): p is GraphContextPick =>
							typeof p === "object" &&
							p !== null &&
							typeof (p as GraphContextPick).id === "string" &&
							typeof (p as GraphContextPick).name === "string" &&
							typeof (p as GraphContextPick).statement === "string",
					)
					.slice(0, 64)
			: [];
	// TOPIC-FIRST SEEDING (topics v1, personal fork): a session born into
	// a topic opens with its topic's knowledge in context — the member
	// sessions' propositions seed the candidate set BEFORE the learner's
	// own picks (first occurrence wins the dedupe, so topic nodes lead),
	// under the same 64-pick cap. A topicless creation is byte-identical
	// to the pre-topics behavior.
	let picks: GraphContextPick[] = clientPicks;
	if (topic) {
		const memberIds = new Set(topic.sessionIds);
		const topicPicks: GraphContextPick[] = stores.graphStore
			.readNodes()
			.filter((n) => n.provenance.some((p) => memberIds.has(p.chatId)))
			.map((n) => ({ id: n.id, name: n.name, statement: n.statement }));
		const seen = new Set<string>();
		picks = [];
		for (const p of [...topicPicks, ...clientPicks]) {
			if (seen.has(p.id)) continue;
			seen.add(p.id);
			picks.push(p);
			if (picks.length >= 64) break;
		}
	}
	if (picks.length > 0) {
		const byId = new Map(stores.graphStore.readNodes().map((n) => [n.id, n]));
		const pickedNodes = picks.map((p) => byId.get(p.id)).filter((n) => n !== undefined);
		const chainLines = chainsForSelection(pickedNodes, stores.graphStore.readChains()).map((c) =>
			formatChainLine(c, Object.fromEntries(byId)),
		);
		stores.chatStore.saveMessages(chat.id, [newGraphContextMessage(picks, chainLines)]);
	}
	return Response.json({ id: chat.id, title: chat.title });
}
