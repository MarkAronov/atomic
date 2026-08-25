import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { VerbatimCompactionResult } from "../../src/core/compaction/index.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession compact API typing", () => {
	it("returns the verbatim result shape", () => {
		type Result = Awaited<ReturnType<AgentSession["compact"]>>;
		const accept = (result: Result): VerbatimCompactionResult => result;
		expect(typeof accept).toBe("function");
	});
});

describe("session_compact_failed", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		vi.restoreAllMocks();
		harness?.cleanup();
	});

	it("notifies extensions when automatic Verbatim Compaction fails", async () => {
		const failedEvents: Array<{
			type: "session_compact_failed";
			reason: "manual" | "threshold" | "overflow";
			errorMessage?: string;
			aborted: boolean;
			willRetry: boolean;
			fromExtension: boolean;
		}> = [];
		harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_compact_failed", (event) => {
						failedEvents.push(event);
					});
				},
			],
		});
		const internals = harness.session as unknown as {
			_applyVerbatimCompaction(): Promise<VerbatimCompactionResult | undefined>;
			_runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<string>;
		};
		vi.spyOn(internals, "_applyVerbatimCompaction").mockRejectedValue(new Error("planner failed"));

		await expect(internals._runAutoCompaction("threshold", false)).resolves.toBe("failed");

		expect(failedEvents).toEqual([
			{
				type: "session_compact_failed",
				reason: "threshold",
				errorMessage: "Auto-compaction failed: planner failed",
				aborted: false,
				willRetry: false,
				fromExtension: false,
			},
		]);
	});
});
