/**
 * Defensive parse helpers for the client fetch paths (the class of bug
 * that blanked the home page: a UI aid did `.map()` on a non-array the
 * route never promised). Every render-critical fetch path that used to
 * cast the JSON body straight into a typed promise now funnels through
 * these two pure functions so a surprise shape can never throw into
 * render.
 *
 * `asArray` accepts BOTH the bare array AND the route's `{ key: [...] }`
 * envelope (older shapes returned the bare list), and falls back to an
 * empty list — exactly the doctrine use-retention already follows.
 * `asObject` narrows a parsed body to a record (or null) so an envelope
 * read never reaches `.map` on a non-array.
 *
 * Pure — no React, no fetch, no I/O. Exported for direct unit testing.
 */

/**
 * Coerce a parsed JSON body to an array, accepting either the bare array
 * or the route's `{ [key]: [...] }` envelope. Anything else (null,
 * numbers, strings, objects whose `key` is not an array) degrades to an
 * EMPTY array — never throws. Callers that still want to type-check the
 * elements should narrow further (the helpers guarantee shape of the
 * container, not of the items).
 *
 * Pass `key` only to opt into the envelope read; an empty/undefined key
 * keeps the bare-array-or-empty contract (the caller already knows it is
 * a bare list). `null`/`undefined` body always returns `[]`.
 */
export function asArray(body: unknown, key?: string): unknown[] {
	// The happy path for the older bare-array shape — return as-is (a copy
	// is not needed; callers never mutate the parsed body).
	if (Array.isArray(body)) return body;
	// The envelope path: the route answers `{ key: [...] }`. Only unwrap
	// when the body is a real object AND the named field is itself an array
	// — a present-but-non-array field (the route drifted, or a 404 HTML
	// page slipped through) degrades to empty rather than throwing.
	if (key !== undefined && key !== "") {
		if (body !== null && typeof body === "object" && !Array.isArray(body)) {
			const field = (body as Record<string, unknown>)[key];
			if (Array.isArray(field)) return field;
		}
	}
	return [];
}

/**
 * Narrow a parsed JSON body to a plain record (a non-null, non-array
 * object), or null. Lets an envelope reader safely pull named fields
 * without a typed cast that would lie on a surprise shape. A bare array
 * or a primitive degrades to null — the caller falls back to its empty
 * state rather than reaching `.map`/`.forEach` on the wrong thing.
 */
export function asObject(body: unknown): Record<string, unknown> | null {
	if (body !== null && typeof body === "object" && !Array.isArray(body)) {
		return body as Record<string, unknown>;
	}
	return null;
}
