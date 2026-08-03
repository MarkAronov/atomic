import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionSummaryEntry } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

/**
 * `_maybeGenerateSessionSummary` runs fire-and-forget after `agent_end`. These tests drive real
 * turns through the faux provider and assert on what reaches the session file.
 */

/** Bounded wait for the background summary; the faux provider answers in-process. */
const SUMMARY_DEADLINE_MS = 2_000;
/** Long enough for a summary that was going to happen to have happened. */
const SUMMARY_SETTLE_MS = 250;

function summaryEntries(harness: Harness): SessionSummaryEntry[] {
	return harness.sessionManager.getEntries().filter((e): e is SessionSummaryEntry => e.type === "session_summary");
}

async function waitForSummary(harness: Harness): Promise<SessionSummaryEntry> {
	const deadline = Date.now() + SUMMARY_DEADLINE_MS;
	while (Date.now() < deadline) {
		const found = summaryEntries(harness);
		if (found.length > 0) return found[found.length - 1]!;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("timed out waiting for a session_summary entry");
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, SUMMARY_SETTLE_MS));
}

/** Two turns, so the branch clears the minimum-entry guard. */
async function runTwoTurns(harness: Harness): Promise<void> {
	await harness.session.prompt("add resume summaries");
	await harness.session.prompt("now wire up the picker");
}

describe("session summary generation", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("appends a summary anchored to the last conversation message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "tui" });
		harness.setResponses([
			fauxAssistantMessage("first turn"),
			fauxAssistantMessage("second turn"),
			fauxAssistantMessage("Wiring resume summaries into the session picker"),
		]);

		await runTwoTurns(harness);
		const summary = await waitForSummary(harness);

		expect(summary.summary).toBe("Wiring resume summaries into the session picker");

		// The anchor must be the newest user/assistant message entry, never the leaf.
		const conversation = harness.sessionManager
			.getEntries()
			.filter((e) => e.type === "message" && (e.message.role === "user" || e.message.role === "assistant"));
		expect(summary.summarizedThroughId).toBe(conversation[conversation.length - 1]?.id);
	});

	it("does not regenerate while the conversation has not moved on", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "tui" });
		harness.setResponses([
			fauxAssistantMessage("first turn"),
			fauxAssistantMessage("second turn"),
			fauxAssistantMessage("a summary"),
		]);

		await runTwoTurns(harness);
		await waitForSummary(harness);
		expect(harness.getPendingResponseCount()).toBe(0);

		// A second idle with no new messages must not spend another request.
		await harness.session._maybeGenerateSessionSummary();
		await settle();

		expect(summaryEntries(harness)).toHaveLength(1);
	});

	it("generates nothing when the setting is disabled", async () => {
		const harness = await createHarness({ settings: { sessionSummary: { enabled: false } } });
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "tui" });
		harness.setResponses([fauxAssistantMessage("first turn"), fauxAssistantMessage("second turn")]);

		await runTwoTurns(harness);
		await settle();

		expect(summaryEntries(harness)).toHaveLength(0);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("generates nothing in non-interactive modes", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		// No bindExtensions call: the session stays in its default "print" mode.
		harness.setResponses([fauxAssistantMessage("first turn"), fauxAssistantMessage("second turn")]);

		await runTwoTurns(harness);
		await settle();

		expect(summaryEntries(harness)).toHaveLength(0);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("does not persist a summary once the conversation has outrun it", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "tui" });
		harness.setResponses([
			fauxAssistantMessage("first turn"),
			fauxAssistantMessage("second turn"),
			fauxAssistantMessage("third turn"),
		]);

		await runTwoTurns(harness);
		// Start a summary, then land another turn before it can be persisted.
		const pending = harness.session._maybeGenerateSessionSummary();
		await harness.session.prompt("and one more thing");
		await pending;
		await settle();

		for (const entry of summaryEntries(harness)) {
			const conversation = harness.sessionManager
				.getEntries()
				.filter((e) => e.type === "message" && (e.message.role === "user" || e.message.role === "assistant"));
			expect(entry.summarizedThroughId).toBe(conversation[conversation.length - 1]?.id);
		}
	});
});
