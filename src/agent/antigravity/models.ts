import type { Api, Model } from "@earendil-works/pi-ai";
import { ANTIGRAVITY_API, ANTIGRAVITY_PROVIDER } from "./constants.ts";

const SHARED_MODEL_FIELDS = {
	api: ANTIGRAVITY_API,
	provider: ANTIGRAVITY_PROVIDER,
	baseUrl: "",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	reasoning: true,
	thinkingLevelMap: { off: "low", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max", max: "max" },
	contextWindow: 1_000_000,
	maxTokens: 64_000,
} satisfies Omit<Model<Api>, "id" | "name">;

export const ANTIGRAVITY_MODELS: readonly Model<Api>[] = [
	{
		...SHARED_MODEL_FIELDS,
		id: "gemini-3.8-flash-high",
		name: "Gemini 3.8 Flash (High)",
	},
	{
		...SHARED_MODEL_FIELDS,
		id: "gemini-3.8-flash-medium",
		name: "Gemini 3.8 Flash (Medium)",
	},
	{
		...SHARED_MODEL_FIELDS,
		id: "gemini-3.8-flash-low",
		name: "Gemini 3.8 Flash (Low)",
		thinkingLevelMap: { off: "low", minimal: "low", low: "low", medium: "low", high: "low", xhigh: "low", max: "low" },
	},
	{
		...SHARED_MODEL_FIELDS,
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6 (Thinking)",
		contextWindow: 200_000,
	},
	{
		...SHARED_MODEL_FIELDS,
		id: "claude-opus-4-6-thinking",
		name: "Claude Opus 4.6 (Thinking)",
		contextWindow: 200_000,
	},
	{
		...SHARED_MODEL_FIELDS,
		id: "gpt-oss-120b-medium",
		name: "GPT-OSS 120B (Medium)",
		contextWindow: 128_000,
		maxTokens: 32_000,
	},
];
