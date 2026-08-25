import type { AssistantMessageEvent } from "@bastani/pi-ai/compat";
import { expectTypeOf, test } from "vitest";
import type {
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
	SessionCompactFailedEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
} from "../src/index.ts";

test("package root exports message and tool execution lifecycle event types", () => {
	expectTypeOf<MessageStartEvent>().toHaveProperty("type");
	expectTypeOf<MessageUpdateEvent>().toEqualTypeOf<{
		type: "message_update";
		assistantMessageEvent: AssistantMessageEvent;
	}>();
	expectTypeOf<MessageEndEvent>().toHaveProperty("type");
	expectTypeOf<ToolExecutionStartEvent>().toHaveProperty("type");
	expectTypeOf<ToolExecutionUpdateEvent>().toHaveProperty("type");
	expectTypeOf<ToolExecutionEndEvent>().toHaveProperty("type");
});

test("package root exports compaction lifecycle event types", () => {
	expectTypeOf<SessionBeforeCompactEvent>().toHaveProperty("type");
	expectTypeOf<SessionCompactEvent>().toHaveProperty("type");
	expectTypeOf<SessionCompactFailedEvent>().toEqualTypeOf<{
		type: "session_compact_failed";
		reason: "manual" | "threshold" | "overflow";
		errorMessage?: string;
		aborted: boolean;
		willRetry: boolean;
		fromExtension: boolean;
	}>();
});
