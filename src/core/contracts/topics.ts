/**
 * Topics contracts (topics v1, personal fork): named groups of SESSIONS —
 * the cross-chat organization layer over the one global knowledge graph.
 * Pure types — the file shape, caps, and id scheme are owned (and
 * enforced) by the store adapter (src/store/topics.ts).
 *
 * MEMBERSHIP IS DERIVED, never tagged (the v1 ruling): a node belongs to
 * a topic when any of its provenance chatIds is a session assigned to
 * that topic (core/topics.ts topicOfNode). Nothing rides on the node
 * records — deleting or editing a topic can never touch the graph.
 */

/** One topic. `id` is `top_` + 12 hex; `name` is trimmed and 1..120
 *  chars (the store rejects anything else); `sessionIds` holds chat ids
 *  (and notes-source ids — they are birth sessions too); timestamps are
 *  ISO. Order on disk is creation order; `findTopicBySession` resolves
 *  FIRST match in that order. */
export interface Topic {
	id: string;
	name: string;
	sessionIds: string[];
	createdAt: string;
}
