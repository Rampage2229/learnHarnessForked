/**
 * Pure unit tests over components/api-json.ts (the defensive parse
 * helpers backing the hardened client fetch paths). No React, no fetch,
 * no I/O — exhaustive over the shapes the routes and the failure modes
 * can produce: arrays, envelopes, null, strings, numbers, undefined,
 * and the `key` opt-in (bare array, named envelope, wrong field, no
 * field, undefined key). The contract under test: NEVER throw, and the
 * container shape is always safe to iterate.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { asArray, asObject } from "../components/api-json.ts";

describe("asArray", () => {
	describe("bare array body (the older route shape)", () => {
		it("returns the array as-is for a populated array", () => {
			assert.deepEqual(asArray([1, 2, 3]), [1, 2, 3]);
		});
		it("returns the array as-is for an empty array", () => {
			assert.deepEqual(asArray([]), []);
		});
		it("returns the array as-is even when a key is provided (bare wins)", () => {
			// A route that drifted to the envelope shape is detected, but the
			// legacy bare-array body is still honored when present — the key
			// is only consulted when the body is NOT already an array.
			assert.deepEqual(asArray(["a"], "items"), ["a"]);
		});
		it("preserves object elements without copying", () => {
			const obj = { id: 1 };
			const out = asArray([obj]);
			assert.equal(out[0], obj); // identity, not a clone
		});
	});

	describe("envelope body { key: [...] }", () => {
		it("returns the named field when it is an array", () => {
			assert.deepEqual(asArray({ topics: ["t1", "t2"] }, "topics"), ["t1", "t2"]);
		});
		it("returns the named field for an empty envelope array", () => {
			assert.deepEqual(asArray({ chats: [] }, "chats"), []);
		});
		it("returns the named field when the envelope also carries other keys", () => {
			const body = { states: [1], due: ["x"], extra: 9 };
			assert.deepEqual(asArray(body, "states"), [1]);
		});
		it("picks the exact key — a different array-valued field is ignored", () => {
			const body = { states: [1], due: ["x"] };
			assert.deepEqual(asArray(body, "due"), ["x"]);
			assert.deepEqual(asArray(body, "states"), [1]);
		});
	});

	describe("surprise shapes degrade to empty — never throw", () => {
		it("null body → []", () => {
			assert.deepEqual(asArray(null), []);
			assert.deepEqual(asArray(null, "items"), []);
		});
		it("undefined body → []", () => {
			assert.deepEqual(asArray(undefined), []);
			assert.deepEqual(asArray(undefined, "items"), []);
		});
		it("a number body → []", () => {
			assert.deepEqual(asArray(42), []);
			assert.deepEqual(asArray(42, "items"), []);
		});
		it("a string body → []", () => {
			assert.deepEqual(asArray("hello"), []);
			assert.deepEqual(asArray("hello", "items"), []);
		});
		it("a boolean body → []", () => {
			assert.deepEqual(asArray(true), []);
			assert.deepEqual(asArray(false, "items"), []);
		});
		it("an object whose named field is missing → []", () => {
			assert.deepEqual(asArray({ other: 1 }, "topics"), []);
		});
		it("an object whose named field is present but not an array → []", () => {
			assert.deepEqual(asArray({ topics: "not-an-array" }, "topics"), []);
			assert.deepEqual(asArray({ topics: null }, "topics"), []);
			assert.deepEqual(asArray({ topics: 7 }, "topics"), []);
			assert.deepEqual(asArray({ topics: { a: 1 } }, "topics"), []);
		});
		it("an object body with NO key opt-in → [] (object is not a bare array)", () => {
			// The helper does not guess envelope keys — without a key it only
			// accepts a bare array.
			assert.deepEqual(asArray({ topics: [1] }), []);
		});
		it("an array-valued body with a key still returns the bare array (defensive — a 404 page body that happened to be an array stays the array)", () => {
			assert.deepEqual(asArray([1, 2], "topics"), [1, 2]);
		});
	});

	describe("key handling", () => {
		it("undefined key → bare-array contract only", () => {
			assert.deepEqual(asArray([1], undefined), [1]);
			assert.deepEqual(asArray({ items: [1] }, undefined), []);
		});
		it("empty-string key → bare-array contract only (no envelope read)", () => {
			assert.deepEqual(asArray([1], ""), [1]);
			assert.deepEqual(asArray({ "": [1] }, ""), []);
		});
		it("key that matches an array field in a nested-looking object still reads the top level", () => {
			// Confirms it is a shallow read of body[key], not a deep search.
			const body = { topics: [1], nested: { topics: [2] } };
			assert.deepEqual(asArray(body, "topics"), [1]);
		});
		it("works with arbitrary string keys", () => {
			assert.deepEqual(asArray({ "weird key 7": [true, false] }, "weird key 7"), [true, false]);
		});
	});

	describe("does not throw on hostile inputs", () => {
		it("never throws for a large object body", () => {
			const body: Record<string, unknown> = {};
			for (let i = 0; i < 1000; i++) body[`k${i}`] = i;
			assert.deepEqual(asArray(body, "missing"), []);
		});
		it("never throws for a prototype-polluted-looking object", () => {
			// The helper reads the field by own-key access; a polluted
			// prototype field is not an array, so it degrades safely.
			const body = Object.create(null);
			body.topics = [1];
			assert.deepEqual(asArray(body, "topics"), [1]);
			const body2 = Object.create(null);
			assert.deepEqual(asArray(body2, "topics"), []);
		});
	});
});

describe("asObject", () => {
	describe("real objects", () => {
		it("returns a plain object as a record", () => {
			assert.deepEqual(asObject({ a: 1 }), { a: 1 });
		});
		it("returns an empty object", () => {
			assert.deepEqual(asObject({}), {});
		});
		it("returns an object with array fields (does not unwrap them)", () => {
			const body = { topics: [1], due: ["x"] };
			assert.equal(asObject(body), body);
		});
		it("preserves identity (no clone)", () => {
			const body = { a: 1 };
			assert.equal(asObject(body), body);
		});
	});

	describe("non-objects degrade to null", () => {
		it("null → null", () => {
			assert.equal(asObject(null), null);
		});
		it("undefined → null", () => {
			assert.equal(asObject(undefined), null);
		});
		it("array → null (an array is not a record envelope)", () => {
			assert.equal(asObject([1, 2, 3]), null);
			assert.equal(asObject([]), null);
		});
		it("number → null", () => {
			assert.equal(asObject(42), null);
		});
		it("string → null", () => {
			assert.equal(asObject("hi"), null);
		});
		it("boolean → null", () => {
			assert.equal(asObject(true), null);
		});
	});

	describe("usage with asArray (the envelope read pattern)", () => {
		it("reads a typed envelope safely: asObject then asArray", () => {
			const body = { topics: [{ id: "a" }], due: ["x"] };
			const obj = asObject(body);
			assert.notEqual(obj, null);
			// The hardened call sites compose the two: object-narrow first,
			// then pull the array field (or empty).
			assert.deepEqual(asArray(obj, "topics"), [{ id: "a" }]);
			assert.deepEqual(asArray(obj, "due"), ["x"]);
			assert.deepEqual(asArray(obj, "missing"), []);
		});
		it("a non-object body degrades through both to empty (never throws)", () => {
			const obj = asObject(null);
			assert.equal(obj, null);
			// asArray tolerates null even without the object step.
			assert.deepEqual(asArray(null, "topics"), []);
		});
	});
});
