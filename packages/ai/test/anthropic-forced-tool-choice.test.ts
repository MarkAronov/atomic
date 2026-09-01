import { describe, expect, it } from "vitest";
import { type AnthropicOptions, stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel } from "../src/compat.ts";
import type { Context, Model } from "../src/types.ts";

/**
 * Forced tool choice on Claude Fable 5.1.
 *
 * "Forced tool use (`tool_choice: {"type": "any"}` or `{"type": "tool", ...}`) is incompatible
 * with manual extended thinking but works with adaptive thinking. The exceptions are Claude
 * Fable 5.1 and Claude Mythos 5.1, which reject forced tool use on every request with a 400
 * error. On those models, use `tool_choice: {"type": "auto"}` with strict tool use or structured
 * outputs instead." — https://platform.claude.com/docs/en/build-with-claude/thinking
 *
 * The narrow public `ToolChoice` is `"auto" | "none"`, but the exported `stream()` takes
 * `AnthropicOptions` directly, whose `toolChoice` admits both forced shapes. So this is reachable
 * at the shipped-library boundary, and sending it unchanged would be a guaranteed 400 on a model
 * this package now supports. The downgrade keeps the request answerable, and the capability is
 * inspectable as `compat.supportsForcedToolChoice` so a caller can branch before requesting.
 */

interface ToolChoicePayload {
	tool_choice?: { type: string; name?: string };
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function makeContext(): Context {
	return { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] };
}

async function capturePayload(
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

describe("forced tool choice on Claude Fable 5.1", () => {
	it("marks the model as rejecting forced tool choice", () => {
		expect(getModel("anthropic", "claude-fable-5-1").compat?.supportsForcedToolChoice).toBe(false);
	});

	it("downgrades tool_choice any to auto", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-fable-5-1"), "any");

		expect(payload.tool_choice).toEqual({ type: "auto" });
	});

	it("downgrades a named forced tool to auto", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-fable-5-1"), {
			type: "tool",
			name: "double_number",
		});

		expect(payload.tool_choice).toEqual({ type: "auto" });
	});

	it.each(["auto", "none"] as const)("passes %s through unchanged", async (toolChoice) => {
		const payload = await capturePayload(getModel("anthropic", "claude-fable-5-1"), toolChoice);

		expect(payload.tool_choice).toEqual({ type: toolChoice });
	});

	it("omits tool_choice entirely when none is requested", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-fable-5-1"), undefined);

		expect(payload.tool_choice).toBeUndefined();
	});
});

describe("forced tool choice on models that accept it", () => {
	// The downgrade is scoped by generated capability metadata, not applied to Claude broadly.
	// Every other model must keep forcing a tool when the caller asks for it.
	it.each(["claude-fable-5", "claude-opus-5", "claude-sonnet-4-5"] as const)(
		"passes forced tool choice through unchanged for %s",
		async (modelId) => {
			const model = getModel("anthropic", modelId);
			expect(model.compat?.supportsForcedToolChoice).toBeUndefined();

			expect(await capturePayload(model, "any")).toMatchObject({ tool_choice: { type: "any" } });
			expect(await capturePayload(model, { type: "tool", name: "double_number" })).toMatchObject({
				tool_choice: { type: "tool", name: "double_number" },
			});
		},
	);
});
