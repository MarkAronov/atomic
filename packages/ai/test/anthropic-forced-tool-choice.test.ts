import { describe, expect, it } from "vitest";
import { type AnthropicOptions, stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { type BedrockOptions, stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { getModel } from "../src/compat.ts";
import type { Context, Model, Tool } from "../src/types.ts";

/**
 * Forced tool choice on Claude Fable 5.1.
 *
 * "Forced tool use (`tool_choice: {"type": "any"}` or `{"type": "tool", ...}`) is incompatible
 * with manual extended thinking but works with adaptive thinking. The exceptions are Claude
 * Fable 5.1 and Claude Mythos 5.1, which reject forced tool use on every request with a 400
 * error. On those models, use `tool_choice: {"type": "auto"}` with strict tool use or structured
 * outputs instead." — https://platform.claude.com/docs/en/build-with-claude/thinking
 *
 * Two properties are pinned here.
 *
 * 1. **The request is rejected, not rewritten.** An earlier revision silently substituted `auto`.
 *    That discarded an explicit caller instruction and made the declared `toolChoice` shape a
 *    lie: asking the model to call a named tool and asking it to decide for itself are different
 *    requests. The library now fails before the round trip, naming the model and the remedy.
 * 2. **The restriction is a model property, not a first-party API property.** Every mirror routes
 *    to the same upstream model and receives the same 400, so the guard is keyed on the API that
 *    can express a forced choice rather than on `provider === "anthropic"`. That is the opposite
 *    of the preserved-thinking flags, which really are Anthropic-endpoint properties.
 */

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

const FORCED_TOOL_CHOICE_ERROR = /does not support forced tool choice/;

const testTool: Tool = {
	name: "double_number",
	description: "Doubles a number",
	parameters: { type: "object", properties: { value: { type: "number" } } },
};

function makeContext(): Context {
	return { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }], tools: [testTool] };
}

interface ToolChoicePayload {
	tool_choice?: { type: string; name?: string };
}

async function captureAnthropicPayload(
	model: Model<"anthropic-messages">,
	toolChoice: AnthropicOptions["toolChoice"],
): Promise<ToolChoicePayload> {
	let capturedPayload: ToolChoicePayload | undefined;

	const s = streamAnthropic({ ...model, baseUrl: "http://127.0.0.1:9" }, makeContext(), {
		apiKey: "fake-key",
		toolChoice,
		onPayload: (payload) => {
			capturedPayload = payload as ToolChoicePayload;
			throw new PayloadCaptured();
		},
	});

	await s.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}
	return capturedPayload;
}

/** Anthropic `stream()` surfaces a build-time throw as an error result rather than rejecting. */
async function anthropicErrorMessage(
	model: Model<"anthropic-messages">,
	toolChoice: AnthropicOptions["toolChoice"],
): Promise<string> {
	const s = streamAnthropic({ ...model, baseUrl: "http://127.0.0.1:9" }, makeContext(), {
		apiKey: "fake-key",
		toolChoice,
	});
	const result = await s.result();
	return result.errorMessage ?? "";
}

interface BedrockToolConfigPayload {
	toolConfig?: { toolChoice?: Record<string, unknown> };
}

async function captureBedrockPayload(
	model: Model<"bedrock-converse-stream">,
	toolChoice: BedrockOptions["toolChoice"],
): Promise<BedrockToolConfigPayload> {
	let capturedPayload: BedrockToolConfigPayload | undefined;
	const s = streamBedrock(model, makeContext(), {
		toolChoice,
		onPayload: (payload) => {
			capturedPayload = payload as BedrockToolConfigPayload;
			throw new PayloadCaptured();
		},
	});

	for await (const event of s) {
		if (event.type === "error") break;
	}

	if (!capturedPayload) {
		throw new Error("Expected Bedrock payload to be captured before request abort");
	}
	return capturedPayload;
}

async function bedrockErrorMessage(
	model: Model<"bedrock-converse-stream">,
	toolChoice: BedrockOptions["toolChoice"],
): Promise<string> {
	const s = streamBedrock(model, makeContext(), { toolChoice });
	for await (const event of s) {
		if (event.type === "error") break;
	}
	const result = await s.result();
	return result.errorMessage ?? "";
}

/** The `anthropic-messages` mirrors of Claude Fable 5.1, read per provider so `getModel` narrows. */
function anthropicMessagesFable51Mirrors(): Array<{ label: string; model: Model<"anthropic-messages"> }> {
	return [
		{ label: "anthropic/claude-fable-5-1", model: getModel("anthropic", "claude-fable-5-1") },
		{ label: "opencode/claude-fable-5-1", model: getModel("opencode", "claude-fable-5-1") },
		{
			label: "vercel-ai-gateway/anthropic/claude-fable-5.1",
			model: getModel("vercel-ai-gateway", "anthropic/claude-fable-5.1"),
		},
	];
}

describe("forced tool choice is rejected on Claude Fable 5.1", () => {
	// Every mirror that can express a forced choice must carry the flag: the model returns the
	// same 400 whichever platform serves it.
	it("marks every anthropic-messages mirror as rejecting forced tool choice", () => {
		for (const { label, model } of anthropicMessagesFable51Mirrors()) {
			expect(model.compat?.supportsForcedToolChoice, label).toBe(false);
		}
	});

	it.each([
		"anthropic.claude-fable-5-1",
		"global.anthropic.claude-fable-5-1",
		"us.anthropic.claude-fable-5-1",
	] as const)("marks Bedrock %s as rejecting forced tool choice", (modelId) => {
		expect(getModel("amazon-bedrock", modelId).compat?.supportsForcedToolChoice).toBe(false);
	});

	it("rejects tool_choice any on every mirror instead of rewriting it", async () => {
		for (const { label, model } of anthropicMessagesFable51Mirrors()) {
			const message = await anthropicErrorMessage(model, "any");

			expect(message, label).toMatch(FORCED_TOOL_CHOICE_ERROR);
			expect(message, label).toContain(model.id);
		}
	});

	it("rejects a named forced tool and names the remedy", async () => {
		const message = await anthropicErrorMessage(getModel("anthropic", "claude-fable-5-1"), {
			type: "tool",
			name: "double_number",
		});

		expect(message).toMatch(FORCED_TOOL_CHOICE_ERROR);
		expect(message).toContain("double_number");
		// The remedy Anthropic documents, so the caller can act without reading the docs first.
		expect(message).toContain("auto");
	});

	it("rejects forced tool choice on the Bedrock profiles too", async () => {
		const message = await bedrockErrorMessage(getModel("amazon-bedrock", "global.anthropic.claude-fable-5-1"), "any");

		expect(message).toMatch(FORCED_TOOL_CHOICE_ERROR);
	});

	it.each(["auto", "none"] as const)("passes %s through unchanged", async (toolChoice) => {
		const payload = await captureAnthropicPayload(getModel("anthropic", "claude-fable-5-1"), toolChoice);

		expect(payload.tool_choice).toEqual({ type: toolChoice });
	});

	it("omits tool_choice entirely when none is requested", async () => {
		const payload = await captureAnthropicPayload(getModel("anthropic", "claude-fable-5-1"), undefined);

		expect(payload.tool_choice).toBeUndefined();
	});
});

describe("forced tool choice on models that accept it", () => {
	// The guard is keyed on generated capability metadata, not applied to Claude broadly. Every
	// other model must still be able to force a tool when the caller asks.
	it.each(["claude-fable-5", "claude-opus-5", "claude-sonnet-4-5"] as const)(
		"passes forced tool choice through unchanged for %s",
		async (modelId) => {
			const model = getModel("anthropic", modelId);
			expect(model.compat?.supportsForcedToolChoice).toBeUndefined();

			expect(await captureAnthropicPayload(model, "any")).toMatchObject({ tool_choice: { type: "any" } });
			expect(await captureAnthropicPayload(model, { type: "tool", name: "double_number" })).toMatchObject({
				tool_choice: { type: "tool", name: "double_number" },
			});
		},
	);

	it("passes forced tool choice through unchanged for Bedrock Claude Fable 5", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-fable-5");
		expect(model.compat?.supportsForcedToolChoice).toBeUndefined();

		const payload = await captureBedrockPayload(model, "any");

		expect(payload.toolConfig?.toolChoice).toEqual({ any: {} });
	});
});

describe("preserved-thinking flags keep their first-party provider scope", () => {
	// Extracting the forced-tool rule out of the preserved-thinking function must not widen the
	// two binding flags, which really are Anthropic-endpoint properties rather than model ones.
	it("does not leak the binding flags to non-Anthropic mirrors", () => {
		for (const { label, model } of anthropicMessagesFable51Mirrors()) {
			if (model.provider === "anthropic") {
				expect(model.compat?.enforcesPreservedThinkingBinding, label).toBe(true);
				expect(model.compat?.delegatesThinkingModelBinding, label).toBe(true);
				continue;
			}
			expect(model.compat?.enforcesPreservedThinkingBinding, label).toBeUndefined();
			expect(model.compat?.delegatesThinkingModelBinding, label).toBeUndefined();
		}
	});
});
