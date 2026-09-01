import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { transformMessages } from "../src/api/transform-messages.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Context, FallbackContent, Message } from "../src/types.ts";

/**
 * Mid-stream server-side fallback.
 *
 * When a classifier declines partway through a response, Anthropic retries on a fallback model
 * within the same stream and marks the handoff: "The open content block closes, and the
 * `fallback` block (an ordinary `content_block_start` and `content_block_stop` pair with no
 * deltas) marks the boundary… `message_start` already named the requested model, so read the
 * serving model from the `fallback` block's `to.model`."
 *
 * The marker is not decorative. On the next turn: "Keep it exactly where it appeared. The API uses
 * its position to validate the thinking blocks around it, so a request that echoes thinking blocks
 * from both sides of the boundary is rejected if the block is omitted or moved." Thinking,
 * redacted thinking, and client-side tool calls *before* the final marker must be dropped; text
 * and everything after it is kept.
 * https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback
 *
 * This matters on this branch specifically because Claude Fable 5.1 is generated with
 * `allowedFallbackModels`, so Atomic sends `fallbacks` and can receive these boundaries — and
 * because the branch also enabled cross-model thinking replay, which is exactly what the rejection
 * rule above governs.
 */

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function createFakeAnthropicClient(response: Response): Anthropic {
	return {
		messages: { create: () => ({ asResponse: async () => response }) },
	} as unknown as Anthropic;
}

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

/** A stream that starts on Fable 5.1, declines mid-output, and finishes on Opus 4.8. */
function midOutputFallbackEvents(): Array<{ event: string; data: string }> {
	return [
		{
			event: "message_start",
			data: JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_test",
					model: "claude-fable-5-1",
					usage: { input_tokens: 1_000_000, output_tokens: 0 },
				},
			}),
		},
		{
			event: "content_block_start",
			data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		},
		{
			event: "content_block_delta",
			data: JSON.stringify({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "Partial" },
			}),
		},
		{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
		// The boundary: a start/stop pair with no deltas.
		{
			event: "content_block_start",
			data: JSON.stringify({
				type: "content_block_start",
				index: 1,
				content_block: {
					type: "fallback",
					from: { model: "claude-fable-5-1" },
					to: { model: "claude-opus-4-8" },
				},
			}),
		},
		{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 1 }) },
		{
			event: "content_block_start",
			data: JSON.stringify({ type: "content_block_start", index: 2, content_block: { type: "text", text: "" } }),
		},
		{
			event: "content_block_delta",
			data: JSON.stringify({
				type: "content_block_delta",
				index: 2,
				delta: { type: "text_delta", text: " answer" },
			}),
		},
		{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 2 }) },
		{
			event: "message_delta",
			data: JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { input_tokens: 1_000_000, output_tokens: 0 },
			}),
		},
		{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
	];
}

describe("mid-output server-side fallback", () => {
	it("records the boundary marker in place rather than dropping it", async () => {
		const model = getModel("anthropic", "claude-fable-5-1");
		const result = await streamAnthropic(model, context, {
			client: createFakeAnthropicClient(createSseResponse(midOutputFallbackEvents())),
		}).result();

		expect(result.stopReason).toBe("stop");
		// The marker sits between the declining model's text and the serving model's text, which is
		// the position the API validates thinking blocks against.
		expect(result.content.map((block) => block.type)).toEqual(["text", "fallback", "text"]);
		expect(result.content[1]).toEqual({
			type: "fallback",
			fromModel: "claude-fable-5-1",
			toModel: "claude-opus-4-8",
		});
	});

	it("re-attributes the response to the serving model", async () => {
		const model = getModel("anthropic", "claude-fable-5-1");
		const result = await streamAnthropic(model, context, {
			client: createFakeAnthropicClient(createSseResponse(midOutputFallbackEvents())),
		}).result();

		// `message_start` named the requested model; only the fallback block names the serving one.
		expect(result.model).toBe("claude-opus-4-8");
	});

	it("prices the returned message at the serving model's rates", async () => {
		const model = getModel("anthropic", "claude-fable-5-1");
		const opus = model.compat?.allowedFallbackModels?.find((f) => f.model === "claude-opus-4-8");
		expect(opus, "expected Opus 4.8 among the generated fallback targets").toBeDefined();
		// The two models are priced differently, which is what makes this assertion meaningful.
		expect(opus?.cost.input).not.toBe(model.cost.input);

		const result = await streamAnthropic(model, context, {
			client: createFakeAnthropicClient(createSseResponse(midOutputFallbackEvents())),
		}).result();

		// 1M input tokens at Opus 4.8's rate, not Claude Fable 5.1's.
		expect(result.usage.cost.input).toBeCloseTo(opus!.cost.input, 10);
		expect(result.usage.cost.input).not.toBeCloseTo(model.cost.input, 10);
	});

	// Two paths that already worked and must keep working: `message_start` names the serving model
	// when the decline happens before any output, and on a sticky-routed later turn there is no
	// fallback block at all.
	it("leaves a turn with no fallback block attributed to the model that message_start named", async () => {
		const model = getModel("anthropic", "claude-fable-5-1");
		const events = midOutputFallbackEvents().filter((e) => !e.data.includes('"type":"fallback"'));
		const result = await streamAnthropic(model, context, {
			client: createFakeAnthropicClient(createSseResponse(events)),
		}).result();

		expect(result.model).toBe("claude-fable-5-1");
		expect(result.usage.cost.input).toBeCloseTo(model.cost.input, 10);
	});
});

function fallbackBlock(): FallbackContent {
	return { type: "fallback", fromModel: "claude-fable-5-1", toModel: "claude-opus-4-8" };
}

/** An assistant turn straddling a fallback boundary, with reasoning and a tool call on each side. */
function straddlingTurn(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "declining model reasoning", thinkingSignature: "sig-before" },
			{ type: "text", text: "Partial" },
			{ type: "toolCall", id: "toolu_before", name: "double_number", arguments: { value: 1 } },
			fallbackBlock(),
			{ type: "thinking", thinking: "serving model reasoning", thinkingSignature: "sig-after" },
			{ type: "text", text: " answer" },
			{ type: "toolCall", id: "toolu_after", name: "double_number", arguments: { value: 2 } },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-4-8",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function replay(): Message[] {
	return transformMessages(
		[
			{ role: "user", content: "Double 1 and 2.", timestamp: Date.now() },
			straddlingTurn(),
			{
				role: "toolResult",
				toolCallId: "toolu_after",
				toolName: "double_number",
				content: [{ type: "text", text: "4" }],
				isError: false,
				timestamp: Date.now(),
			},
		],
		getModel("anthropic", "claude-fable-5-1"),
	);
}

describe("replaying a turn that straddles a fallback boundary", () => {
	it("keeps the marker and drops only the pre-boundary reasoning and tool call", () => {
		const assistant = replay().find((msg): msg is AssistantMessage => msg.role === "assistant");
		expect(assistant).toBeDefined();

		// Echoing thinking from both sides of the marker is rejected by the API, so the earlier
		// model's reasoning and its unexecuted tool call are dropped while the marker stays in
		// place and everything after it survives.
		expect(assistant!.content.map((block) => block.type)).toEqual([
			"text",
			"fallback",
			"thinking",
			"text",
			"toolCall",
		]);
	});

	it("keeps the marker's position relative to the text it separates", () => {
		const content = replay().find((msg): msg is AssistantMessage => msg.role === "assistant")!.content;
		const markerIndex = content.findIndex((block) => block.type === "fallback");

		expect(content[markerIndex - 1]).toMatchObject({ type: "text", text: "Partial" });
		expect(content[markerIndex + 1]).toMatchObject({ type: "thinking" });
		expect(content[markerIndex]).toEqual(fallbackBlock());
	});

	it("keeps the post-boundary reasoning that the serving model produced", () => {
		const content = replay().find((msg): msg is AssistantMessage => msg.role === "assistant")!.content;
		const thinking = content.filter((block) => block.type === "thinking");

		expect(thinking).toHaveLength(1);
		expect(thinking[0]).toMatchObject({ thinkingSignature: "sig-after" });
	});

	it("keeps both sides' visible text", () => {
		const content = replay().find((msg): msg is AssistantMessage => msg.role === "assistant")!.content;

		expect(content.filter((block) => block.type === "text").map((block) => block.text)).toEqual([
			"Partial",
			" answer",
		]);
	});

	// A turn with no boundary must be untouched by any of this.
	it("changes nothing for a turn without a fallback block", () => {
		const turn = straddlingTurn();
		turn.content = turn.content.filter((block) => block.type !== "fallback");
		turn.model = "claude-fable-5-1";

		const result = transformMessages([turn], getModel("anthropic", "claude-fable-5-1"));
		const assistant = result.find((msg): msg is AssistantMessage => msg.role === "assistant");

		expect(assistant!.content.map((block) => block.type)).toEqual([
			"thinking",
			"text",
			"toolCall",
			"thinking",
			"text",
			"toolCall",
		]);
	});
});
