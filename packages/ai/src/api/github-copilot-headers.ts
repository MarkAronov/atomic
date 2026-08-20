import type { Message, ProviderHeaders } from "../types.ts";

// Copilot expects X-Initiator to indicate whether the request is user-initiated
// or agent-initiated (e.g. follow-up after assistant/tool messages).
export function inferCopilotInitiator(messages: Message[]): "user" | "agent" {
	const last = messages[messages.length - 1];
	return last && last.role !== "user" ? "agent" : "user";
}

// Copilot requires Copilot-Vision-Request header when sending images
export function hasCopilotVisionInput(messages: Message[]): boolean {
	return messages.some((msg) => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return msg.content.some((c) => c.type === "image");
		}
		if (msg.role === "toolResult" && Array.isArray(msg.content)) {
			return msg.content.some((c) => c.type === "image");
		}
		return false;
	});
}

/**
 * Environment/API-key Copilot credentials are raw GitHub tokens unless they
 * contain the `tid=` segment emitted by the Copilot token exchange.
 *
 * A missing credential is not classified as raw: callers may be supplying
 * authentication through headers, and adding an integration id in that case
 * would change requests that do not have a resolved bearer token.
 */
export function isRawCopilotToken(apiKey: string | undefined): boolean {
	return apiKey !== undefined && apiKey.length > 0 && !apiKey.split(";").some((segment) => segment.startsWith("tid="));
}

/**
 * Keep a custom provider/model integration id ahead of the dynamic default.
 * Built-in Copilot models carry `vscode-chat` as their OAuth static header;
 * raw-token requests replace that built-in value with the developer CLI id.
 * An explicit user value equal to `vscode-chat` is indistinguishable from the
 * catalog default at this layer, so it is replaced for raw-token requests;
 * a per-request header is merged later and always wins.
 */
export function preserveCopilotIntegrationHeader(
	modelHeaders: ProviderHeaders | undefined,
	dynamicHeaders: Record<string, string>,
): Record<string, string> {
	const modelIntegrationHeader = Object.entries(modelHeaders ?? {}).find(
		([name]) => name.toLowerCase() === "copilot-integration-id",
	);
	if (!modelIntegrationHeader || modelIntegrationHeader[1] === "vscode-chat") return dynamicHeaders;

	return Object.fromEntries(
		Object.entries(dynamicHeaders).filter(([name]) => name.toLowerCase() !== "copilot-integration-id"),
	);
}

export function buildCopilotDynamicHeaders(params: {
	messages: Message[];
	hasImages: boolean;
	apiKey?: string;
}): Record<string, string> {
	const headers: Record<string, string> = {
		"X-Initiator": inferCopilotInitiator(params.messages),
		"Openai-Intent": "conversation-edits",
	};

	if (params.hasImages) {
		headers["Copilot-Vision-Request"] = "true";
	}

	if (isRawCopilotToken(params.apiKey)) {
		headers["Copilot-Integration-Id"] = "copilot-developer-cli";
	}

	return headers;
}
