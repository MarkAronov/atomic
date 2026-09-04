import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageFrame,
	AssistantMessageFrameEncoder,
	type Model,
	reduceAssistantMessageFrames,
	type ThinkingContent,
} from "../src/index.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function seed(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: 1,
	};
}

function frame(encoder: AssistantMessageFrameEncoder, event: AssistantMessageEvent): AssistantMessageFrame {
	const converted = encoder.encode(event);
	if (!converted) throw new Error(`Expected ${event.type} event to produce a frame`);
	return converted;
}

function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object") return value;
	for (const key of Reflect.ownKeys(value)) {
		deepFreeze((value as Record<PropertyKey, unknown>)[key]);
	}
	return Object.freeze(value);
}

/**
 * Builds a frame whose `contentIndex` accessor yields a different value on each read. A handler
 * that reads it more than once validates one slot and then acts on another.
 */
function shiftingIndexFrame(base: Record<string, unknown>, values: unknown[]): AssistantMessageFrame {
	let reads = 0;
	const frame = { ...base };
	Object.defineProperty(frame, "contentIndex", {
		enumerable: true,
		get() {
			const value = values[Math.min(reads, values.length - 1)];
			reads += 1;
			return value;
		},
	});
	return frame as unknown as AssistantMessageFrame;
}

describe("assistant message frames", () => {
	it("uses authoritative text end content and signature", () => {
		const partial = seed();
		const encoder = new AssistantMessageFrameEncoder();
		const frames: AssistantMessageFrame[] = [frame(encoder, { type: "start", partial })];
		partial.content.push({ type: "text", text: "Hello " });
		frames.push(frame(encoder, { type: "text_start", contentIndex: 0, partial }));
		partial.content[0] = { type: "text", text: "Hello world", textSignature: "sig-text" };
		frames.push(
			frame(encoder, { type: "text_delta", contentIndex: 0, delta: "incorrect", partial }),
			frame(encoder, { type: "text_end", contentIndex: 0, content: "Hello world", partial }),
		);

		expect(frames.at(-1)).toEqual({
			type: "text_end",
			contentIndex: 0,
			content: "Hello world",
			textSignature: "sig-text",
		});
		expect(reduceAssistantMessageFrames(frames)?.content).toEqual([
			{ type: "text", text: "Hello world", textSignature: "sig-text" },
		]);
	});

	it("preserves provider thinking level from the stream start", () => {
		const partial = seed();
		partial.providerThinkingLevel = "high";
		const encoder = new AssistantMessageFrameEncoder();
		const start = frame(encoder, { type: "start", partial });

		expect(start).toMatchObject({ type: "start", partial: { providerThinkingLevel: "high" } });
		expect(reduceAssistantMessageFrames([start])?.providerThinkingLevel).toBe("high");
	});

	it("preserves initial and final thinking metadata, including redaction", () => {
		const partial = seed();
		const encoder = new AssistantMessageFrameEncoder();
		const frames: AssistantMessageFrame[] = [frame(encoder, { type: "start", partial })];
		partial.content.push({
			type: "thinking",
			thinking: "[redacted]",
			thinkingSignature: "encrypted-start",
			redacted: true,
		});
		frames.push(frame(encoder, { type: "thinking_start", contentIndex: 0, partial }));
		partial.content[0] = {
			type: "thinking",
			thinking: "[redacted]",
			thinkingSignature: "encrypted-final",
			redacted: true,
		};
		frames.push(frame(encoder, { type: "thinking_end", contentIndex: 0, content: "[redacted]", partial }));

		expect(frames.at(-1)).toEqual({
			type: "thinking_end",
			contentIndex: 0,
			content: "[redacted]",
			thinkingSignature: "encrypted-final",
			redacted: true,
		});
		expect(reduceAssistantMessageFrames(frames)?.content[0]).toEqual({
			type: "thinking",
			thinking: "[redacted]",
			thinkingSignature: "encrypted-final",
			redacted: true,
		});
	});

	it("parses unfinished tool JSON once and uses authoritative completed arguments", () => {
		const initialFrames: AssistantMessageFrame[] = [
			{ type: "start", partial: seed() },
			{
				type: "toolcall_start",
				contentIndex: 0,
				toolCall: { type: "toolCall", id: "initial-id", name: "write", arguments: {} },
			},
			{ type: "toolcall_delta", contentIndex: 0, delta: '{"path":"READ' },
		];

		expect(reduceAssistantMessageFrames(initialFrames)?.content[0]).toMatchObject({
			type: "toolCall",
			arguments: { path: "READ" },
		});

		const completeFrames: AssistantMessageFrame[] = [
			...initialFrames,
			{ type: "toolcall_delta", contentIndex: 0, delta: 'ME.md","lines":[1,2]}' },
			{
				type: "toolcall_end",
				contentIndex: 0,
				id: "final-id",
				name: "write_file",
				arguments: { path: "final.md", lines: [3] },
				thoughtSignature: "thought",
				namespace: "files",
			},
		];
		expect(reduceAssistantMessageFrames(completeFrames)?.content[0]).toEqual({
			type: "toolCall",
			id: "final-id",
			name: "write_file",
			arguments: { path: "final.md", lines: [3] },
			thoughtSignature: "thought",
			namespace: "files",
		});
	});

	it("round-trips OpenAI Responses content supplied only by authoritative end events", async () => {
		const output = seed();
		output.api = "openai-responses";
		output.provider = "openai";
		const model: Model<"openai-responses"> = {
			id: output.model,
			name: "Test",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		};
		const events: ResponseStreamEvent[] = [
			{
				type: "response.output_item.added",
				sequence_number: 0,
				output_index: 0,
				item: { type: "message", id: "msg", role: "assistant", status: "in_progress", content: [] },
			} as ResponseStreamEvent,
			{
				type: "response.output_item.done",
				sequence_number: 1,
				output_index: 0,
				item: {
					type: "message",
					id: "msg",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "final text", annotations: [] }],
				},
			} as ResponseStreamEvent,
			{
				type: "response.output_item.added",
				sequence_number: 2,
				output_index: 1,
				item: {
					type: "function_call",
					id: "fc",
					call_id: "call",
					name: "lookup",
					arguments: "",
				},
			} as ResponseStreamEvent,
			{
				type: "response.output_item.done",
				sequence_number: 3,
				output_index: 1,
				item: {
					type: "function_call",
					id: "fc",
					call_id: "call",
					name: "lookup",
					arguments: '{"query":"pi"}',
				},
			} as ResponseStreamEvent,
			{
				type: "response.completed",
				sequence_number: 4,
				response: { id: "response", status: "completed", output: [] },
			} as unknown as ResponseStreamEvent,
		];
		async function* source(): AsyncGenerator<ResponseStreamEvent> {
			for (const event of events) yield event;
		}

		const encoder = new AssistantMessageFrameEncoder();
		const frames: AssistantMessageFrame[] = [frame(encoder, { type: "start", partial: output })];
		const stream = new AssistantMessageEventStream();
		const push = stream.push.bind(stream);
		stream.push = (event) => {
			const converted = encoder.encode(event);
			if (converted) frames.push(converted);
			push(event);
		};
		await processResponsesStream(source(), output, stream, model);

		expect(reduceAssistantMessageFrames(frames)?.content).toEqual(output.content);
	});

	it("reconciles queued text events against one advanced live partial without duplicate content", () => {
		const partial = seed();
		const events: AssistantMessageEvent[] = [{ type: "start", partial }];
		const text = { type: "text" as const, text: "" };
		partial.content.push(text);
		events.push({ type: "text_start", contentIndex: 0, partial });
		for (const delta of ["Hel", "lo", " ", "world"]) {
			text.text += delta;
			events.push({ type: "text_delta", contentIndex: 0, delta, partial });
		}

		const encoder = new AssistantMessageFrameEncoder();
		const frames = events.flatMap((event) => {
			const encoded = encoder.encode(event);
			return encoded === undefined ? [] : [encoded];
		});

		expect(frames.map((item) => item.type)).toEqual(["start", "text_start"]);
		expect(frames[0]).toMatchObject({ type: "start", partial: { content: [], stopReason: "pending" } });
		expect(reduceAssistantMessageFrames(frames)?.content).toEqual([{ type: "text", text: "Hello world" }]);
	});

	it("trims only the covered prefix when a start snapshot lands inside a delta", () => {
		const partial = seed();
		const encoder = new AssistantMessageFrameEncoder();
		const frames: AssistantMessageFrame[] = [frame(encoder, { type: "start", partial })];
		const text = { type: "text" as const, text: "Hel" };
		partial.content.push(text);
		frames.push(frame(encoder, { type: "text_start", contentIndex: 0, partial }));
		expect(encoder.encode({ type: "text_delta", contentIndex: 0, delta: "He", partial })).toBeUndefined();
		const remainder = encoder.encode({ type: "text_delta", contentIndex: 0, delta: "llo", partial });
		if (remainder === undefined) throw new Error("Expected uncovered text delta");
		frames.push(remainder);

		expect(remainder).toEqual({ type: "text_delta", contentIndex: 0, delta: "lo" });
		expect(reduceAssistantMessageFrames(frames)?.content).toEqual([{ type: "text", text: "Hello" }]);
	});

	it("checkpoints queued tool JSON without replaying covered deltas", () => {
		const partial = seed();
		const toolCall = { type: "toolCall" as const, id: "call", name: "write", arguments: {} };
		const events: AssistantMessageEvent[] = [{ type: "start", partial }];
		partial.content.push(toolCall);
		events.push({ type: "toolcall_start", contentIndex: 0, partial });
		toolCall.arguments = { path: "README.md" };
		events.push(
			{ type: "toolcall_delta", contentIndex: 0, delta: '{"path":"READ', partial },
			{ type: "toolcall_delta", contentIndex: 0, delta: 'ME.md"}', partial },
		);

		const encoder = new AssistantMessageFrameEncoder();
		const frames = events.flatMap((event) => {
			const encoded = encoder.encode(event);
			return encoded === undefined ? [] : [encoded];
		});
		expect(frames.map((item) => item.type)).toEqual(["start", "toolcall_start", "toolcall_checkpoint"]);
		expect(frames.at(-1)).toEqual({
			type: "toolcall_checkpoint",
			contentIndex: 0,
			json: '{"path":"README.md"}',
		});
		expect(reduceAssistantMessageFrames(frames)?.content).toEqual([
			{ type: "toolCall", id: "call", name: "write", arguments: { path: "README.md" } },
		]);
	});

	it("resumes legacy grammar tool JSON from initial arguments", () => {
		const partial = seed();
		const encoder = new AssistantMessageFrameEncoder();
		const frames: AssistantMessageFrame[] = [frame(encoder, { type: "start", partial })];
		const toolCall = { type: "toolCall" as const, id: "call", name: "bash", arguments: { input: "a" } };
		partial.content.push(toolCall);
		frames.push(frame(encoder, { type: "toolcall_start", contentIndex: 0, partial }));
		toolCall.arguments = { input: "ab" };
		frames.push(
			frame(encoder, {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: '{"input":"ab',
				partial,
			}),
		);
		toolCall.arguments = { input: "abc" };
		frames.push(
			frame(encoder, {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: 'c"}',
				partial,
			}),
		);

		expect(frames.slice(2)).toEqual([
			{ type: "toolcall_checkpoint", contentIndex: 0, json: '{"input":"ab' },
			{ type: "toolcall_delta", contentIndex: 0, delta: 'c"}' },
		]);
		expect(reduceAssistantMessageFrames(frames)?.content).toEqual([
			{ type: "toolCall", id: "call", name: "bash", arguments: { input: "abc" } },
		]);
	});

	it("streams tool JSON compactly from an empty argument start", () => {
		const partial = seed();
		const encoder = new AssistantMessageFrameEncoder();
		const frames: AssistantMessageFrame[] = [frame(encoder, { type: "start", partial })];
		const toolCall = { type: "toolCall" as const, id: "call", name: "bash", arguments: {} };
		partial.content.push(toolCall);
		frames.push(frame(encoder, { type: "toolcall_start", contentIndex: 0, partial }));
		toolCall.arguments = { command: "ls -la /tmp" };
		frames.push(
			frame(encoder, {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: '{"command":"ls -la /tmp"}',
				partial,
			}),
		);

		expect(frames.at(-1)).toEqual({
			type: "toolcall_delta",
			contentIndex: 0,
			delta: '{"command":"ls -la /tmp"}',
		});
		expect(reduceAssistantMessageFrames(frames)?.content[0]).toMatchObject({
			type: "toolCall",
			arguments: { command: "ls -la /tmp" },
		});
	});

	it("accepts a pre-generation error but rejects success or updates before start", () => {
		const failed = seed();
		failed.stopReason = "error";
		failed.errorMessage = "setup failed";
		expect(
			new AssistantMessageFrameEncoder().encode({ type: "error", reason: "error", error: failed }),
		).toBeUndefined();

		const completed = seed();
		completed.stopReason = "stop";
		expect(() =>
			new AssistantMessageFrameEncoder().encode({ type: "done", reason: "stop", message: completed }),
		).toThrow("done event appears before start");
		expect(() =>
			new AssistantMessageFrameEncoder().encode({
				type: "text_delta",
				contentIndex: 0,
				delta: "x",
				partial: seed(),
			}),
		).toThrow("text_delta event appears before start");
	});

	it("treats end signature metadata, including absence, as authoritative", () => {
		const frames: AssistantMessageFrame[] = [
			{ type: "start", partial: seed() },
			{
				type: "text_start",
				contentIndex: 0,
				content: { type: "text", text: "", textSignature: "stale-text" },
			},
			{ type: "text_end", contentIndex: 0, content: "" },
			{
				type: "thinking_start",
				contentIndex: 1,
				content: {
					type: "thinking",
					thinking: "",
					thinkingSignature: "stale-thinking",
					redacted: true,
				},
			},
			{ type: "thinking_end", contentIndex: 1, content: "", thinkingSignature: "", redacted: false },
			{
				type: "toolcall_start",
				contentIndex: 2,
				toolCall: {
					type: "toolCall",
					id: "call",
					name: "read",
					arguments: {},
					thoughtSignature: "stale-tool",
					namespace: "stale-namespace",
				},
			},
			{ type: "toolcall_end", contentIndex: 2, id: "call", name: "read", arguments: {} },
		];

		expect(reduceAssistantMessageFrames(frames)?.content).toEqual([
			{ type: "text", text: "" },
			{ type: "thinking", thinking: "", thinkingSignature: "", redacted: false },
			{ type: "toolCall", id: "call", name: "read", arguments: {} },
		]);
	});

	it("stores authoritative final arguments in toolcall_end frames", () => {
		const partial = seed();
		const toolCall = {
			type: "toolCall" as const,
			id: "call-1",
			name: "read",
			arguments: { path: "README.md" },
			thoughtSignature: "thought",
			namespace: "files",
		};
		partial.content.push(toolCall);

		const encoder = new AssistantMessageFrameEncoder();
		frame(encoder, { type: "start", partial });
		frame(encoder, { type: "toolcall_start", contentIndex: 0, partial });
		const end = frame(encoder, { type: "toolcall_end", contentIndex: 0, toolCall, partial });
		expect(end).toEqual({
			type: "toolcall_end",
			contentIndex: 0,
			id: "call-1",
			name: "read",
			arguments: { path: "README.md" },
			thoughtSignature: "thought",
			namespace: "files",
		});
	});

	it("whitelists public block fields from provider-shaped partials", () => {
		const partial = seed();
		const text = { type: "text" as const, text: "visible", textSignature: "text-sig", index: 4 };
		const thinking = {
			type: "thinking" as const,
			thinking: "reasoning",
			thinkingSignature: "thinking-sig",
			redacted: false,
			index: 5,
		};
		const toolCall = {
			type: "toolCall" as const,
			id: "call",
			name: "run",
			arguments: { value: 1 },
			thoughtSignature: "tool-sig",
			namespace: "tools",
			partialJson: '{"value":',
			streamIndex: 6,
		};
		partial.content.push(text, thinking, toolCall);
		const partialWithScratch = partial as AssistantMessage & { outputIndex?: number };
		partialWithScratch.outputIndex = 3;

		const encoder = new AssistantMessageFrameEncoder();
		const start = frame(encoder, { type: "start", partial });
		const textStart = frame(encoder, { type: "text_start", contentIndex: 0, partial });
		const thinkingStart = frame(encoder, { type: "thinking_start", contentIndex: 1, partial });
		const toolStart = frame(encoder, { type: "toolcall_start", contentIndex: 2, partial });

		expect(start.type === "start" && start.partial.content).toEqual([]);
		expect(start).not.toHaveProperty("partial.outputIndex");
		expect(textStart).not.toHaveProperty("content.index");
		expect(thinkingStart).not.toHaveProperty("content.index");
		expect(toolStart).not.toHaveProperty("toolCall.partialJson");
		expect(toolStart).not.toHaveProperty("toolCall.streamIndex");
	});

	it("supports interleaved streams by contentIndex", () => {
		const frames: AssistantMessageFrame[] = [
			{ type: "start", partial: seed() },
			{ type: "text_start", contentIndex: 0, content: { type: "text", text: "" } },
			{
				type: "toolcall_start",
				contentIndex: 1,
				toolCall: { type: "toolCall", id: "call", name: "lookup", arguments: {} },
			},
			{ type: "thinking_start", contentIndex: 2, content: { type: "thinking", thinking: "" } },
			{ type: "text_delta", contentIndex: 0, delta: "answer" },
			{ type: "toolcall_delta", contentIndex: 1, delta: '{"query":"pi"}' },
			{ type: "thinking_delta", contentIndex: 2, delta: "check" },
			{ type: "toolcall_end", contentIndex: 1, id: "call", name: "lookup", arguments: { query: "pi" } },
			{ type: "text_end", contentIndex: 0, content: "answer" },
			{ type: "thinking_end", contentIndex: 2, content: "check" },
		];

		expect(reduceAssistantMessageFrames(frames)?.content).toEqual([
			{ type: "text", text: "answer" },
			{ type: "toolCall", id: "call", name: "lookup", arguments: { query: "pi" } },
			{ type: "thinking", thinking: "check" },
		]);
	});

	it("snapshots mutable event data and keeps reduction pure", () => {
		const partial = seed();
		partial.diagnostics = [{ type: "test", timestamp: 2, details: { value: "original" } }];
		const encoder = new AssistantMessageFrameEncoder();
		const start = frame(encoder, { type: "start", partial });
		partial.diagnostics[0]!.details!.value = "mutated";
		partial.usage.cost.total = 99;

		partial.content.push({
			type: "toolCall",
			id: "call",
			name: "run",
			arguments: { nested: { value: "original" } },
		});
		const toolStart = frame(encoder, { type: "toolcall_start", contentIndex: 0, partial });
		const sourceTool = partial.content[0];
		if (sourceTool?.type !== "toolCall") throw new Error("Expected source tool call");
		(sourceTool.arguments.nested as Record<string, unknown>).value = "mutated";

		const reduced = reduceAssistantMessageFrames([start, toolStart]);
		expect(reduced?.diagnostics?.[0]?.details?.value).toBe("original");
		expect(reduced?.usage.cost.total).toBe(0);
		expect(reduced?.content[0]).toMatchObject({ arguments: { nested: { value: "original" } } });

		if (reduced?.content[0]?.type !== "toolCall") throw new Error("Expected reduced tool call");
		reduced.content[0].arguments.nested = "changed-output";
		expect(toolStart.type === "toolcall_start" && toolStart.toolCall.arguments.nested).toEqual({
			value: "original",
		});
	});

	it("omits terminal events because settlement is separate", () => {
		const message = seed();
		const completed = new AssistantMessageFrameEncoder();
		completed.encode({ type: "start", partial: message });
		message.stopReason = "stop";
		expect(completed.encode({ type: "done", reason: "stop", message })).toBeUndefined();
		message.stopReason = "error";
		message.errorMessage = "failed";
		expect(
			new AssistantMessageFrameEncoder().encode({ type: "error", reason: "error", error: message }),
		).toBeUndefined();
	});

	it("returns undefined when there is no start frame", () => {
		expect(reduceAssistantMessageFrames([])).toBeUndefined();
		expect(reduceAssistantMessageFrames([{ type: "text_delta", contentIndex: 0, delta: "x" }])).toBeUndefined();
	});

	it("rejects frames before start, wrong block kinds, duplicate ends, and index gaps", () => {
		expect(() =>
			reduceAssistantMessageFrames([
				{ type: "text_delta", contentIndex: 0, delta: "x" },
				{ type: "start", partial: seed() },
			]),
		).toThrow("before the start frame");
		expect(() =>
			reduceAssistantMessageFrames([
				{ type: "start", partial: seed() },
				{
					type: "toolcall_start",
					contentIndex: 0,
					toolCall: { type: "toolCall", id: "call", name: "run", arguments: {} },
				},
				{ type: "text_delta", contentIndex: 0, delta: "wrong" },
			]),
		).toThrow("expected text block");
		expect(() =>
			reduceAssistantMessageFrames([
				{ type: "start", partial: seed() },
				{ type: "text_start", contentIndex: 0, content: { type: "text", text: "" } },
				{ type: "text_end", contentIndex: 0, content: "" },
				{ type: "text_end", contentIndex: 0, content: "" },
			]),
		).toThrow("follows the end");
		expect(() =>
			reduceAssistantMessageFrames([
				{ type: "start", partial: seed() },
				{ type: "text_start", contentIndex: 1, content: { type: "text", text: "" } },
			]),
		).toThrow("would leave a gap");
	});

	it("rejects conversion events whose contentIndex points to the wrong block kind", () => {
		const partial = seed();
		const encoder = new AssistantMessageFrameEncoder();
		encoder.encode({ type: "start", partial });
		partial.content.push({ type: "thinking", thinking: "" });
		expect(() => encoder.encode({ type: "text_start", contentIndex: 0, partial })).toThrow(
			"text_start event points to thinking block",
		);
	});

	it("drops stale optional fields as own properties when end frames omit them", () => {
		const reduced = reduceAssistantMessageFrames([
			{ type: "start", partial: seed() },
			{
				type: "text_start",
				contentIndex: 0,
				content: { type: "text", text: "", textSignature: "stale-text" },
			},
			{ type: "text_end", contentIndex: 0, content: "done" },
			{
				type: "thinking_start",
				contentIndex: 1,
				content: { type: "thinking", thinking: "", thinkingSignature: "stale-thinking", redacted: true },
			},
			{ type: "thinking_end", contentIndex: 1, content: "thought" },
			{
				type: "toolcall_start",
				contentIndex: 2,
				toolCall: {
					type: "toolCall",
					id: "stale-id",
					name: "stale-name",
					arguments: { stale: true },
					thoughtSignature: "stale-tool",
					namespace: "stale-namespace",
				},
			},
			{ type: "toolcall_end", contentIndex: 2, id: "call", name: "read", arguments: { path: "a" } },
			{ type: "thinking_start", contentIndex: 3, content: { type: "thinking", thinking: "" } },
			{ type: "thinking_end", contentIndex: 3, content: "kept", thinkingSignature: "", redacted: false },
		]);

		// `toEqual` treats an own property explicitly set to `undefined` as absent, so absence is
		// pinned structurally with `toStrictEqual` and directly with `Object.hasOwn`.
		expect(reduced?.content).toStrictEqual([
			{ type: "text", text: "done" },
			{ type: "thinking", thinking: "thought" },
			{ type: "toolCall", id: "call", name: "read", arguments: { path: "a" } },
			{ type: "thinking", thinking: "kept", thinkingSignature: "", redacted: false },
		]);
		const [text, thinking, toolCall, falsyThinking] = reduced?.content ?? [];
		expect(Object.hasOwn(text, "textSignature")).toBe(false);
		expect(Object.hasOwn(thinking, "thinkingSignature")).toBe(false);
		expect(Object.hasOwn(thinking, "redacted")).toBe(false);
		expect(Object.hasOwn(toolCall, "thoughtSignature")).toBe(false);
		expect(Object.hasOwn(toolCall, "namespace")).toBe(false);
		// Falsy-but-present end-frame metadata still survives.
		expect(Object.hasOwn(falsyThinking, "thinkingSignature")).toBe(true);
		expect(Object.hasOwn(falsyThinking, "redacted")).toBe(true);
	});

	it("reduces prototype-bearing frames without polluting prototypes or mutating sources", () => {
		const partial = seed();
		// A `__proto__:` key in an object literal sets the prototype; `defineProperty` is what
		// smuggles an own `__proto__` data property through a frame.
		Object.defineProperty(partial, "__proto__", {
			value: { polluted: "yes" },
			enumerable: true,
			writable: true,
			configurable: true,
		});
		const frames: AssistantMessageFrame[] = [
			{ type: "start", partial },
			{
				type: "text_start",
				contentIndex: 0,
				content: { type: "text", text: "", textSignature: "stale-text" },
			},
			{ type: "text_end", contentIndex: 0, content: "hi" },
			{
				type: "toolcall_start",
				contentIndex: 1,
				toolCall: {
					type: "toolCall",
					id: "stale",
					name: "stale",
					arguments: {},
					thoughtSignature: "stale-tool",
					namespace: "stale-namespace",
				},
			},
			{ type: "toolcall_delta", contentIndex: 1, delta: '{"__proto__":{"polluted":"yes"},"a":1}' },
			{
				type: "toolcall_end",
				contentIndex: 1,
				id: "call",
				name: "read",
				arguments: JSON.parse('{"__proto__":{"polluted":"yes"},"constructor":{"polluted":"yes"},"a":1}'),
			},
		];
		const framesBefore = structuredClone(frames);
		deepFreeze(frames);

		const reduced = reduceAssistantMessageFrames(frames);
		if (!reduced) throw new Error("Expected the frame sequence to reduce to a message");

		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(Object.prototype).not.toHaveProperty("polluted");
		expect(Object.getPrototypeOf(reduced)).toBe(Object.prototype);
		// The smuggled key stays own data on the reduced message rather than becoming its prototype.
		expect(Object.hasOwn(reduced, "__proto__")).toBe(true);

		const [text, toolCall] = reduced.content;
		expect(text).toStrictEqual({ type: "text", text: "hi" });
		expect(Object.getPrototypeOf(text)).toBe(Object.prototype);
		if (toolCall.type !== "toolCall") throw new Error("Expected a tool-call block at index 1");
		expect(Object.hasOwn(toolCall, "thoughtSignature")).toBe(false);
		expect(Object.hasOwn(toolCall, "namespace")).toBe(false);
		expect(Object.getPrototypeOf(toolCall)).toBe(Object.prototype);
		expect(Object.getPrototypeOf(toolCall.arguments)).toBe(Object.prototype);
		expect(Object.hasOwn(toolCall.arguments, "__proto__")).toBe(true);
		expect(Object.hasOwn(toolCall.arguments, "constructor")).toBe(true);
		expect(toolCall.arguments.a).toBe(1);
		expect(toolCall.arguments.polluted).toBeUndefined();

		// Deep-frozen sources reduce without a single write escaping into the frames: under ESM
		// strict mode any write would already have thrown. `toEqual` rather than `toStrictEqual`
		// because the latter compares `.constructor` identity, which the own `constructor` key
		// above deliberately subverts on both sides.
		expect(frames).toEqual(framesBefore);
		expect(Reflect.ownKeys(frames[0])).toEqual(Reflect.ownKeys(framesBefore[0]));
	});

	it("rejects a prototype-shaped contentIndex before any content lookup", () => {
		expect(() =>
			reduceAssistantMessageFrames([
				{ type: "start", partial: seed() },
				{ type: "text_delta", contentIndex: "__proto__", delta: "x" } as unknown as AssistantMessageFrame,
			]),
		).toThrow("Invalid assistant message frame contentIndex: __proto__");
	});

	it("preserves unspecified own fields and key order through end frames", () => {
		// Excess-property checking only fires on fresh literals in a typed position, so these
		// blocks are bound to variables first. No cast is involved: carrying a field the block
		// types do not name is valid public reducer input, and reduction must pass it through.
		const text = {
			text: "old",
			type: "text" as const,
			providerExtension: { version: 1 },
			textSignature: "stale",
		};
		const thinking = {
			type: "thinking" as const,
			redacted: true,
			vendorTag: "keep",
			thinking: "old",
			thinkingSignature: "stale",
		};
		const toolCall = {
			type: "toolCall" as const,
			namespace: "stale-ns",
			id: "stale",
			ext: { v: 2 },
			name: "stale",
			arguments: { x: 1 },
			thoughtSignature: "stale",
		};
		const reduced = reduceAssistantMessageFrames([
			{ type: "start", partial: seed() },
			{ type: "text_start", contentIndex: 0, content: text },
			{ type: "text_end", contentIndex: 0, content: "done" },
			{ type: "thinking_start", contentIndex: 1, content: thinking },
			{ type: "thinking_end", contentIndex: 1, content: "thought", thinkingSignature: "fresh" },
			{ type: "toolcall_start", contentIndex: 2, toolCall },
			{ type: "toolcall_end", contentIndex: 2, id: "call", name: "read", arguments: { p: 1 }, namespace: "ns" },
		]);

		// Compared as JSON because that is what pins key order: an end frame supersedes the
		// optionals it controls without reordering or dropping anything else the block carried.
		expect(JSON.stringify(reduced?.content)).toBe(
			JSON.stringify([
				{ text: "done", type: "text", providerExtension: { version: 1 } },
				{ type: "thinking", vendorTag: "keep", thinking: "thought", thinkingSignature: "fresh" },
				{ type: "toolCall", id: "call", ext: { v: 2 }, name: "read", arguments: { p: 1 }, namespace: "ns" },
			]),
		);
		expect(Reflect.ownKeys(reduced?.content[2] ?? {})).toEqual([
			"type",
			"id",
			"ext",
			"name",
			"arguments",
			"namespace",
		]);
	});

	it("carries block own data across an end frame without letting it reach a prototype", () => {
		const text = { type: "text" as const, text: "old" };
		// An own `__proto__` data property on the block itself now flows through the end frame's
		// object spread, which uses CreateDataProperty rather than Set.
		Object.defineProperty(text, "__proto__", {
			value: { polluted: "yes" },
			enumerable: true,
			writable: true,
			configurable: true,
		});
		// A start block whose own prototype carries an attacker key, built without `Object.assign`
		// so the test itself introduces no extend-call sink.
		const inherited: ThinkingContent = Object.create({ polluted: "yes" });
		inherited.type = "thinking";
		inherited.thinking = "old";

		const reduced = reduceAssistantMessageFrames([
			{ type: "start", partial: seed() },
			{ type: "text_start", contentIndex: 0, content: text },
			{ type: "text_end", contentIndex: 0, content: "done" },
			{ type: "thinking_start", contentIndex: 1, content: inherited },
			{ type: "thinking_end", contentIndex: 1, content: "thought" },
		]);
		if (!reduced) throw new Error("Expected the frame sequence to reduce to a message");

		const [endedText, endedThinking] = reduced.content;
		expect(Object.hasOwn(endedText, "__proto__")).toBe(true);
		expect(Object.getPrototypeOf(endedText)).toBe(Object.prototype);
		expect(Object.getPrototypeOf(endedThinking)).toBe(Object.prototype);
		// An inherited key is never promoted to own data anywhere in the pipeline.
		expect(JSON.stringify(endedThinking)).toBe(JSON.stringify({ type: "thinking", thinking: "thought" }));
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(Object.prototype).not.toHaveProperty("polluted");
	});

	it("reads a text end frame's contentIndex once", () => {
		const text = reduceAssistantMessageFrames([
			{ type: "start", partial: seed() },
			{ type: "text_start", contentIndex: 0, content: { type: "text", text: "" } },
			shiftingIndexFrame({ type: "text_end", content: "done" }, [0, "__proto__"]),
		]);
		expect(text?.content).toStrictEqual([{ type: "text", text: "done" }]);
		// A second read of `"__proto__"` would install the rebuilt block as the array's prototype.
		expect(Object.getPrototypeOf(text?.content ?? [])).toBe(Array.prototype);

		// The same defect is reachable with two ordinary indices, so it needs no exotic key: a
		// second read of `1` would end block 0 but overwrite block 1.
		const twoBlocks = reduceAssistantMessageFrames([
			{ type: "start", partial: seed() },
			{ type: "text_start", contentIndex: 0, content: { type: "text", text: "a" } },
			{ type: "text_start", contentIndex: 1, content: { type: "text", text: "b" } },
			shiftingIndexFrame({ type: "text_end", content: "done" }, [0, 1]),
		]);
		expect(twoBlocks?.content).toStrictEqual([
			{ type: "text", text: "done" },
			{ type: "text", text: "b" },
		]);
	});

	it("reads a thinking end frame's contentIndex once", () => {
		const thinking = reduceAssistantMessageFrames([
			{ type: "start", partial: seed() },
			{ type: "thinking_start", contentIndex: 0, content: { type: "thinking", thinking: "" } },
			shiftingIndexFrame({ type: "thinking_end", content: "thought" }, [0, "__proto__"]),
		]);
		expect(thinking?.content).toStrictEqual([{ type: "thinking", thinking: "thought" }]);
		expect(Object.getPrototypeOf(thinking?.content ?? [])).toBe(Array.prototype);
	});

	it("reads a tool-call end frame's contentIndex once", () => {
		const toolCall = reduceAssistantMessageFrames([
			{ type: "start", partial: seed() },
			{
				type: "toolcall_start",
				contentIndex: 0,
				toolCall: { type: "toolCall", id: "a", name: "b", arguments: {} },
			},
			shiftingIndexFrame({ type: "toolcall_end", id: "c", name: "d", arguments: { p: 1 } }, [0, "__proto__"]),
		]);
		expect(toolCall?.content).toStrictEqual([{ type: "toolCall", id: "c", name: "d", arguments: { p: 1 } }]);
		expect(Object.getPrototypeOf(toolCall?.content ?? [])).toBe(Array.prototype);
	});
});
