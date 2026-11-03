import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";

function textFromContent(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("\n");
}

function formatMessage(message: Message): string {
	switch (message.role) {
		case "system":
			return "";
		case "user":
			return `[user]\n${textFromContent(message.content)}`;
		case "assistant": {
			const parts: string[] = [];
			for (const block of message.content) {
				if (block.type === "text") parts.push(block.text);
				else if (block.type === "thinking") parts.push(`[thinking]\n${block.thinking}`);
				else if (block.type === "toolCall") parts.push(`[tool call ${block.name}] ${JSON.stringify(block.arguments)}`);
			}
			return `[assistant]\n${parts.join("\n")}`;
		}
		case "toolResult": {
			const tag = message.isError ? `[tool result ${message.toolName} error]` : `[tool result ${message.toolName}]`;
			return `${tag}\n${textFromContent(message.content)}`;
		}
	}
}

export function toAntigravityPrompt(messages: Message[]): string {
	const systemPrompt = getCurrentSystemPrompt(messages);
	const conversation = messages.filter((m) => m.role !== "system");

	const sections: string[] = [];
	if (systemPrompt && systemPrompt.trim()) {
		sections.push(`[system]\n${systemPrompt.trim()}`);
	}

	// If there's only a single user message and no system prompt, keep it bare
	if (!systemPrompt && conversation.length === 1 && conversation[0]?.role === "user") {
		return textFromContent(conversation[0].content);
	}

	for (const msg of conversation) {
		const formatted = formatMessage(msg);
		if (formatted.trim()) {
			sections.push(formatted);
		}
	}

	return sections.join("\n\n");
}

export function toStreamJsonInput(prompt: string): string {
	return JSON.stringify({
		event: "user",
		message: {
			content: prompt,
		},
	}) + "\n";
}
