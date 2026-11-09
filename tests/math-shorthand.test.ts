/**
 * Math shorthand tests (math wave, personal fork): the expander's law is
 * "prose is sacred; only math spans rewrite". Heavy coverage on the span
 * detection edge cases, every trigger, word boundaries, and idempotence.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const {
	findMathSpans,
	expandMath,
	MATH_SNIPPETS,
	insertAtCaret,
} = await import("../src/core/math-shorthand.ts");

describe("findMathSpans", () => {
	it("finds an inline span with inner bounds (delimiters excluded)", () => {
		const text = "so $x^2$ is nine";
		const spans = findMathSpans(text);
		assert.equal(spans.length, 1);
		assert.equal(spans[0]!.display, false);
		assert.equal(text.slice(spans[0]!.start, spans[0]!.end), "x^2");
	});

	it("finds a display span and marks it", () => {
		const text = "$$\\int_0^1 x dx$$";
		const spans = findMathSpans(text);
		assert.equal(spans.length, 1);
		assert.equal(spans[0]!.display, true);
		assert.equal(text.slice(spans[0]!.start, spans[0]!.end), "\\int_0^1 x dx");
	});

	it("finds adjacent spans", () => {
		const text = "$a$ and $b$";
		const spans = findMathSpans(text);
		assert.equal(spans.length, 2);
		assert.equal(text.slice(spans[0]!.start, spans[0]!.end), "a");
		assert.equal(text.slice(spans[1]!.start, spans[1]!.end), "b");
	});

	it("an escaped \\$ never opens or closes a span", () => {
		const text = "costs \\$5 and $x+y$ ends";
		const spans = findMathSpans(text);
		assert.equal(spans.length, 1);
		assert.equal(text.slice(spans[0]!.start, spans[0]!.end), "x+y");
	});

	it("an unclosed $ means no span — never swallows the rest", () => {
		const text = "price is $5 and counting";
		assert.deepEqual(findMathSpans(text), []);
	});

	it("display delimiters only close display spans ($$a$b$$ keeps the inline $ as content)", () => {
		const text = "$$a$b$$";
		const spans = findMathSpans(text);
		assert.equal(spans.length, 1);
		assert.equal(spans[0]!.display, true);
		assert.equal(text.slice(spans[0]!.start, spans[0]!.end), "a$b");
	});

	it("an empty display span is not a span", () => {
		assert.deepEqual(findMathSpans("$$"), []);
		// "$ $": a one-space body is a legal (if useless) span.
		assert.deepEqual(findMathSpans(""), []);
	});
});

describe("expandMath — the prose-sacred law", () => {
	it("prose outside spans is byte-identical", () => {
		const text = "the 3/4 split *really* matters -> here";
		assert.equal(expandMath(text), text);
	});

	it("rewrites inside inline spans only", () => {
		assert.equal(expandMath("so $x != y -> z$ holds"), "so $x \\neq y \\to z$ holds");
	});

	it("rewrites inside display spans", () => {
		assert.equal(expandMath("$$int_0^oo f(x) dx$$"), "$$\\int_0^\\infty f(x) dx$$");
	});

	it("escapes survive untouched inside spans", () => {
		assert.equal(expandMath("$\\alpha + 1$"), "$\\alpha + 1$");
	});

	it("idempotent: expand(expand(x)) === expand(x)", () => {
		const once = expandMath("$x != y -> RR, sum_1^2, sqrt(2)$");
		assert.equal(expandMath(once), once);
	});
});

describe("expandMath — triggers", () => {
	it("arrows and comparisons", () => {
		assert.equal(expandMath("$a <=> b$"), "$a \\Leftrightarrow b$");
		assert.equal(expandMath("$a => b$"), "$a \\Rightarrow b$");
		assert.equal(expandMath("$a <= b$"), "$a \\leq b$");
		assert.equal(expandMath("$a >= b$"), "$a \\geq b$");
		assert.equal(expandMath("$a != b$"), "$a \\neq b$");
		assert.equal(expandMath("$a +- b$"), "$a \\pm b$");
		// longest-trigger-first: <=> must not degrade to <= + >
		assert.ok(!expandMath("$a <=> b$").includes("\\leq"));
	});

	it("asterisk becomes cdot inside spans, prose asterisk untouched", () => {
		assert.equal(expandMath("$2 * 3$"), "$2 \\cdot 3$");
		const prose = "2 * 3 in a note";
		assert.equal(expandMath(prose), prose);
	});

	it("ellipsis", () => {
		assert.equal(expandMath("$1, 2, ..., n$"), "$1, 2, \\dots, n$");
	});

	it("sqrt closes its group when a ) exists in the span", () => {
		assert.equal(expandMath("$sqrt(x+1) + 2$"), "$\\sqrt{x+1} + 2$");
	});

	it("sqrt stays open without a closing )", () => {
		assert.equal(expandMath("$sqrt(2$"), "$\\sqrt{2$");
	});

	it("calc operators", () => {
		assert.equal(expandMath("$int_0^1$"), "$\\int_0^1$");
		assert.equal(expandMath("$sum_i=1^n$"), "$\\sum_i=1^n$");
		assert.equal(expandMath("$prod_i$"), "$\\prod_i$");
		assert.equal(expandMath("$lim_x$"), "$\\lim_x$");
	});

	it("blackboard sets with word boundaries", () => {
		assert.equal(expandMath("$x in RR$"), "$x in \\mathbb{R}$");
		assert.equal(expandMath("$ZZ$"), "$\\mathbb{Z}$");
		// a longer word containing the trigger is untouched
		assert.equal(expandMath("$RR$ and $ARR$"), "$\\mathbb{R}$ and $ARR$");
	});

	it("infinity and degree", () => {
		assert.equal(expandMath("$oo$"), "$\\infty$");
		assert.equal(expandMath("$45 deg$"), "$45 ^\\circ$");
	});

	it("greek words with boundaries — spin must not become s\\pi n", () => {
		assert.equal(expandMath("$alpha + beta$"), "$\\alpha + \\beta$");
		assert.equal(expandMath("$spin$"), "$spin$");
		assert.equal(expandMath("$alphabet$"), "$alphabet$");
		assert.equal(expandMath("$pi$"), "$\\pi$");
		// capital greek rides too
		assert.equal(expandMath("$Delta$"), "$\\Delta$");
	});

	it("multiple spans in one string each expand independently", () => {
		assert.equal(expandMath("$a -> b$ then prose, then $c != d$"), "$a \\to b$ then prose, then $c \\neq d$");
	});
});

describe("MATH_SNIPPETS", () => {
	it("has at least 16 palette entries with labels", () => {
		assert.ok(MATH_SNIPPETS.length >= 16);
		for (const s of MATH_SNIPPETS) {
			assert.ok(s.trigger.length > 0);
			assert.ok(s.insertion.length > 0);
			assert.ok(s.label.length > 0);
		}
	});
});

describe("insertAtCaret", () => {
	it("inserts at the caret and lands inside the first {} pair", () => {
		const r = insertAtCaret("ab", 1, "\\frac{}{}");
		assert.equal(r.value, "a\\frac{}{}b");
		assert.equal(r.caret, "a\\frac{".length);
	});

	it("replaces a selection and lands at the insertion end when no braces", () => {
		const r = insertAtCaret("aXXb", 1, "\\infty", 3);
		assert.equal(r.value, "a\\inftyb");
		assert.equal(r.caret, "a\\infty".length);
	});

	it("clamps out-of-range carets", () => {
		const r = insertAtCaret("ab", 99, "x");
		assert.equal(r.value, "abx");
		assert.equal(r.caret, 3);
	});
});
