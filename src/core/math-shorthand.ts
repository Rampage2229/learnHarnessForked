/**
 * Math shorthand (math wave, personal fork): typing mathematics fast on a
 * keyboard, without dictation. Pure + browser-safe — the composer wraps an
 * existing input and calls expandMath on the way out; nothing here touches
 * the DOM.
 *
 * THE LAW: only text inside a math span is ever rewritten. Prose keeps its
 * slashes, asterisks and parentheses exactly. An escaped `\$` never opens
 * a span, and an unclosed `$` never swallows the rest of the text.
 */

/** A math span's INNER bounds (delimiters excluded). */
export interface MathSpan {
	/** Index of the first character after the opening delimiter. */
	start: number;
	/** Index after the last character before the closing delimiter. */
	end: number;
	/** `$$…$$` — display math. */
	display: boolean;
}

/**
 * Find math spans: `$$…$$` (display) and `$…$` (inline). Exported so the
 * preview renderer and the tests share one definition of "inside math".
 */
export function findMathSpans(text: string): MathSpan[] {
	const spans: MathSpan[] = [];
	let i = 0;
	while (i < text.length) {
		// An escaped delimiter is literal text, never a span boundary.
		if (text[i] === "\\") {
			i += 2;
			continue;
		}
		if (text[i] !== "$") {
			i += 1;
			continue;
		}
		const display = text[i + 1] === "$";
		const openLen = display ? 2 : 1;
		const close = display ? "$$" : "$";
		const bodyStart = i + openLen;
		// Scan for the closing delimiter, skipping escaped characters.
		let j = bodyStart;
		let closed = -1;
		while (j < text.length) {
			if (text[j] === "\\") {
				j += 2;
				continue;
			}
			if (text.startsWith(close, j)) {
				closed = j;
				break;
			}
			// A display span may not be closed by an inline `$` and vice
			// versa — `$$a$b$$` keeps the inline `$` as content.
			j += 1;
		}
		if (closed < 0) {
			// Unclosed: no span from here. Crucially, do NOT consume the rest
			// of the text — the remaining content is plain prose.
			break;
		}
		if (closed > bodyStart) spans.push({ start: bodyStart, end: closed, display });
		i = closed + close.length;
	}
	return spans;
}

/** Greek words → commands. Word-boundary matched (never `spin` → `s\pi n`). */
const GREEK = [
	"alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta",
	"iota", "kappa", "lambda", "mu", "nu", "xi", "pi", "rho", "sigma", "tau",
	"upsilon", "phi", "chi", "psi", "omega",
	"Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Phi", "Psi", "Omega",
] as const;

/** Greek words → commands (word-boundary matched at use time). */
const GREEK_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
	["alpha", "\\alpha"], ["beta", "\\beta"], ["gamma", "\\gamma"],
	["delta", "\\delta"], ["epsilon", "\\epsilon"], ["zeta", "\\zeta"],
	["eta", "\\eta"], ["theta", "\\theta"], ["iota", "\\iota"],
	["kappa", "\\kappa"], ["lambda", "\\lambda"], ["mu", "\\mu"],
	["nu", "\\nu"], ["xi", "\\xi"], ["pi", "\\pi"], ["rho", "\\rho"],
	["sigma", "\\sigma"], ["tau", "\\tau"], ["upsilon", "\\upsilon"],
	["phi", "\\phi"], ["chi", "\\chi"], ["psi", "\\psi"],
	["omega", "\\omega"], ["Gamma", "\\Gamma"], ["Delta", "\\Delta"],
	["Theta", "\\Theta"], ["Lambda", "\\Lambda"], ["Xi", "\\Xi"],
	["Pi", "\\Pi"], ["Sigma", "\\Sigma"], ["Phi", "\\Phi"],
	["Psi", "\\Psi"], ["Omega", "\\Omega"],
];

/** The ordered replacement table — LONGEST TRIGGER FIRST. */
const REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
	...GREEK_REPLACEMENTS,
	["...", "\\dots"],
	["<=>", "\\Leftrightarrow"],
	["=>", "\\Rightarrow"],
	["->", "\\to"],
	["!=", "\\neq"],
	["<=", "\\leq"],
	[">=", "\\geq"],
	["+-", "\\pm"],
	["sqrt(", "\\sqrt{"],
	["int_", "\\int_"],
	["sum_", "\\sum_"],
	["prod_", "\\prod_"],
	["lim_", "\\lim_"],
	["RR", "\\mathbb{R}"],
	["NN", "\\mathbb{N}"],
	["ZZ", "\\mathbb{Z}"],
	["QQ", "\\mathbb{Q}"],
	["CC", "\\mathbb{C}"],
	["oo", "\\infty"],
	["deg", "^\\circ"],
	["*", "\\cdot"],
];

const WORD_TRIGGERS = new Set<string>([...GREEK, "RR", "NN", "ZZ", "QQ", "CC", "oo", "deg"]);

/** Rewrite one span's inner text. `sqrt(` also closes its brace on the
 *  first `)` that follows, when there is one — otherwise it stays open. */
function expandSpanBody(body: string): string {
	let out = "";
	let i = 0;
	while (i < body.length) {
		if (body[i] === "\\") {
			// Pass escape sequences through untouched (`\alpha` stays as is).
			out += body.slice(i, i + 2);
			i += 2;
			continue;
		}
		const hit = REPLACEMENTS.find(([trigger]) => body.startsWith(trigger, i));
		if (!hit) {
			out += body[i];
			i += 1;
			continue;
		}
		const [trigger, replacement] = hit;
		if (WORD_TRIGGERS.has(trigger)) {
			// Word boundary: the char before must not be alphanumeric, the
			// char after must not continue the word.
			const before = i > 0 ? body[i - 1]! : "";
			const after = body[i + trigger.length] ?? "";
			if (/[A-Za-z0-9]/.test(before) || /[A-Za-z0-9]/.test(after)) {
				out += body[i];
				i += 1;
				continue;
			}
		}
		out += replacement;
		i += trigger.length;
		if (trigger === "sqrt(") {
			// Close the group at the next `)` if one exists in this span.
			const close = body.indexOf(")", i);
			if (close >= 0) {
				out += expandSpanBody(body.slice(i, close));
				out += "}";
				i = close + 1;
			}
		}
	}
	return out;
}

/**
 * Expand shorthand inside math spans only. The result outside the spans is
 * byte-identical to the input. Idempotent: already-expanded text passes
 * through unchanged (the replacements never produce their own triggers).
 */
export function expandMath(text: string): string {
	const spans = findMathSpans(text);
	if (spans.length === 0) return text;
	let out = "";
	let cursor = 0;
	for (const span of spans) {
		out += text.slice(cursor, span.start);
		out += expandSpanBody(text.slice(span.start, span.end));
		cursor = span.end;
	}
	out += text.slice(cursor);
	return out;
}

/** The palette's entries — trigger + insertion + a human label. */
export const MATH_SNIPPETS: ReadonlyArray<{ trigger: string; insertion: string; label: string }> = [
	{ trigger: "/", insertion: "\\frac{}{}", label: "Fraction" },
	{ trigger: "sqrt", insertion: "\\sqrt{}", label: "Square root" },
	{ trigger: "nthroot", insertion: "\\sqrt[n]{}", label: "Nth root" },
	{ trigger: "int", insertion: "\\int_{}^{} \\, d", label: "Integral" },
	{ trigger: "sum", insertion: "\\sum_{}^{}", label: "Sum" },
	{ trigger: "prod", insertion: "\\prod_{}^{}", label: "Product" },
	{ trigger: "lim", insertion: "\\lim_{ \\to }", label: "Limit" },
	{ trigger: "deriv", insertion: "\\frac{d}{dx}", label: "Derivative" },
	{ trigger: "partial", insertion: "\\frac{\\partial}{\\partial }", label: "Partial" },
	{ trigger: "matrix", insertion: "\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}", label: "2×2 matrix" },
	{ trigger: "vec", insertion: "\\vec{}", label: "Vector" },
	{ trigger: "dot", insertion: "\\cdot", label: "Dot product" },
	{ trigger: "cross", insertion: "\\times", label: "Cross product" },
	{ trigger: "arrow", insertion: "\\to", label: "Arrow" },
	{ trigger: "iff", insertion: "\\Leftrightarrow", label: "If and only if" },
	{ trigger: "forall", insertion: "\\forall", label: "For all" },
	{ trigger: "exists", insertion: "\\exists", label: "Exists" },
	{ trigger: "in", insertion: "\\in", label: "Element of" },
	{ trigger: "subset", insertion: "\\subset", label: "Subset" },
	{ trigger: "infty", insertion: "\\infty", label: "Infinity" },
	{ trigger: "approx", insertion: "\\approx", label: "Approximately" },
	{ trigger: "therefore", insertion: "\\therefore", label: "Therefore" },
];

/** Splice an insertion into a value at the caret (replacing a selection). */
export function insertAtCaret(
	value: string,
	caret: number,
	insertion: string,
	selectionEnd?: number,
): { value: string; caret: number } {
	const start = Math.max(0, Math.min(caret, value.length));
	const end = Math.max(start, Math.min(selectionEnd ?? start, value.length));
	const next = value.slice(0, start) + insertion + value.slice(end);
	// Land the caret inside the first `{}` pair when the snippet has one —
	// the palette's whole point is not making you arrow-key into it.
	const brace = insertion.indexOf("{}");
	const caretAfter = brace >= 0 ? start + brace + 1 : start + insertion.length;
	return { value: next, caret: caretAfter };
}
