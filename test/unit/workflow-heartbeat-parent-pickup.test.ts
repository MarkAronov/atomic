import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, test } from "vitest";
import type { MessageEndEventResult } from "../../packages/coding-agent/src/core/extensions/event-results.js";
import { createHarness, type Harness } from "../../packages/coding-agent/test/suite/harness.js";
import {
	isWorkflowHeartbeatTerminalRun,
	workflowHeartbeatConsumedContent,
	workflowHeartbeatContextInvalidation,
} from "../../packages/workflows/src/extension/workflow-heartbeat-scheduler.js";
import type { SessionEntry } from "../../packages/workflows/src/shared/persistence-restore.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

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

/**
 * Host-level regression for the last guard on the heartbeat path (issue #1975).
 *
 * The three guards the scheduler owns all sit before `sendMessage`. Once the
 * host accepts a heartbeat, its visible card is committed to the transcript and
 * a hidden reconciliation is queued behind it, and nothing in the extension API
 * withdraws either. So a run that finishes while its card is parked, and a card
 * recovered from a previous process at the restart door, both used to steer the
 * parent about a run that was over.
 *
 * These run against the real `AgentSession` for the same reason as the tests
 * above: the behaviour only exists in the host. What is asserted is the thing
 * that matters — whether the heartbeat text reaches the *provider request*.
 */
describe("workflow heartbeat context invalidation", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const RUN_ID = "invalidation-run";
	const HEARTBEAT_TEXT = '♥ Workflow "probe" is still running (run invalidation-run)';
	const FOREIGN_TEXT = "an unrelated extension's custom message";

	function heartbeatDetails(): Record<string, string | number> {
		return { runId: RUN_ID, scheduledAt: 1, workflowName: "probe", startedAt: 0, intervalMinutes: 1 };
	}

	/**
	 * A harness wired with the production decision — the same function
	 * `extension-runtime-state.ts` calls, over the same store authority — rather
	 * than a test-local reimplementation of it.
	 */
	async function createInvalidatingHarness(store: ReturnType<typeof createStore>): Promise<{
		harness: Harness;
		contexts: string[];
	}> {
		const contexts: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event, ctx) => {
						// The same seams the extension uses: the session manager the host
						// hands to the handler, and the store's own terminal authority.
						// Both casts cross the package boundary `packages/workflows`
						// deliberately never imports across — it declares structural
						// equivalents of the host's session entry and message-end result.
						const invalidation = workflowHeartbeatContextInvalidation(
							event,
							ctx.sessionManager.getEntries() as readonly SessionEntry[],
							(runId) => {
								const run = store.runs().find((candidate) => candidate.id === runId);
								return run !== undefined && !isWorkflowHeartbeatTerminalRun(run);
							},
						);
						return invalidation as MessageEndEventResult | undefined;
					});
				},
			],
		});
		harnesses.push(harness);
		return { harness, contexts };
	}

	/** Every provider request this turn, flattened, so a steer cannot hide in a part. */
	function recordContext(contexts: string[], context: unknown): void {
		contexts.push(JSON.stringify(context));
	}

	/**
	 * How many provider requests carried this text. The needle is JSON-encoded
	 * before the search because the haystack is: a card reading `Workflow "probe"`
	 * appears as `Workflow \"probe\"` in the serialized context, and comparing the
	 * raw string would silently never match and pass whatever the code did.
	 */
	function contextsCarrying(contexts: readonly string[], text: string): number {
		const encoded = JSON.stringify(text).slice(1, -1);
		return contexts.filter((context) => context.includes(encoded)).length;
	}

	function startRun(store: ReturnType<typeof createStore>, id: string): void {
		store.recordRunStart({ id, name: "probe", inputs: {}, status: "running", stages: [], startedAt: 0 });
	}

	test("a card parked while its run becomes recoverably blocked still reaches the model", async () => {
		const store = createStore();
		startRun(store, RUN_ID);
		const { harness, contexts } = await createInvalidatingHarness(store);
		await harness.session.bindExtensions({ shutdownHandler: () => {} });

		const started = Promise.withResolvers<void>();
		harness.setResponses([
			async (context, options) => {
				recordContext(contexts, context);
				started.resolve();
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) resolve();
					else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("interrupted");
			},
			(context) => {
				recordContext(contexts, context);
				return fauxAssistantMessage("after the recoverable block");
			},
			fauxAssistantMessage("spare"),
		]);

		const active = harness.session.prompt("start a streaming turn");
		await started.promise;
		await harness.session.sendCustomMessage(
			{
				customType: "workflows:workflow-heartbeat",
				content: [{ type: "text", text: HEARTBEAT_TEXT }],
				display: true,
				details: heartbeatDetails(),
			},
			{ triggerTurn: true, deliverAs: "steer", persistWhenStreaming: true },
		);
		harness.session.pauseQueuedMessages();
		await harness.session.abort();
		await active;

		assert.equal(
			store.recordRunBlocked(RUN_ID, "rate limited", {
				failureKind: "rate_limit",
				failureRecoverability: "recoverable",
				failureDisposition: "active_blocked",
				failureMessage: "Provider rate limit reached.",
				failedStageId: "s1",
				resumable: true,
			}),
			true,
		);

		await harness.session.resumeQueuedMessages();
		await harness.session.prompt("explicit resume driver");

		assert.ok(
			contextsCarrying(contexts, HEARTBEAT_TEXT) > 0,
			"the resumable run still owns its admitted heartbeat, so the parent learns that it is stuck",
		);
	});

	test("a card parked past its run's terminal state never reaches the model", async () => {
		const store = createStore();
		startRun(store, RUN_ID);
		const { harness, contexts } = await createInvalidatingHarness(store);
		await harness.session.bindExtensions({ shutdownHandler: () => {} });

		const started = Promise.withResolvers<void>();
		harness.setResponses([
			async (context, options) => {
				recordContext(contexts, context);
				started.resolve();
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) resolve();
					else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("interrupted");
			},
			(context) => {
				recordContext(contexts, context);
				return fauxAssistantMessage("after the parked card");
			},
			(context) => {
				recordContext(contexts, context);
				return fauxAssistantMessage("spare");
			},
		]);

		const active = harness.session.prompt("start a streaming turn");
		await started.promise;

		// Admitted into the parent's queue mid-turn, then parked.
		await harness.session.sendCustomMessage(
			{
				customType: "workflows:workflow-heartbeat",
				content: [{ type: "text", text: HEARTBEAT_TEXT }],
				display: true,
				details: heartbeatDetails(),
			},
			{ triggerTurn: true, deliverAs: "steer", persistWhenStreaming: true },
		);
		// A second custom message from a different extension, parked alongside it,
		// so the negative control travels the identical path.
		await harness.session.sendCustomMessage(
			{ customType: "someone-else:notice", content: [{ type: "text", text: FOREIGN_TEXT }], display: true },
			{ triggerTurn: true, deliverAs: "steer", persistWhenStreaming: true },
		);
		harness.session.pauseQueuedMessages();
		await harness.session.abort();
		await active;

		// The run finishes while its card sits in the parent's queue. Terminal
		// cleanup runs here and cannot reach that card.
		store.recordRunEnd(RUN_ID, "completed");

		await harness.session.resumeQueuedMessages();
		await harness.session.prompt("explicit resume driver");

		assert.ok(contexts.length > 1, "the resumed turn reached the provider");
		assert.ok(
			contextsCarrying(contexts, FOREIGN_TEXT) > 0,
			"another extension's parked custom message still reaches the model, so the drain really ran",
		);
		assert.equal(
			contextsCarrying(contexts, HEARTBEAT_TEXT),
			0,
			"the terminal run's heartbeat never enters the model's context",
		);
		// The user's scrollback is deliberately not rewritten.
		assert.ok(
			harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom_message" && entry.customType === "workflows:workflow-heartbeat"),
			"the visible card remains in the transcript as a true record of what was raised",
		);
	});

	test("a heartbeat recovered from a previous process never reaches the model", async () => {
		// The restart door: the workflows store is cleared at session start and
		// loads lazily, so the run behind a recovered card is normally absent
		// rather than terminal. Delivering it would replay a boundary raised by a
		// process that is gone.
		const store = createStore();
		const { harness, contexts } = await createInvalidatingHarness(store);
		await harness.session.bindExtensions({ shutdownHandler: () => {} });
		harness.setResponses([
			(context) => {
				recordContext(contexts, context);
				return fauxAssistantMessage("first turn");
			},
			(context) => {
				recordContext(contexts, context);
				return fauxAssistantMessage("after recovery");
			},
			(context) => {
				recordContext(contexts, context);
				return fauxAssistantMessage("spare");
			},
			(context) => {
				recordContext(contexts, context);
				return fauxAssistantMessage("spare two");
			},
			(context) => {
				recordContext(contexts, context);
				return fauxAssistantMessage("spare three");
			},
		]);

		// A conversation has to exist before recovery can continue one.
		await harness.session.prompt("prime the conversation");

		// The durable trace a previous process left: a heartbeat card carrying the
		// protected-reconciliation marker and no persisted hidden completion.
		harness.sessionManager.appendCustomMessageEntry(
			"workflows:workflow-heartbeat",
			[{ type: "text", text: HEARTBEAT_TEXT }],
			true,
			heartbeatDetails(),
			true,
			{ delivery: "steer" },
			undefined,
		);
		harness.sessionManager.appendCustomMessageEntry(
			"someone-else:notice",
			[{ type: "text", text: FOREIGN_TEXT }],
			true,
			undefined,
			true,
			{ delivery: "steer" },
			undefined,
		);

		// Binding again drives `recoverProtectedStreamingCustomMessages`.
		await harness.session.bindExtensions({ shutdownHandler: () => {} });
		await harness.session.prompt("drive the recovered queue");

		assert.ok(contexts.length > 1, "the recovered queue drove a second turn");
		assert.ok(
			contextsCarrying(contexts, FOREIGN_TEXT) > 0,
			"another extension's recovered card reaches the model, so recovery really requeued and drained",
		);
		assert.equal(
			contextsCarrying(contexts, HEARTBEAT_TEXT),
			0,
			"a stale recovered heartbeat is invalidated rather than replayed to the model",
		);
	});
});
