import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { WORKFLOW_HEARTBEAT_MAX_DELIVERY_ATTEMPTS } from "../../packages/workflows/src/extension/workflow-heartbeat-delivery.js";
import {
	createWorkflowHeartbeatSchedulerState,
	installWorkflowHeartbeatScheduler,
	nextWorkflowHeartbeatBoundary,
	type WorkflowHeartbeatScheduler,
	type WorkflowHeartbeatSchedulerState,
} from "../../packages/workflows/src/extension/workflow-heartbeat-scheduler.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import {
	WORKFLOW_HEARTBEAT_CUSTOM_TYPE,
	type WorkflowHeartbeatEventDetails,
} from "../../packages/workflows/src/shared/workflow-heartbeat-contract.js";
import { testRunId } from "../helpers/run-id.js";

type Store = ReturnType<typeof createStore>;

const MINUTE_MS = 60_000;
/** Fixed start anchor so every expected boundary in this file is literal arithmetic. */
const STARTED_AT = 1_000_000;

interface CapturedSend {
	readonly customType: string;
	readonly content: string;
	readonly display: boolean;
	readonly details: WorkflowHeartbeatEventDetails;
	readonly options: Record<string, unknown> | undefined;
}

interface FakeTimer {
	readonly id: number;
	readonly handler: () => void;
	readonly firesAt: number;
	readonly delayMs: number;
}

interface FakeTimerHandle {
	readonly id: number;
	unref?: () => void;
}

/**
 * Injectable clock plus timer API. Nothing in this file waits on real time: the
 * clock only moves when a test advances it, and a timer fires only when that
 * advance reaches its deadline.
 */
class TestClock {
	current: number;
	private nextId = 1;
	readonly timers = new Map<number, FakeTimer>();
	unrefCount = 0;
	/** Milliseconds a fired timer overshoots its deadline, as real timers do. */
	lateFireMs = 0;

	constructor(start: number) {
		this.current = start;
	}

	now = (): number => this.current;

	readonly timerApi = {
		setTimeout: (handler: () => void, delayMs: number): FakeTimerHandle => {
			const id = this.nextId++;
			this.timers.set(id, { id, handler, firesAt: this.current + delayMs, delayMs });
			return {
				id,
				unref: () => {
					this.unrefCount += 1;
				},
			};
		},
		clearTimeout: (handle: FakeTimerHandle): void => {
			this.timers.delete(handle.id);
		},
	};

	/** Live (unfired, uncleared) timers. */
	live(): FakeTimer[] {
		return [...this.timers.values()];
	}

	/** Advance the clock to `to`, firing every timer whose deadline is reached. */
	advanceTo(to: number): void {
		// Bounded: a fired timer is removed before its handler can re-arm, and the
		// guard stops a pathological re-arm loop from hanging the suite.
		for (let guard = 0; guard < 1000; guard += 1) {
			const due = [...this.timers.values()]
				.filter((timer) => timer.firesAt <= to)
				.sort((a, b) => a.firesAt - b.firesAt)[0];
			if (due === undefined) break;
			this.current = Math.max(this.current, Math.min(to, due.firesAt + this.lateFireMs));
			this.timers.delete(due.id);
			due.handler();
		}
		this.current = Math.max(this.current, to);
	}

	advanceBy(deltaMs: number): void {
		this.advanceTo(this.current + deltaMs);
	}
}

interface Harness {
	readonly store: Store;
	readonly clock: TestClock;
	readonly sent: CapturedSend[];
	readonly state: WorkflowHeartbeatSchedulerState;
	readonly scheduler: WorkflowHeartbeatScheduler;
}

function installHarness(opts: {
	store?: Store;
	startAt?: number;
	intervals?: Readonly<Record<string, number>>;
	defaultInterval?: number;
	lateFireMs?: number;
	/**
	 * Milliseconds after an admitted send at which the parent reports settling.
	 * Omitted means the parent never reports becoming available, which is how
	 * the busy-parent and hold-cap cases are expressed.
	 */
	parentSettleDelayMs?: number;
	state?: WorkflowHeartbeatSchedulerState;
	send?: (details: WorkflowHeartbeatEventDetails, sent: readonly CapturedSend[]) => Promise<void> | undefined;
}): Harness {
	const store = opts.store ?? createStore();
	const clock = new TestClock(opts.startAt ?? STARTED_AT);
	clock.lateFireMs = opts.lateFireMs ?? 0;
	const sent: CapturedSend[] = [];
	const state = opts.state ?? createWorkflowHeartbeatSchedulerState();
	let installed: WorkflowHeartbeatScheduler | undefined;
	const scheduler = installWorkflowHeartbeatScheduler({
		store,
		state,
		now: clock.now,
		timers: clock.timerApi,
		resolveIntervalMinutes: (name) => opts.intervals?.[name] ?? opts.defaultInterval,
		sendMessage: (message, options) => {
			const captured = message as unknown as {
				customType: string;
				content: string;
				display: boolean;
				details: WorkflowHeartbeatEventDetails;
			};
			sent.push({
				customType: captured.customType,
				content: captured.content,
				display: captured.display,
				details: captured.details,
				options: options as Record<string, unknown> | undefined,
			});
			// The real host resolves this call once the card is admitted into the
			// parent's queue, not once the parent reads it — so the default return
			// is an immediate resolve, and pickup is a separate later signal.
			if (opts.parentSettleDelayMs !== undefined) {
				clock.timerApi.setTimeout(() => installed?.notifyParentAvailable(), opts.parentSettleDelayMs);
			}
			return opts.send?.(captured.details, sent) as undefined;
		},
	});
	installed = scheduler;
	return { store, clock, sent, state, scheduler };
}

/** Let already-resolved promise callbacks in the delivery chain run. */
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

function startRun(
	store: Store,
	id: string,
	opts: { name?: string; startedAt?: number; parentRunId?: string } = {},
): void {
	store.recordRunStart({
		id,
		name: opts.name ?? "heartbeat-workflow",
		inputs: {},
		status: "running",
		stages: [],
		startedAt: opts.startedAt ?? STARTED_AT,
		...(opts.parentRunId === undefined ? {} : { parentRunId: opts.parentRunId }),
	});
}

function runSnapshot(store: Store, id: string): RunSnapshot {
	const run = store.runs().find((candidate) => candidate.id === id);
	assert.ok(run !== undefined, `run ${id} missing from store`);
	return run;
}

function boundaries(sent: readonly CapturedSend[]): number[] {
	return sent.map((send) => send.details.scheduledAt);
}

function runIds(sent: readonly CapturedSend[]): string[] {
	return sent.map((send) => send.details.runId);
}

describe("workflow heartbeat cadence", () => {
	test("a disabled (0) interval creates no timer and no schedule record", () => {
		const runId = testRunId("heartbeat-disabled");
		const store = createStore();
		startRun(store, runId);
		const harness = installHarness({ store, defaultInterval: 0 });

		assert.deepEqual(
			harness.scheduler.scheduleWorkflowHeartbeats(runSnapshot(store, runId), 0),
			{ kind: "disabled" },
			"an explicit 0 interval resolves to disabled",
		);
		assert.equal(harness.state.scheduled.size, 0, "no schedule record");
		assert.equal(harness.state.pending.size, 0, "no pending heartbeat");
		assert.equal(harness.clock.live().length, 0, "no timer armed");

		harness.clock.advanceBy(10 * MINUTE_MS);
		assert.equal(harness.sent.length, 0, "a disabled workflow never heartbeats");
		assert.equal(harness.clock.live().length, 0);
		harness.scheduler.dispose();
	});

	test("a positive interval produces recurring boundaries anchored to startedAt", () => {
		const runId = testRunId("heartbeat-recurring");
		const store = createStore();
		startRun(store, runId);
		// Real timers fire late. Because boundaries are anchored to the persisted
		// start time rather than to the previous delivery, a late wake-up must not
		// drag the following boundary with it. The parent picks each card up a
		// second after it is admitted, which is what frees the next boundary.
		const harness = installHarness({
			store,
			defaultInterval: 1,
			lateFireMs: 5_000,
			parentSettleDelayMs: 1_000,
		});

		harness.clock.advanceTo(STARTED_AT + 3 * MINUTE_MS + 15_000);
		assert.deepEqual(boundaries(harness.sent), [
			STARTED_AT + 1 * MINUTE_MS,
			STARTED_AT + 2 * MINUTE_MS,
			STARTED_AT + 3 * MINUTE_MS,
		]);
		for (const send of harness.sent) {
			assert.equal(send.details.startedAt, STARTED_AT);
			assert.equal(send.details.intervalMinutes, 1);
			assert.equal(send.details.runId, runId);
		}
		assert.equal(harness.clock.live().length, 1, "exactly one globally-next-due wake-up stays armed");
		assert.equal(harness.state.scheduled.get(runId)?.scheduledAt, STARTED_AT + 4 * MINUTE_MS);
		harness.scheduler.dispose();
	});

	test("nextWorkflowHeartbeatBoundary never derives the cadence from a delivery time", () => {
		assert.equal(nextWorkflowHeartbeatBoundary(STARTED_AT, 1, STARTED_AT), STARTED_AT + MINUTE_MS);
		assert.equal(nextWorkflowHeartbeatBoundary(STARTED_AT, 1, STARTED_AT + 59_999), STARTED_AT + MINUTE_MS);
		assert.equal(nextWorkflowHeartbeatBoundary(STARTED_AT, 1, STARTED_AT + MINUTE_MS), STARTED_AT + 2 * MINUTE_MS);
		// A boundary delivered late still yields the next boundary on the original
		// series, not "late arrival plus one interval".
		assert.equal(
			nextWorkflowHeartbeatBoundary(STARTED_AT, 1, STARTED_AT + MINUTE_MS + 45_000),
			STARTED_AT + 2 * MINUTE_MS,
		);
		// Fractional cadences are accepted by authoring and stay exact here.
		assert.equal(nextWorkflowHeartbeatBoundary(STARTED_AT, 0.5, STARTED_AT), STARTED_AT + 30_000);
		assert.equal(nextWorkflowHeartbeatBoundary(STARTED_AT, 0, STARTED_AT), undefined);
		assert.equal(nextWorkflowHeartbeatBoundary(STARTED_AT, -1, STARTED_AT), undefined);
		assert.equal(nextWorkflowHeartbeatBoundary(STARTED_AT, Number.NaN, STARTED_AT), undefined);
		// Authoring accepts a denormal interval; no finite boundary exists for it,
		// and no schedule is the narrow, non-throwing answer.
		assert.equal(nextWorkflowHeartbeatBoundary(STARTED_AT, Number.MIN_VALUE, STARTED_AT), undefined);
	});

	test("only one pending heartbeat exists per run while a send is in flight", () => {
		const runId = testRunId("heartbeat-one-pending");
		const store = createStore();
		startRun(store, runId);
		// A send that never settles keeps the run's single pending slot occupied.
		const harness = installHarness({ store, defaultInterval: 1, send: () => new Promise<void>(() => {}) });

		harness.clock.advanceTo(STARTED_AT + 3 * MINUTE_MS);
		assert.equal(harness.sent.length, 1, "a busy pending slot blocks later boundaries");
		assert.equal(harness.state.pending.size, 1);
		assert.deepEqual(harness.state.pending.get(runId), { runId, scheduledAt: STARTED_AT + MINUTE_MS });
		assert.equal(harness.state.scheduled.size, 0, "no second schedule record while one is pending");
		harness.scheduler.dispose();
	});

	test("an admitted-but-unread heartbeat keeps its slot, so a later boundary is skipped not stacked", () => {
		const runId = testRunId("heartbeat-admitted-not-read");
		const store = createStore();
		startRun(store, runId);
		// The real host resolves `sendMessage` on admission into the parent's
		// queue, so a settled send is not evidence the parent read the card. With
		// no pickup signal the slot must stay occupied.
		const harness = installHarness({ store, defaultInterval: 1 });

		harness.clock.advanceTo(STARTED_AT + 90_000);
		assert.equal(harness.sent.length, 1, "one admitted heartbeat, not two queued behind each other");
		assert.deepEqual(harness.state.pending.get(runId), { runId, scheduledAt: STARTED_AT + MINUTE_MS });
		assert.equal(harness.state.scheduled.size, 0, "no boundary is armed while one is outstanding");
		harness.scheduler.dispose();
	});

	test("the parent reporting availability releases the slot and resumes at the first future boundary", () => {
		const runId = testRunId("heartbeat-parent-available");
		const store = createStore();
		startRun(store, runId);
		const harness = installHarness({ store, defaultInterval: 1 });

		harness.clock.advanceTo(STARTED_AT + MINUTE_MS + 5_000);
		assert.equal(harness.sent.length, 1);

		// Pickup happens after boundary 2 would have been due, so boundary 2 is a
		// missed boundary and must never be raised.
		harness.clock.advanceTo(STARTED_AT + 2 * MINUTE_MS + 30_000);
		harness.scheduler.notifyParentAvailable();
		assert.equal(harness.state.pending.size, 0, "the slot is free once the parent picked the card up");
		assert.equal(
			harness.state.scheduled.get(runId)?.scheduledAt,
			STARTED_AT + 3 * MINUTE_MS,
			"the cadence resumes at the first future boundary, not at the missed one",
		);

		harness.clock.advanceTo(STARTED_AT + 3 * MINUTE_MS + 5_000);
		assert.deepEqual(boundaries(harness.sent), [STARTED_AT + MINUTE_MS, STARTED_AT + 3 * MINUTE_MS]);
		harness.scheduler.dispose();
	});

	test("a parent that never reports availability resumes the cadence rather than going silent", () => {
		const runId = testRunId("heartbeat-hold-cap");
		const store = createStore();
		startRun(store, runId);
		// No pickup signal ever arrives. The hold cap of one cadence interval is
		// what keeps this from silencing the run forever.
		const harness = installHarness({ store, defaultInterval: 1 });

		harness.clock.advanceTo(STARTED_AT + 3 * MINUTE_MS + 30_000);
		assert.deepEqual(
			boundaries(harness.sent),
			[STARTED_AT + MINUTE_MS, STARTED_AT + 3 * MINUTE_MS],
			"the held slot expires one interval later and the cadence resumes at the next future boundary",
		);
		assert.ok(harness.sent.length < 4, "the skipped boundary is dropped rather than replayed once the hold expires");
		harness.scheduler.dispose();
	});

	test("a retry reuses the same runId + scheduledAt identity", async () => {
		const runId = testRunId("heartbeat-retry-identity");
		const store = createStore();
		startRun(store, runId);
		const harness = installHarness({
			store,
			defaultInterval: 1,
			send: (_details, sent) => (sent.length === 1 ? Promise.reject(new Error("parent busy")) : undefined),
		});

		harness.clock.advanceTo(STARTED_AT + MINUTE_MS);
		// Let the rejected send settle, then let the backoff timer fire.
		await Promise.resolve();
		await Promise.resolve();
		harness.clock.advanceBy(1_000);

		assert.equal(harness.sent.length, 2, "the failed identity is retried");
		assert.deepEqual(harness.sent[0]?.details, harness.sent[1]?.details, "retry reuses the identical payload");
		assert.equal(harness.sent[1]?.details.scheduledAt, STARTED_AT + MINUTE_MS);
		assert.equal(harness.sent[1]?.details.runId, runId);
		harness.scheduler.dispose();
	});

	test("a run that goes terminal between retry attempts is not sent again", async () => {
		const runId = testRunId("heartbeat-terminal-between-retries");
		const store = createStore();
		startRun(store, runId);
		const harness = installHarness({
			store,
			defaultInterval: 1,
			send: () => Promise.reject(new Error("parent busy")),
		});

		harness.clock.advanceTo(STARTED_AT + MINUTE_MS);
		await flushMicrotasks();
		assert.equal(harness.sent.length, 1, "attempt 1 was sent");

		// The run finishes inside the backoff window. The retry must re-read live
		// status rather than replay the identity it captured at enqueue time.
		store.recordRunEnd(runId, "completed");
		harness.clock.advanceBy(1_000);
		await flushMicrotasks();

		assert.equal(harness.sent.length, 1, "the terminal run is suppressed instead of retried");
		assert.equal(harness.state.pending.size, 0, "the suppressed identity releases its slot");
		assert.equal(harness.state.pendingHoldExpiresAt.size, 0);
		harness.scheduler.dispose();
	});

	test("a delivery that never reaches the parent releases the slot instead of wedging the cadence", async () => {
		const runId = testRunId("heartbeat-delivery-exhausted");
		const store = createStore();
		startRun(store, runId);
		// Every attempt fails, so nothing is ever queued in the host. Once the
		// attempts are exhausted the slot must free rather than silence the run.
		const harness = installHarness({
			store,
			defaultInterval: 1,
			send: () => Promise.reject(new Error("send failed")),
		});

		harness.clock.advanceTo(STARTED_AT + MINUTE_MS);
		for (let attempt = 0; attempt < WORKFLOW_HEARTBEAT_MAX_DELIVERY_ATTEMPTS; attempt += 1) {
			await flushMicrotasks();
			harness.clock.advanceBy(1_000);
		}
		await flushMicrotasks();

		assert.equal(harness.sent.length, WORKFLOW_HEARTBEAT_MAX_DELIVERY_ATTEMPTS, "attempts are capped");
		assert.equal(harness.state.pending.size, 0, "an undelivered identity does not hold the slot");
		assert.equal(harness.state.pendingHoldExpiresAt.size, 0, "nothing is held, because nothing was admitted");
		assert.ok(
			(harness.state.scheduled.get(runId)?.scheduledAt ?? 0) > harness.clock.now(),
			"the cadence is re-armed at a future boundary",
		);
		harness.scheduler.dispose();
	});

	test("a restarted process rebuilds the identical cadence from the restored run alone", () => {
		const runId = testRunId("heartbeat-restart-durability");
		const store = createStore();
		startRun(store, runId);
		const first = installHarness({ store, defaultInterval: 1, parentSettleDelayMs: 1_000 });
		first.clock.advanceTo(STARTED_AT + 2 * MINUTE_MS + 10_000);
		assert.deepEqual(boundaries(first.sent), [STARTED_AT + MINUTE_MS, STARTED_AT + 2 * MINUTE_MS]);
		first.scheduler.dispose();

		// Restart: a brand-new store, a brand-new scheduler, and brand-new state.
		// The only thing carried across is what `persistence-restore` actually
		// restores — the run snapshot with its original `startedAt`.
		const restoredStore = createStore();
		startRun(restoredStore, runId, { startedAt: STARTED_AT });
		const restarted = installHarness({
			store: restoredStore,
			startAt: STARTED_AT + 2 * MINUTE_MS + 40_000,
			defaultInterval: 1,
			state: createWorkflowHeartbeatSchedulerState(),
			parentSettleDelayMs: 1_000,
		});

		assert.equal(
			restarted.state.scheduled.get(runId)?.scheduledAt,
			STARTED_AT + 3 * MINUTE_MS,
			"the rebuilt schedule is the next boundary on the original series",
		);
		restarted.clock.advanceTo(STARTED_AT + 4 * MINUTE_MS + 10_000);
		assert.deepEqual(
			boundaries(restarted.sent),
			[STARTED_AT + 3 * MINUTE_MS, STARTED_AT + 4 * MINUTE_MS],
			"no boundary the first process already raised is re-raised, and none is backfilled",
		);
		restarted.scheduler.dispose();
	});
});

describe("workflow heartbeat delivery", () => {
	test("a busy parent queues rather than interrupts", () => {
		const runId = testRunId("heartbeat-busy-parent");
		const store = createStore();
		startRun(store, runId, { name: "audit-auth" });
		const harness = installHarness({ store, defaultInterval: 1 });

		harness.clock.advanceTo(STARTED_AT + MINUTE_MS);
		const send = harness.sent[0];
		assert.ok(send !== undefined);
		// Exactly the lifecycle-notice options. The host-side proof that this pair
		// persists a card and queues a hidden reconciliation instead of aborting
		// the active response lives in
		// packages/coding-agent/test/suite/agent-session-message-batch.test.ts.
		assert.deepEqual(send.options, { triggerTurn: true, deliverAs: "steer", persistWhenStreaming: true });
		assert.notEqual(send.options?.deliverAs, "interrupt");
		assert.equal(send.customType, WORKFLOW_HEARTBEAT_CUSTOM_TYPE);
		assert.equal(send.display, true);
		assert.deepEqual(Object.keys(send.details).sort(), [
			"intervalMinutes",
			"runId",
			"scheduledAt",
			"startedAt",
			"workflowName",
		]);
		assert.equal(send.details.workflowName, "audit-auth");
		assert.match(send.content, /audit-auth/);
		assert.ok(send.content.includes(`/workflow status ${runId}`), "the parent is told how to inspect the run");
		harness.scheduler.dispose();
	});

	test("multiple due heartbeats process in scheduledAt order, then runId", () => {
		const store = createStore();
		const early = testRunId("heartbeat-order-early");
		const tied = [testRunId("heartbeat-order-a"), testRunId("heartbeat-order-b")].sort();
		const [tieLow, tieHigh] = [tied[0] as string, tied[1] as string];
		// The higher id is inserted first, so insertion order cannot be mistaken
		// for the id tie-break.
		startRun(store, tieHigh, { name: "tie" });
		startRun(store, tieLow, { name: "tie" });
		startRun(store, early, { name: "early", startedAt: STARTED_AT - 30_000 });
		const harness = installHarness({ store, defaultInterval: 1 });

		// One advance crosses both boundaries, so all three are due in one batch.
		harness.clock.advanceTo(STARTED_AT + MINUTE_MS);
		assert.deepEqual(runIds(harness.sent), [early, tieLow, tieHigh]);
		assert.deepEqual(boundaries(harness.sent), [STARTED_AT + 30_000, STARTED_AT + MINUTE_MS, STARTED_AT + MINUTE_MS]);
		harness.scheduler.dispose();
	});

	test("a child workflow run never heartbeats the parent chat", () => {
		const parentId = testRunId("heartbeat-parent");
		const childId = testRunId("heartbeat-child");
		const store = createStore();
		startRun(store, parentId);
		startRun(store, childId, { parentRunId: parentId });
		const harness = installHarness({ store, defaultInterval: 1 });

		harness.clock.advanceTo(STARTED_AT + MINUTE_MS);
		assert.deepEqual(runIds(harness.sent), [parentId]);
		harness.scheduler.dispose();
	});
});

describe("workflow heartbeat pause, restart, and terminal guards", () => {
	test("a paused run emits nothing and does not backfill on resume", () => {
		const runId = testRunId("heartbeat-paused");
		const store = createStore();
		startRun(store, runId);
		const harness = installHarness({ store, defaultInterval: 1 });

		store.recordRunPaused(runId, STARTED_AT + 30_000);
		harness.clock.advanceTo(STARTED_AT + 3 * MINUTE_MS + 30_000);
		assert.equal(harness.sent.length, 0, "a paused run emits nothing");
		assert.equal(harness.state.scheduled.size, 0, "a paused run holds no schedule record");

		store.recordRunResumed(runId, harness.clock.now());
		assert.equal(harness.sent.length, 0, "resuming does not backfill the three elapsed boundaries");
		harness.clock.advanceTo(STARTED_AT + 4 * MINUTE_MS);
		assert.deepEqual(boundaries(harness.sent), [STARTED_AT + 4 * MINUTE_MS], "resume takes the next boundary only");
		harness.scheduler.dispose();
	});

	test("a restarted run selects the next future boundary and never bursts missed ones", () => {
		const runId = testRunId("heartbeat-restart");
		const store = createStore();
		// The restore shape: the run's persisted start time is 3.5 intervals ago.
		const restartNow = STARTED_AT + 3 * MINUTE_MS + 30_000;
		startRun(store, runId, { startedAt: STARTED_AT });
		const harness = installHarness({ store, startAt: restartNow, defaultInterval: 1, parentSettleDelayMs: 1_000 });

		assert.equal(harness.state.scheduled.get(runId)?.scheduledAt, STARTED_AT + 4 * MINUTE_MS);
		harness.clock.advanceTo(STARTED_AT + 5 * MINUTE_MS);
		assert.deepEqual(boundaries(harness.sent), [STARTED_AT + 4 * MINUTE_MS, STARTED_AT + 5 * MINUTE_MS]);
		harness.scheduler.dispose();
	});

	test("a run that finishes before its boundary is suppressed", () => {
		const runId = testRunId("heartbeat-terminal-before-boundary");
		const store = createStore();
		startRun(store, runId);
		const harness = installHarness({ store, defaultInterval: 1 });
		assert.equal(harness.state.scheduled.size, 1, "the active run is armed");

		store.recordRunEnd(runId, "completed");
		harness.clock.advanceTo(STARTED_AT + 3 * MINUTE_MS);
		assert.equal(harness.sent.length, 0);
		assert.equal(harness.state.scheduled.size, 0);
		assert.equal(harness.clock.live().length, 0);
		harness.scheduler.dispose();
	});

	test("a run that finishes mid-batch is caught by the pre-enqueue re-read", () => {
		const store = createStore();
		const tied = [testRunId("heartbeat-midbatch-a"), testRunId("heartbeat-midbatch-b")].sort();
		const [firstId, secondId] = [tied[0] as string, tied[1] as string];
		startRun(store, firstId);
		startRun(store, secondId);
		// Delivering the first heartbeat ends the second run. The batch's
		// pre-process snapshot still shows it running, so only the independent
		// pre-enqueue read can suppress it.
		const harness = installHarness({
			store,
			defaultInterval: 1,
			send: (details) => {
				if (details.runId === firstId) store.recordRunEnd(secondId, "completed");
				return undefined;
			},
		});

		harness.clock.advanceTo(STARTED_AT + MINUTE_MS);
		assert.deepEqual(runIds(harness.sent), [firstId], "the mid-batch terminal run never heartbeats");
		harness.scheduler.dispose();
	});

	test("enqueue re-reads live status and refuses terminal, missing, and duplicate identities", () => {
		const runId = testRunId("heartbeat-enqueue-guards");
		const store = createStore();
		startRun(store, runId);
		const harness = installHarness({ store, defaultInterval: 1 });
		const details: WorkflowHeartbeatEventDetails = {
			runId,
			scheduledAt: STARTED_AT + MINUTE_MS,
			workflowName: "heartbeat-workflow",
			startedAt: STARTED_AT,
			intervalMinutes: 1,
		};

		assert.deepEqual(harness.scheduler.enqueueWorkflowHeartbeat(details), {
			kind: "enqueued",
			identity: { runId, scheduledAt: STARTED_AT + MINUTE_MS },
		});
		assert.equal(harness.sent.length, 1);
		assert.deepEqual(
			harness.scheduler.enqueueWorkflowHeartbeat(details),
			{ kind: "suppressed", reason: "duplicate" },
			"the same identity is never raised twice",
		);

		store.recordRunEnd(runId, "failed", undefined, "boom");
		assert.deepEqual(
			harness.scheduler.enqueueWorkflowHeartbeat({ ...details, scheduledAt: STARTED_AT + 2 * MINUTE_MS }),
			{ kind: "suppressed", reason: "terminal" },
		);
		assert.deepEqual(
			harness.scheduler.enqueueWorkflowHeartbeat({
				...details,
				runId: testRunId("heartbeat-absent"),
			}),
			{ kind: "suppressed", reason: "missing" },
		);
		assert.equal(harness.sent.length, 1);
		harness.scheduler.dispose();
	});

	test("a paused run is refused at enqueue even when a boundary is handed in directly", () => {
		const runId = testRunId("heartbeat-enqueue-paused");
		const store = createStore();
		startRun(store, runId);
		const harness = installHarness({ store, defaultInterval: 1 });
		store.recordRunPaused(runId, STARTED_AT + 10_000);

		assert.deepEqual(
			harness.scheduler.enqueueWorkflowHeartbeat({
				runId,
				scheduledAt: STARTED_AT + MINUTE_MS,
				workflowName: "heartbeat-workflow",
				startedAt: STARTED_AT,
				intervalMinutes: 1,
			}),
			{ kind: "suppressed", reason: "paused" },
		);
		assert.equal(harness.sent.length, 0);
		harness.scheduler.dispose();
	});

	test("a workflow whose definition is unavailable schedules nothing", () => {
		const runId = testRunId("heartbeat-unknown-definition");
		const store = createStore();
		startRun(store, runId, { name: "deleted-workflow" });
		const harness = installHarness({ store, intervals: {} });

		assert.equal(harness.state.scheduled.size, 0);
		assert.equal(harness.clock.live().length, 0);
		harness.clock.advanceBy(10 * MINUTE_MS);
		assert.equal(harness.sent.length, 0);
		harness.scheduler.dispose();
	});

	test("dispose clears the armed wake-up and stops the cadence", () => {
		const runId = testRunId("heartbeat-dispose");
		const store = createStore();
		startRun(store, runId);
		const harness = installHarness({ store, defaultInterval: 1 });
		assert.equal(harness.clock.live().length, 1);
		assert.ok(harness.clock.unrefCount > 0, "the wake-up does not hold the process open");

		harness.scheduler.dispose();
		assert.equal(harness.clock.live().length, 0, "no timer survives dispose");
		harness.clock.advanceBy(5 * MINUTE_MS);
		assert.equal(harness.sent.length, 0);
	});
});
