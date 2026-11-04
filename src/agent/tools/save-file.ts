import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { resolveSourcePath } from "./fs-shared.ts";

/**
 * The save_file tool (assistant wave, personal fork): the harness's first
 * WRITE into the learner's filesystem. The read/ls/find/grep set is
 * read-only by the sources-v1 lock; this tool is the deliberate scope
 * widening the owner asked for — the assistant (and the teacher) produce
 * study artifacts (guides, summaries, notes) the learner asked to KEEP,
 * not just read in the transcript.
 *
 * Safety posture (owner-set, 2026-11): paths resolve home-anchored like
 * every fs tool (relative/~/ against the learner's home; absolute paths
 * pass through — the owner explicitly accepts agents touching system
 * paths). The one guard that is non-negotiable: an EXISTING file is never
 * silently overwritten — the call must carry overwrite: true, so a stale
 * agent picture of the file can't destroy the learner's own edits.
 * Parents are created as needed (mkdir -p semantics).
 */

/** 2MB — a study artifact ceiling. Guides/notes never approach it; the
 *  cap is the runaway-loop guard (a model looping on writes shouldn't
 *  be able to fill a disk). */
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;

const saveFileInput = Type.Object({
	path: Type.String({
		minLength: 1,
		description:
			"Where to write the file. Relative paths and ~ resolve against the learner's home directory; absolute paths pass through. Parent directories are created automatically.",
	}),
	content: Type.String({
		minLength: 1,
		maxLength: MAX_CONTENT_BYTES,
		description: "The complete file content, written verbatim (utf-8).",
	}),
	overwrite: Type.Optional(
		Type.Boolean({
			description:
				"Set true to replace an existing file. Default false: the call fails on an existing path rather than silently destroying it — check with read/ls first when unsure.",
		}),
	),
});

export const saveFileTool: AgentTool<typeof saveFileInput> = {
	name: "save_file",
	label: "save_file",
	description:
		"Write a file to the learner's disk (utf-8, parent directories auto-created). " +
		"Use for study artifacts the learner asked to keep — guides, summaries, notes, exportable lists — written ONCE, complete, at a deliberate path. " +
		"Never overwrite an existing file unless you mean it (overwrite: true; read it first).",
	parameters: saveFileInput,
	executionMode: "sequential",
	execute: serverExecute("save_file", saveFileInput, async (input): Promise<string> => {
		const target = resolveSourcePath(input.path);
		if (target === path.parse(target).root) {
			throw new Error("save_file refuses to write a filesystem root — name a file, not a drive");
		}
		let existing: Stats | null = null;
		try {
			existing = await fs.stat(target);
		} catch {
			/* absent — the normal path */
		}
		if (existing?.isDirectory()) {
			throw new Error(`${target} is a directory — pick a file path`);
		}
		if (existing && !input.overwrite) {
			throw new Error(`${target} already exists — read it first and pass overwrite: true to replace it (or choose a new path)`);
		}
		const bytes = Buffer.byteLength(input.content, "utf-8");
		if (bytes > MAX_CONTENT_BYTES) {
			throw new Error(`content is ${bytes} bytes — the ceiling is ${MAX_CONTENT_BYTES} (write a smaller artifact)`);
		}
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, input.content, "utf-8");
		return existing
			? `Overwrote ${target} (${bytes} bytes).`
			: `Wrote ${target} (${bytes} bytes).`;
	}),
}