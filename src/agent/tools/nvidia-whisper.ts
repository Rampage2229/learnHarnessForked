/**
 * NVIDIA NIM Whisper Transcription Tool (personal fork)
 * Uses NVIDIA's NIM Whisper Large V3 API for speech-to-text transcription
 * API Reference: https://build.nvidia.com/openai/whisper-large-v3/api
 */

import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { invalidInputResult, serverExecute } from "./tool-execute.ts";

/** NVIDIA NIM Whisper API endpoint */
const NIM_WHISPER_ENDPOINT = "https://integrate.api.nvidia.com/v1";

/** Audio transcription input schema */
export const nimWhisperInputSchema = Type.Object({
	/** Base64 encoded audio data */
	audio_base64: Type.String({
		description: "Base64 encoded audio file data (WAV, MP3, FLAC, etc.)",
	}),
	/** Language code (optional, auto-detect if not provided) */
	language: Type.Optional(Type.String({
		description: "Language code (e.g., 'en', 'es', 'fr', 'zh'). Auto-detect if not provided.",
	})),
	/** Output format */
	response_format: Type.Optional(Type.Union([
		Type.Literal("json"),
		Type.Literal("text"),
		Type.Literal("srt"),
		Type.Literal("verbose_json"),
		Type.Literal("vtt"),
	], {
		description: "Output format (default: json)",
	})),
	/** Temperature for sampling (optional) */
	temperature: Type.Optional(Type.Number({
		minimum: 0,
		maximum: 1,
		description: "Temperature for sampling (0 = deterministic)",
	})),
	/** Whether to translate to English instead of transcribing */
translate: Type.Optional(Type.Boolean({
    description: "If true, translate audio to English instead of transcribing",
})),
};

export interface NimWhisperResult {
	text: string;
	language?: string;
	duration?: number;
	segments?: Array<{
		id: number;
		start: number;
		end: number;
		text: string;
	}>;
}

/** NVIDIA NIM Whisper transcription tool */
export const nimWhisperTranscribeTool: AgentTool<typeof nimWhisperInputSchema> = {
	name: "nim_whisper_transcribe",
	label: "NVIDIA Whisper Transcribe",
	description:
		"Transcribe audio using NVIDIA's NIM Whisper Large V3 model. " +
		"Supports multiple audio formats and languages. " +
		"Set translate=true to translate to English instead of transcribing.",
	parameters: nimWhisperInputSchema,
	executionMode: "sequential",
	execute: async (_toolCallId, input) => {
		// Get NVIDIA API key from environment
		const apiKey = process.env.NVIDIA_API_KEY;
		if (!apiKey) {
			return invalidInputResult("nim_whisper_transcribe", [
				"NVIDIA_API_KEY environment variable not set. Please configure in Settings → Providers → NVIDIA.",
			]);
		}

		try {
			const formData = new FormData();
			
			// Convert base64 audio to blob
			const audioBuffer = Buffer.from(input.audio_base64, "base64");
			const audioBlob = new Blob([audioBuffer], { type: "audio/wav" });
			formData.append("file", audioBlob, "audio.wav");
			
			// Add optional parameters
			if (input.language) {
				formData.append("language", input.language);
			}
			if (input.response_format) {
				formData.append("response_format", input.response_format);
			}
			if (input.temperature !== undefined) {
				formData.append("temperature", input.temperature.toString());
			}
			if (input.translate) {
				formData.append("translate", "true");
			}

			const response = await fetch(`${NIM_WHISPER_ENDPOINT}/audio/transcriptions`, {
				method: "POST",
				headers: {
					"Authorization": `Bearer ${process.env.NVIDIA_API_KEY}`,
				},
				body: formData,
				signal: AbortSignal.timeout(120000), // 2 minute timeout for large files
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`NVIDIA NIM Whisper API error: ${response.status} ${response.statusText} - ${errorText}`);
			}

			const result = await response.json() as NimWhisperResult;
			
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							text: result.text,
							language: result.language,
							duration: result.duration,
							segments: result.segments,
						}, null, 2),
					},
				],
				isError: false,
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			return invalidInputResult("nim_whisper_transcribe", [
				`NVIDIA Whisper transcription failed: ${errorMessage}`,
			]);
		}
	},
};

export { nimWhisperTranscribeTool as nimWhisperTool };