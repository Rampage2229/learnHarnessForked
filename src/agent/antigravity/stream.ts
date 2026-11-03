import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";

import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type StreamFunction,
	type ThinkingLevel,
} from "@earendil-works/pi-ai";

import { externalCliEnv } from "../../core/auth-env.ts";
import { getAntigravityBinary } from "./binary.ts";
import { toAntigravityPrompt, toStreamJsonInput } from "./transcript.ts";

class AntigravityTurn {
	private readonly output: AssistantMessage;
	private textStarted = false;
	private contentIndex = 0;
	finished = false;

	constructor(
		private readonly stream: AssistantMessageEventStream,
		model: Model<Api>,
	) {
		this.output = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};
	}

	start(): void {
		this.stream.push({ type: "start", partial: this.output });
	}

	handleDelta(text: string): void {
		if (this.finished || !text) return;
		if (!this.textStarted) {
			this.textStarted = true;
			this.output.content.push({ type: "text", text: "" });
			this.contentIndex = this.output.content.length - 1;
			this.stream.push({ type: "text_start", contentIndex: this.contentIndex, partial: this.output });
		}
		const block = this.output.content[this.contentIndex];
		if (block && block.type === "text") {
			block.text += text;
			this.stream.push({ type: "text_delta", contentIndex: this.contentIndex, delta: text, partial: this.output });
		}
	}

	updateUsage(usage: { input_tokens?: number; output_tokens?: number; cache_read_tokens?: number }): void {
		if (typeof usage.input_tokens === "number") this.output.usage.input = usage.input_tokens;
		if (typeof usage.output_tokens === "number") this.output.usage.output = usage.output_tokens;
		if (typeof usage.cache_read_tokens === "number") this.output.usage.cacheRead = usage.cache_read_tokens;
		this.output.usage.totalTokens = (this.output.usage.input || 0) + (this.output.usage.output || 0) + (this.output.usage.cacheRead || 0);
	}

	finish(stopReason: StopReason = "stop"): void {
		if (this.finished) return;
		this.finished = true;
		if (this.textStarted) {
			const block = this.output.content[this.contentIndex];
			if (block && block.type === "text") {
				this.stream.push({ type: "text_end", contentIndex: this.contentIndex, content: block.text, partial: this.output });
			}
		}
		this.output.stopReason = stopReason;
		// The stream's done event only carries terminal agent reasons; a stray
		// pending/aborted/error reaching finish() is reported as a plain stop.
		const doneReason = ("stop length toolUse deferred".split(" ") as string[]).includes(stopReason)
			? (stopReason as Extract<StopReason, "stop" | "length" | "toolUse" | "deferred">)
			: "stop";
		this.stream.push({ type: "done", reason: doneReason, message: this.output });
		this.stream.end();
	}

	fail(message: string, reason: "aborted" | "error" = "error"): void {
		if (this.finished) return;
		this.finished = true;
		this.output.stopReason = reason;
		this.output.errorMessage = message;
		this.stream.push({ type: "error", reason, error: this.output });
		this.stream.end();
	}
}

export function createAntigravityStreamFunction({
	findBinary = getAntigravityBinary,
	spawnProcess = spawn,
}: {
	findBinary?: () => string | null;
	spawnProcess?: typeof spawn;
} = {}): StreamFunction<Api, SimpleStreamOptions> {
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const turn = new AntigravityTurn(stream, model);

		const binary = findBinary();
		if (!binary) {
			turn.fail("Google Antigravity CLI (agy) binary not found.", "error");
			return stream;
		}

		if (options?.signal?.aborted) {
			turn.fail("Request was aborted", "aborted");
			return stream;
		}

		const prompt = toAntigravityPrompt(context.messages);
		const inputLine = toStreamJsonInput(prompt);

		const args = [
			"--input-format", "stream-json",
			"--output-format", "stream-json",
			"--model", model.id,
			"--disable-slash-commands",
			"--dangerously-skip-permissions",
		];

		if (options?.reasoning) {
			const effort = model.thinkingLevelMap?.[options.reasoning as ThinkingLevel] ?? "medium";
			if (effort) {
				args.push("--effort", String(effort));
			}
		}

		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawnProcess(binary, args, {
				cwd: tmpdir(),
				env: { ...process.env, ...externalCliEnv() },
				stdio: "pipe",
			});
		} catch (err) {
			turn.fail(err instanceof Error ? err.message : "Failed to spawn agy", "error");
			return stream;
		}

		turn.start();

		const abort = () => {
			turn.fail("Request was aborted", "aborted");
			try {
				child.kill("SIGTERM");
				setTimeout(() => {
					try { child.kill("SIGKILL"); } catch {}
				}, 1000);
			} catch {}
		};

		options?.signal?.addEventListener("abort", abort, { once: true });

		child.stdin.write(inputLine, "utf-8", (err) => {
			if (err) {
				turn.fail(`Failed to write to agy: ${err.message}`, "error");
			}
			child.stdin.end();
		});

		const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf-8");
		});

		rl.on("line", (line: string) => {
			if (!line.trim() || turn.finished) return;
			try {
				const data = JSON.parse(line);
				if (data.event === "step_update" && data.step_update) {
					const update = data.step_update;
					if (update.step_type === "agent_response") {
						if (update.text_delta) {
							turn.handleDelta(update.text_delta);
						}
						if (update.usage) {
							turn.updateUsage(update.usage);
						}
					}
				} else if (data.event === "result" && data.result) {
					const res = data.result;
					if (res.usage) {
						turn.updateUsage(res.usage);
					}
					if (res.status === "ERROR") {
						turn.fail(res.error || "Antigravity execution failed", "error");
					} else {
						turn.finish("stop");
					}
				}
			} catch {
				// Ignore non-json output
			}
		});

		child.on("error", (err: Error) => {
			options?.signal?.removeEventListener("abort", abort);
			turn.fail(`agy process error: ${err.message}`, "error");
		});

		child.on("close", (code: number | null) => {
			options?.signal?.removeEventListener("abort", abort);
			if (!turn.finished) {
				if (code !== 0 && stderr.trim()) {
					turn.fail(`agy exited with code ${code}: ${stderr.trim()}`, "error");
				} else {
					turn.finish("stop");
				}
			}
		});

		return stream;
	};
}

export const streamAntigravity = createAntigravityStreamFunction();
