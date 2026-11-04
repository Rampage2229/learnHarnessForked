import { spawn } from "node:child_process";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { MAX_OUTPUT_BYTES, resolveSourcePath } from "./fs-shared.ts";

/**
 * The shell tool (shell wave, personal fork): the agent's hands on the
 * learner's machine — bash, for real. The fs tools are read-only by the
 * sources-v1 lock and save_file writes single files; everything that
 * needs the SYSTEM (compile LaTeX to PDF, convert documents, run a
 * script, query a local CLI) was exactly the gap the assistant named
 * when it could only hand back a .tex file. The owner's standing
 * posture (2026-11): this is a personal harness on his own machine —
 * the agent runs what the task needs, including system-touching
 * commands, without hand-holding.
 *
 * Mechanics:
 * - /bin/bash -c, cwd home-anchored (resolveSourcePath), full env.
 * - detached process group: the timeout (and a turn abort) kill the
 *   whole TREE, not just the shell — a runaway pdflatex or a spawned
 *   server doesn't outlive the call.
 * - stdout+stderr interleaved as they arrive, capped at the fs tools'
 *   50KB with a truncation notice.
 * - the per-call abort-guard window rides opts.timeoutMs (the global
 *   30s tool guard would kill legitimate compiles); the hard ceiling
 *   is the tool's own 300s input bound + grace.
 */

/** Default wall-clock kill (seconds) — generous for document toolchains,
 *  short enough that a hung command can't eat the turn. */
const DEFAULT_TIMEOUT_S = 90;
const MAX_TIMEOUT_S = 300;
/** The abort-guard window: input bound + 10s slack for cleanup. */
const GUARD_MS = (MAX_TIMEOUT_S + 10) * 1000;

const shellInput = Type.Object({
	command: Type.String({
		minLength: 1,
		description:
			"The bash command to run. It executes FOR REAL on the learner's machine with the learner's user and environment — side effects are real. Non-interactive only: a command that waits for input hangs until the timeout kills it.",
	}),
	cwd: Type.Optional(
		Type.String({
			description: "Working directory for the command (default: the learner's home directory; ~ works).",
		}),
	),
	timeout_seconds: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: MAX_TIMEOUT_S,
			description: `Kill the whole process tree after this many seconds (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}).`,
		}),
	),
});

export const shellTool: AgentTool<typeof shellInput> = {
	name: "shell",
	label: "shell",
	description:
		"Run a bash command on the learner's machine (real execution, real side effects). " +
		"Use it when the task needs the SYSTEM — compiling LaTeX to PDF, converting files, running scripts, local CLIs. " +
		"Prefer the dedicated tools when they cover the job (read/ls/find/grep for files, save_file for writing one). " +
		"Non-interactive: no prompts, no TUIs. Output is capped; exit code is reported.",
	parameters: shellInput,
	executionMode: "sequential",
	execute: serverExecute(
		"shell",
		shellInput,
		async (input, ctx): Promise<string> => {
			const cwd = resolveSourcePath(input.cwd);
			const timeoutS = input.timeout_seconds ?? DEFAULT_TIMEOUT_S;
			return await new Promise<string>((resolve) => {
				let out = "";
				let killed = false;
				let settled = false;
				const child = spawn("/bin/bash", ["-c", input.command], {
					cwd,
					detached: true,
					stdio: ["ignore", "pipe", "pipe"],
				});
				const killTree = (why: string) => {
					if (settled || !child.pid) return;
					killed = true;
					try {
						process.kill(-child.pid, "SIGKILL");
					} catch {
						/* already gone */
					}
					void why;
				};
				const timer = setTimeout(() => killTree("timeout"), timeoutS * 1000);
				// A turn-level abort (the learner hit stop) takes the command down too.
				ctx.signal?.addEventListener("abort", () => killTree("aborted"), { once: true });
				const digest = (chunk: unknown) => {
					out += String(chunk);
					if (Buffer.byteLength(out, "utf-8") > MAX_OUTPUT_BYTES) killTree("output-cap");
				};
				child.stdout.on("data", digest);
				child.stderr.on("data", digest);
				child.on("error", (err) => {
					clearTimeout(timer);
					settled = true;
					resolve(`Failed to start the command: ${err.message}`);
				});
				child.on("close", (code, signalName) => {
					clearTimeout(timer);
					settled = true;
					let text = out;
					let truncNote = "";
					if (Buffer.byteLength(text, "utf-8") > MAX_OUTPUT_BYTES) {
						const lines = text.split("\n");
						const kept: string[] = [];
						for (const line of lines) {
							if (Buffer.byteLength([...kept, line].join("\n"), "utf-8") > MAX_OUTPUT_BYTES) break;
							kept.push(line);
						}
						text = kept.join("\n");
						truncNote = "\n\n[Output truncated at 50KB — rerun with narrower output (pipes, head, redirect to a file and read it)]";
					}
					if (killed) {
						resolve(
							`Command killed after ${timeoutS}s (${signalName ?? "timeout"}). Partial output:\n${text || "(none)"}${truncNote}`,
						);
						return;
					}
					const status = code === 0 ? "exit 0 (success)" : `exit ${code ?? "?"}${signalName ? ` (signal ${signalName})` : ""}`;
					resolve(`$ ${input.command}\n${status}\n\n${text || "(no output)"}${truncNote}`);
				});
			});
		},
		{ timeoutMs: GUARD_MS },
	),
};
