import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, test } from "vitest";
import { createHarness, type Harness } from "../../packages/coding-agent/test/suite/harness.js";
import { workflowHeartbeatConsumedContent } from "../../packages/workflows/src/extension/workflow-heartbeat-scheduler.js";

/**
 * Host-level regression for the heartbeat pickup signal (issue #1975).
 *
 * The scheduler holds a run's single pending slot until the parent chat has
 * actually taken the card. `sendMessage` resolves on *admission* into the
 * parent's queue, so the release has to come from a later host signal — and the
 * signal has to be one that does not fire while the card is still parked.
 *
 * These tests exercise the real `AgentSession` rather than a fake, because the
 * distinction only exists in the host: `agent_settled` is emitted from the
 * `finally` of the prompt cycle whether or not the queue was drained, while
 * `message_end` is emitted by agent-core at the moment a message is injected
 * into the conversation.
 */
describe("workflow heartbeat parent pickup signal", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	/** Poll a condition the host settles asynchronously. Bounded, never a bare sleep. */
	async function waitFor(condition: () => boolean): Promise<void> {
		for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}

	interface ObservedEvents {
		readonly settled: number[];
		readonly consumed: string[];
	}

	async function createObservingHarness(): Promise<{ harness: Harness; observed: ObservedEvents }> {
		const observed: ObservedEvents = { settled: [], consumed: [] };
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", () => {
						observed.settled.push(observed.consumed.length);
					});
					pi.on("message_end", (event) => {
						// The production narrowing, so this regression exercises the
						// same path the extension wires up rather than a test-local copy.
						const content = workflowHeartbeatConsumedContent(event);
						if (content !== undefined) observed.consumed.push(content);
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ shutdownHandler: () => {} });
		return { harness, observed };
	}

	const HEARTBEAT_TEXT = '♥ Workflow "probe" heartbeat (run probe-run)';

	async function sendHeartbeatCard(harness: Harness, text: string): Promise<void> {
		await harness.session.sendCustomMessage(
			{
				customType: "workflows:workflow-heartbeat",
				content: [{ type: "text", text }],
				display: true,
				details: { runId: "probe-run", scheduledAt: 1, workflowName: "probe", startedAt: 0, intervalMinutes: 1 },
			},
			// The production option triple.
			{ triggerTurn: true, deliverAs: "steer", persistWhenStreaming: true },
		);
	}

	test("a steer-queued heartbeat reaches extensions as message_end only when it is consumed", async () => {
		const { harness, observed } = await createObservingHarness();
		const started = Promise.withResolvers<void>();
		harness.setResponses([
			async (_context, options) => {
				started.resolve();
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) resolve();
					else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("interrupted");
			},
			fauxAssistantMessage("after the queued heartbeat"),
			fauxAssistantMessage("spare"),
		]);

		const active = harness.session.prompt("start a streaming turn");
		await started.promise;

		// Admitted into the parent's queue while the turn is streaming.
		await sendHeartbeatCard(harness, HEARTBEAT_TEXT);
		assert.equal(observed.consumed.length, 0, "admission alone is not consumption");

		// Pause, then end the turn. The queue drain is skipped while paused, so
		// the card stays parked — but the prompt cycle still settles.
		harness.session.pauseQueuedMessages();
		await harness.session.abort();
		await active;

		assert.ok(harness.session.queuedMessagesPaused, "the queue is paused");
		assert.ok(observed.settled.length > 0, "agent_settled fired even though nothing was drained");
		assert.equal(
			observed.consumed.length,
			0,
			"no message_end for the parked card — this is the distinction agent_settled cannot make",
		);
		// Resume restores the held card but does not itself start a turn — the
		// host requires an explicit driver, which is the documented behavior in
		// packages/coding-agent/test/paused-queued-late-admission.test.ts.
		await harness.session.resumeQueuedMessages();
		assert.equal(observed.consumed.length, 0, "restoring the hold is still not consumption");

		await harness.session.prompt("explicit resume driver");

		assert.ok(
			observed.consumed.includes(HEARTBEAT_TEXT),
			`the restored card is consumed and reaches extensions verbatim; saw ${JSON.stringify(observed.consumed)}`,
		);
	});

	test("an idle parent consumes the heartbeat in the turn it triggers", async () => {
		const { harness, observed } = await createObservingHarness();
		harness.setResponses([fauxAssistantMessage("acknowledged"), fauxAssistantMessage("spare")]);

		// On an idle parent the send resolves at admission and the triggered turn
		// continues in the background, so wait for the turn rather than for the send.
		await sendHeartbeatCard(harness, HEARTBEAT_TEXT);
		await waitFor(() => observed.consumed.includes(HEARTBEAT_TEXT));

		assert.ok(
			observed.consumed.includes(HEARTBEAT_TEXT),
			`an idle parent runs the triggered turn and consumes the card; saw ${JSON.stringify(observed.consumed)}`,
		);
	});
});
