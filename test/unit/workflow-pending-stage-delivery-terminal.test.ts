/**
 * Terminal settlement of the workflow pending-stage delivery contract.
 *
 * `stage-runner-controller` awaits `pendingStageDelivery.ready()` with no
 * timeout, and only a successful drain ever resolved it. When the Intercom
 * wrapper exhausts its bounded warm-up retries there is no owner left, so the
 * delivery needs a terminal signal: `fail(reason)` settles `ready()` exactly
 * once with a typed, stage-scoped error instead of leaving the stage parked.
 *
 * The queued entries themselves are never consumed by a stage that was already
 * failed closed — a delivery asked to drain after the latch is a silent no-op,
 * so the steering stays queued rather than being marked delivered to a stage
 * that will not read it.
 */

import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import {
	createWorkflowPendingStageDelivery,
	WorkflowPendingStageDeliveryFailedError,
} from "../../packages/workflows/src/runs/foreground/pending-stage-delivery.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { PendingStageMessageInput } from "../../packages/workflows/src/shared/store-types.js";
import { testRunId } from "../helpers/run-id.js";
import { sleep } from "../helpers/runtime.js";

const RUN_ID = testRunId("terminal-delivery");
const GROUP = `workflow:${RUN_ID}`;
const STAGE_ID = "reviewer-id";
const STAGE_NAME = "reviewer";

afterEach(() => setDurableBackend(undefined));

function fixture() {
	const store = createStore();
	store.recordRunStart({
		id: RUN_ID,
		name: "flow",
		inputs: {},
		status: "running",
		stages: [{ id: STAGE_ID, name: STAGE_NAME, status: "pending", parentIds: [], toolEvents: [] }],
		startedAt: 1,
	});
	const backend = new InMemoryDurableBackend();
	backend.registerWorkflow({ workflowId: RUN_ID, name: "flow", inputs: {}, status: "running", createdAt: 1 });
	setDurableBackend(backend);
	return { store, backend };
}

function queuedInput(id: string): PendingStageMessageInput {
	return {
		runId: RUN_ID,
		stageKey: STAGE_NAME,
		from: { id: "planner-session", name: "planner", group: GROUP },
		message: { id, timestamp: 1_725_000_000_000, content: { text: `steering ${id}` } },
		queuedAt: "2026-09-04T00:00:00.000Z",
	};
}

async function fixtureWithQueuedMessage(id = "queued-1") {
	const { store, backend } = fixture();
	const queued = await store.queueStageMessage(queuedInput(id), GROUP, GROUP, backend);
	assert.equal(queued?.ok, true);
	return { store, backend };
}

describe("workflow pending-stage delivery terminal failure", () => {
	test("rejects a ready() that was already awaited when the delivery owner gives up", async () => {
		const { store } = await fixtureWithQueuedMessage();
		const delivery = createWorkflowPendingStageDelivery(store, RUN_ID, STAGE_ID, STAGE_NAME);

		const parked = delivery.ready();
		assert.ok(parked instanceof Promise, "a stage with queued messages parks on ready()");
		delivery.fail?.(new Error("Intercom could not reach the broker after 5 warm-up attempts."));

		await assert.rejects(parked, (error: unknown) => {
			assert.ok(error instanceof WorkflowPendingStageDeliveryFailedError);
			assert.equal(error.code, "pending_stage_delivery_failed");
			assert.equal(error.runId, RUN_ID);
			assert.equal(error.stageId, STAGE_ID);
			assert.equal(error.stageName, STAGE_NAME);
			assert.match(error.message, /stage "reviewer"/);
			assert.match(error.message, /reviewer-id/);
			assert.match(error.message, /Intercom could not reach the broker after 5 warm-up attempts\./);
			assert.equal((error.cause as Error).message, "Intercom could not reach the broker after 5 warm-up attempts.");
			return true;
		});
	});

	test("rejects a ready() requested after the failure was already latched", async () => {
		// The wrapper's `session_start` handler returns as soon as it schedules the
		// retry, so the terminal signal can arrive before the controller ever calls
		// `ready()`. A latch that only rejected an existing promise would be a
		// silent no-op in that ordering.
		const { store } = await fixtureWithQueuedMessage();
		const delivery = createWorkflowPendingStageDelivery(store, RUN_ID, STAGE_ID, STAGE_NAME);

		delivery.fail?.(new Error("Intercom could not reach the broker after 5 warm-up attempts."));

		await assert.rejects(
			delivery.ready() as Promise<void>,
			(error: unknown) => error instanceof WorkflowPendingStageDeliveryFailedError,
		);
	});

	test("keeps the empty-queue short circuit so a stage with nothing queued still runs", async () => {
		const { store } = fixture();
		const delivery = createWorkflowPendingStageDelivery(store, RUN_ID, STAGE_ID, STAGE_NAME);

		assert.equal(delivery.ready(), undefined);
		delivery.fail?.(new Error("Intercom could not reach the broker after 5 warm-up attempts."));

		assert.equal(delivery.ready(), undefined, "nothing was queued, so nothing is lost by running the stage");
	});

	test("settles exactly once: the first reason wins and a duplicate fail() is a no-op", async () => {
		const { store } = await fixtureWithQueuedMessage();
		const delivery = createWorkflowPendingStageDelivery(store, RUN_ID, STAGE_ID, STAGE_NAME);

		delivery.fail?.(new Error("first reason"));
		delivery.fail?.(new Error("second reason"));

		const first = await delivery.ready()?.then(
			() => undefined,
			(error: Error) => error,
		);
		const second = await delivery.ready()?.then(
			() => undefined,
			(error: Error) => error,
		);
		assert.ok(first instanceof WorkflowPendingStageDeliveryFailedError);
		assert.match(first.message, /first reason/);
		assert.equal(second, first, "every later ready() settles with the same terminal error");
	});

	test("a late deliverPending() after the failure leaves the queued steering untouched", async () => {
		const { store } = await fixtureWithQueuedMessage("late-1");
		const delivery = createWorkflowPendingStageDelivery(store, RUN_ID, STAGE_ID, STAGE_NAME);

		delivery.fail?.(new Error("Intercom could not reach the broker after 5 warm-up attempts."));
		const delivered: string[] = [];
		await delivery.deliverPending((_from, message) => {
			delivered.push(message.id);
		});

		assert.deepEqual(delivered, [], "a failed-closed stage never consumes the entries it was refused");
		const queued = store.pendingStageMessagesFor(RUN_ID, STAGE_NAME);
		assert.equal(queued.length, 1);
		assert.equal(queued[0]?.status, "queued");
	});

	test("delivers normally when no failure was latched", async () => {
		const { store } = await fixtureWithQueuedMessage("healthy-1");
		const delivery = createWorkflowPendingStageDelivery(store, RUN_ID, STAGE_ID, STAGE_NAME);

		const parked = delivery.ready();
		const delivered: string[] = [];
		await delivery.deliverPending((_from, message) => {
			delivered.push(message.id);
		});
		await parked;

		assert.deepEqual(delivered, ["healthy-1"]);
		const entries = store.runs().find((entry) => entry.id === RUN_ID)?.pendingStageMessages;
		assert.equal(entries?.[0]?.status, "delivered");
	});

	test("a terminal failure nobody awaited raises no unhandled rejection", async () => {
		const { store } = await fixtureWithQueuedMessage("orphan-1");
		const delivery = createWorkflowPendingStageDelivery(store, RUN_ID, STAGE_ID, STAGE_NAME);
		const rejections: unknown[] = [];
		const onUnhandledRejection = (reason: unknown): void => {
			rejections.push(reason);
		};
		process.on("unhandledRejection", onUnhandledRejection);
		try {
			// The controller may not have reached its `await` yet — production must
			// not turn that race into a process-level unhandled rejection.
			void delivery.ready();
			delivery.fail?.(new Error("Intercom could not reach the broker after 5 warm-up attempts."));
			await sleep(50);
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}

		assert.deepEqual(rejections, []);
	});
});
