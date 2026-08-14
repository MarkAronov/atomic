import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	createWorkflowHeartbeatDelivery,
	type WorkflowHeartbeatTimerApi,
	type WorkflowHeartbeatTimerHandle,
} from "../../packages/workflows/src/extension/workflow-heartbeat-delivery.js";
import type { WorkflowHeartbeatEventDetails } from "../../packages/workflows/src/shared/workflow-heartbeat-contract.js";
import { testRunId } from "../helpers/run-id.js";

/**
 * The queue half of terminal cleanup (issue #1975), tested at the delivery seam
 * where it is directly observable. The scheduler-level suite proves the same
 * outcome end to end, but a suppressed identity and a discarded one look
 * identical from there — both simply never reach the parent.
 */

interface FakeTimer {
	readonly id: number;
	readonly handler: () => void;
}

interface FakeTimerHandle extends WorkflowHeartbeatTimerHandle {
	readonly id: number;
}

/** Timers fire only when a test asks them to; nothing here waits on real time. */
function fakeTimers(): WorkflowHeartbeatTimerApi & { live(): FakeTimer[]; fireAll(): void } {
	const timers = new Map<number, FakeTimer>();
	let nextId = 1;
	return {
		setTimeout(handler: () => void): FakeTimerHandle {
			const id = nextId++;
			timers.set(id, { id, handler });
			return { id };
		},
		clearTimeout(handle: WorkflowHeartbeatTimerHandle): void {
			timers.delete((handle as FakeTimerHandle).id);
		},
		live() {
			return [...timers.values()];
		},
		fireAll() {
			for (const timer of [...timers.values()]) {
				timers.delete(timer.id);
				timer.handler();
			}
		},
	};
}

function details(runId: string, scheduledAt: number): WorkflowHeartbeatEventDetails {
	return { runId, scheduledAt, workflowName: "discard-workflow", startedAt: 0, intervalMinutes: 1 };
}

/** Let already-resolved promise callbacks in the delivery chain run. */
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

describe("workflow heartbeat delivery discard", () => {
	test("a queued identity for the discarded run is never attempted", async () => {
		const keptId = testRunId("discard-kept");
		const droppedId = testRunId("discard-dropped");
		const timers = fakeTimers();
		const attempted: string[] = [];
		const settled: string[] = [];
		let admitFirst: ((delivered: boolean) => void) | undefined;
		const delivery = createWorkflowHeartbeatDelivery({
			timers,
			emit: (payload) => {
				attempted.push(payload.runId);
				if (payload.runId !== keptId) return true;
				return new Promise<boolean>((resolve) => {
					admitFirst = resolve;
				});
			},
			onSettled: (payload) => settled.push(payload.runId),
		});

		delivery.deliver(details(keptId, 60_000));
		delivery.deliver(details(droppedId, 60_000));
		assert.deepEqual(attempted, [keptId], "the second identity waits behind the in-flight head");

		assert.equal(delivery.discard(droppedId), true, "its queued entry is dropped");
		admitFirst?.(true);
		await flushMicrotasks();
		assert.deepEqual(attempted, [keptId], "and it is never attempted once the head settles");
		assert.deepEqual(settled, [keptId]);
		delivery.dispose();
	});

	test("a head waiting to retry is dropped with its backoff timer, and the next identity starts", () => {
		const droppedId = testRunId("discard-retrying");
		const nextId = testRunId("discard-next");
		const timers = fakeTimers();
		const attempted: string[] = [];
		const delivery = createWorkflowHeartbeatDelivery({
			timers,
			emit: (payload) => {
				attempted.push(payload.runId);
				return payload.runId !== droppedId;
			},
			onSettled: () => {},
		});

		delivery.deliver(details(droppedId, 60_000));
		delivery.deliver(details(nextId, 60_000));
		assert.deepEqual(
			[...new Set(attempted)],
			[droppedId],
			"the failing head holds the queue; only it has been attempted",
		);
		assert.ok(timers.live().length > 0, "its retry timer is armed");

		assert.equal(delivery.discard(droppedId), true);
		assert.equal(timers.live().length, 0, "no retry timer survives the run that owned it");
		assert.equal(attempted.at(-1), nextId, "the identity behind it starts immediately");

		const attemptsAfterDiscard = attempted.length;
		timers.fireAll();
		assert.equal(attempted.length, attemptsAfterDiscard, "and the dropped identity is never retried");
		delivery.dispose();
	});

	test("an in-flight head is left to settle rather than recalled", async () => {
		const runId = testRunId("discard-in-flight");
		const timers = fakeTimers();
		let admit: ((delivered: boolean) => void) | undefined;
		const settled: { runId: string; delivered: boolean }[] = [];
		const delivery = createWorkflowHeartbeatDelivery({
			timers,
			emit: () =>
				new Promise<boolean>((resolve) => {
					admit = resolve;
				}),
			onSettled: (payload, delivered) => settled.push({ runId: payload.runId, delivered }),
		});

		delivery.deliver(details(runId, 60_000));
		assert.equal(
			delivery.discard(runId),
			false,
			"a send already handed to the host cannot be recalled, so nothing was dropped",
		);

		admit?.(true);
		await flushMicrotasks();
		assert.deepEqual(
			settled,
			[{ runId, delivered: true }],
			"it settles normally; the scheduler's slot is already gone",
		);
		delivery.dispose();
	});

	test("discarding a run with nothing queued reports false and changes nothing", () => {
		const runId = testRunId("discard-unknown");
		const otherId = testRunId("discard-unknown-other");
		const timers = fakeTimers();
		const attempted: string[] = [];
		const delivery = createWorkflowHeartbeatDelivery({
			timers,
			emit: (payload) => {
				attempted.push(payload.runId);
				return true;
			},
			onSettled: () => {},
		});

		assert.equal(delivery.discard(runId), false, "an empty queue is already clear");
		delivery.deliver(details(otherId, 60_000));
		assert.equal(delivery.discard(runId), false, "and so is a queue holding only other runs");
		assert.deepEqual(attempted, [otherId], "the unrelated identity is untouched");
		assert.equal(timers.live().length, 0);
		delivery.dispose();
	});
});
