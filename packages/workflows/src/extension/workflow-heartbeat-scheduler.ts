import { effectiveRunStatus } from "../shared/returned-run-status.js";
import { isTopLevelWorkflowRun } from "../shared/run-visibility.js";
import type { Store } from "../shared/store.js";
import { isTerminalRunStatus } from "../shared/store-internal.js";
import { readGraphStoreSnapshot, subscribeStoreInvalidation } from "../shared/store-observation.js";
import type { RunSnapshot, StoreSnapshot } from "../shared/store-types.js";
import {
	WORKFLOW_HEARTBEAT_CUSTOM_TYPE,
	type WorkflowHeartbeatEventDetails,
	type WorkflowHeartbeatIdentity,
} from "../shared/workflow-heartbeat-contract.js";
import type { ExtensionAPI } from "./index.js";
import {
	createWorkflowHeartbeatDelivery,
	defaultWorkflowHeartbeatTimerApi,
	type WorkflowHeartbeatTimerApi,
	type WorkflowHeartbeatTimerHandle,
} from "./workflow-heartbeat-delivery.js";
import { formatWorkflowHeartbeatNoticeText } from "./workflow-heartbeat-notice.js";

/**
 * Longest delay a host timer accepts before it overflows to a 1 ms fire. A
 * boundary further out than this is armed in one clamped hop; the wake-up finds
 * nothing due and re-arms for the remainder.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const MS_PER_MINUTE = 60_000;

/** Minimal run shape the schedule door reads. */
export type WorkflowHeartbeatRun = Pick<RunSnapshot, "id" | "name" | "startedAt" | "status">;

export interface WorkflowHeartbeatScheduleDisabled {
	readonly kind: "disabled";
}

export interface WorkflowHeartbeatScheduleScheduled {
	readonly kind: "scheduled";
	readonly scheduledAt: number;
}

export type WorkflowHeartbeatScheduleResult = WorkflowHeartbeatScheduleDisabled | WorkflowHeartbeatScheduleScheduled;

export type WorkflowHeartbeatSuppressionReason = "missing" | "terminal" | "paused" | "duplicate" | "unavailable";

export interface WorkflowHeartbeatEnqueued {
	readonly kind: "enqueued";
	readonly identity: WorkflowHeartbeatIdentity;
}

export interface WorkflowHeartbeatSuppressed {
	readonly kind: "suppressed";
	readonly reason: WorkflowHeartbeatSuppressionReason;
}

export type WorkflowHeartbeatEnqueueResult = WorkflowHeartbeatEnqueued | WorkflowHeartbeatSuppressed;

/**
 * Attempts a held pending slot survives, expressed in cadence intervals, when
 * the parent never reports becoming available again. The host resolves
 * `sendMessage` on *admission*, so a settled send only proves the card reached
 * the parent's queue, not that the parent read it; the slot is therefore held
 * until `notifyParentAvailable()` fires. Without a cap, a host that never
 * reports settling would silence a run forever. With it, the worst case
 * degrades to one extra queued heartbeat rather than silence.
 */
export const WORKFLOW_HEARTBEAT_MAX_PENDING_HOLD_INTERVALS = 1;

/**
 * Derived scheduler state. There is deliberately no separate durable schedule
 * record, because every input it would hold is already persisted and restored
 * by an existing authority:
 *
 * - the anchor is `RunSnapshot.startedAt`, a required `number`
 *   (`shared/store-types.ts`) written through `workflow.run.start`
 *   (`shared/persistence-session-entries.ts`) and restored verbatim on every
 *   branch of `shared/persistence-restore.ts` as `startedAt: run.startTs`;
 * - the cadence is `heartbeatIntervalMinutes`, validated and frozen at the
 *   authoring door (`authoring/workflow.ts`).
 *
 * A boundary is a pure function of those two, so a restart recomputes the
 * identical series and picks the first future boundary on it. A stored copy
 * would be the parallel source of truth the objective forbids, and would need
 * the queued-event invalidation the spec assigns to slice 3. Restoring
 * `pending` across a process exit would be worse than useless: the host session
 * and its queue are gone, so re-delivering would backfill a missed boundary,
 * which the spec forbids.
 */
export interface WorkflowHeartbeatSchedulerState {
	/** Next due boundary per enabled active run. At most one entry per run. */
	readonly scheduled: Map<string, WorkflowHeartbeatEventDetails>;
	/** Outstanding heartbeat per run — in flight, or admitted and awaiting pickup. */
	readonly pending: Map<string, WorkflowHeartbeatIdentity>;
	/** When an admitted-but-unpicked-up pending slot is released regardless. */
	readonly pendingHoldExpiresAt: Map<string, number>;
	/** Most recently enqueued boundary per run, so a boundary is never re-raised. */
	readonly lastEnqueuedAt: Map<string, number>;
}

export function createWorkflowHeartbeatSchedulerState(): WorkflowHeartbeatSchedulerState {
	return {
		scheduled: new Map<string, WorkflowHeartbeatEventDetails>(),
		pending: new Map<string, WorkflowHeartbeatIdentity>(),
		pendingHoldExpiresAt: new Map<string, number>(),
		lastEnqueuedAt: new Map<string, number>(),
	};
}

export function resetWorkflowHeartbeatSchedulerState(state: WorkflowHeartbeatSchedulerState): void {
	state.scheduled.clear();
	state.pending.clear();
	state.pendingHoldExpiresAt.clear();
	state.lastEnqueuedAt.clear();
}

export interface WorkflowHeartbeatSchedulerOptions {
	readonly store: Store;
	readonly sendMessage?: ExtensionAPI["sendMessage"];
	/**
	 * Resolved cadence for a workflow name, read from the compiled definition.
	 * `undefined` means the definition is not available, which schedules nothing.
	 */
	readonly resolveIntervalMinutes: (workflowName: string) => number | undefined;
	readonly state?: WorkflowHeartbeatSchedulerState;
	readonly now?: () => number;
	readonly timers?: WorkflowHeartbeatTimerApi;
}

export interface WorkflowHeartbeatScheduler {
	/** Maintain at most one next-due heartbeat schedule for one enabled active run. */
	scheduleWorkflowHeartbeats(run: WorkflowHeartbeatRun, intervalMinutes: number): WorkflowHeartbeatScheduleResult;
	/** Queue one due heartbeat for the parent chat without interrupting it. */
	enqueueWorkflowHeartbeat(payload: WorkflowHeartbeatEventDetails): WorkflowHeartbeatEnqueueResult;
	/**
	 * The parent chat finished a turn and drained its queued messages, so an
	 * admitted heartbeat has been picked up. Releases every held pending slot and
	 * re-arms each run at its first future boundary — never at a missed one.
	 */
	notifyParentAvailable(): void;
	readonly state: WorkflowHeartbeatSchedulerState;
	dispose(): void;
}

/**
 * First cadence boundary strictly after `after`, on the `startedAt + n × I`
 * series. Never derived from a previous delivery, so a retry, a pause, or a
 * process restart cannot shift the cadence.
 *
 * Returns `undefined` when no finite boundary exists — a non-positive or
 * non-finite interval, and the denormal-interval case where `n` overflows.
 * Authoring accepts `Number.MIN_VALUE` minutes, and no schedulable boundary is
 * the narrow, non-throwing answer for it.
 */
export function nextWorkflowHeartbeatBoundary(
	startedAt: number,
	intervalMinutes: number,
	after: number,
): number | undefined {
	if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) return undefined;
	if (!Number.isFinite(startedAt) || !Number.isFinite(after)) return undefined;
	const intervalMs = intervalMinutes * MS_PER_MINUTE;
	if (!Number.isFinite(intervalMs) || intervalMs <= 0) return undefined;
	const elapsed = after - startedAt;
	const n = elapsed < 0 ? 1 : Math.floor(elapsed / intervalMs) + 1;
	if (!Number.isFinite(n)) return undefined;
	let scheduledAt = startedAt + n * intervalMs;
	// Floating-point rounding can land the computed boundary exactly on or a hair
	// before `after`; step one whole interval rather than shaving the anchor.
	if (scheduledAt <= after) scheduledAt = startedAt + (n + 1) * intervalMs;
	if (!Number.isFinite(scheduledAt) || scheduledAt <= after) return undefined;
	return scheduledAt;
}

/**
 * Whether a run may hold a heartbeat schedule right now. Reuses the store's own
 * status authorities rather than restating them: `isTopLevelWorkflowRun` keeps
 * nested workflow runs from heartbeating the parent chat, and
 * `isTerminalRunStatus(effectiveRunStatus(run))` is the same terminal reading
 * lifecycle notices use, which also treats an actively blocked run as not
 * progressing.
 */
export function isWorkflowHeartbeatEligibleRun(run: RunSnapshot): boolean {
	if (!isTopLevelWorkflowRun(run)) return false;
	if (run.status !== "running") return false;
	if (run.pausedAt !== undefined) return false;
	return !isTerminalRunStatus(effectiveRunStatus(run));
}

export function installWorkflowHeartbeatScheduler(
	options: WorkflowHeartbeatSchedulerOptions,
): WorkflowHeartbeatScheduler {
	const state = options.state ?? createWorkflowHeartbeatSchedulerState();
	const now = options.now ?? Date.now;
	const timers = options.timers ?? defaultWorkflowHeartbeatTimerApi;
	const send = options.sendMessage;
	let active = true;
	let timerHandle: WorkflowHeartbeatTimerHandle | undefined;

	const emit = (details: WorkflowHeartbeatEventDetails): boolean | Promise<boolean> => {
		if (typeof send !== "function") return false;
		try {
			const result = send(
				{
					customType: WORKFLOW_HEARTBEAT_CUSTOM_TYPE,
					content: formatWorkflowHeartbeatNoticeText(details),
					display: true,
					details,
				},
				// Identical to the lifecycle notice options: the parent's active
				// response is never aborted; the steer waits for the next
				// protocol-safe boundary and is persisted meanwhile.
				{ triggerTurn: true, deliverAs: "steer", persistWhenStreaming: true },
			);
			if (result === undefined) return true;
			return Promise.resolve(result).then(
				() => true,
				(error: unknown) => {
					warnWorkflowHeartbeatSendFailure(error);
					return false;
				},
			);
		} catch (error) {
			warnWorkflowHeartbeatSendFailure(error);
			return false;
		}
	};

	/**
	 * Live re-check taken before every attempt, retries included. The two
	 * objective-named guards are the pre-process batch read and the pre-enqueue
	 * read; this one keeps the second guard true across the retry window, where
	 * the run could otherwise reach a terminal state between attempt 1 and
	 * attempt 5 and still be sent. Invalidating a heartbeat the host has already
	 * admitted into its queue is slice 3's door (issue #1975), and no public host
	 * seam exposes it.
	 */
	const canDeliverWorkflowHeartbeat = (details: WorkflowHeartbeatEventDetails): boolean => {
		const run = findRun(readGraphStoreSnapshot(options.store), details.runId);
		return run !== undefined && isWorkflowHeartbeatEligibleRun(run);
	};

	const delivery = createWorkflowHeartbeatDelivery({
		emit,
		timers,
		canDeliver: canDeliverWorkflowHeartbeat,
		onSettled: (details, delivered) => {
			if (state.pending.get(details.runId)?.scheduledAt !== details.scheduledAt) return;
			if (!delivered) {
				// Nothing reached the parent's queue, so the slot is free at once.
				state.pending.delete(details.runId);
				state.pendingHoldExpiresAt.delete(details.runId);
				refresh();
				return;
			}
			// The host resolves `sendMessage` once the card is admitted into the
			// parent's queue, not once the parent reads it. Releasing the slot here
			// would let the next boundary stack a second heartbeat behind the first,
			// so the slot is held until `notifyParentAvailable()`, capped so a host
			// that never reports settling degrades to one extra queued card rather
			// than permanent silence.
			state.pendingHoldExpiresAt.set(details.runId, workflowHeartbeatHoldExpiry(details, now()));
			refresh();
		},
	});

	const notifyParentAvailable = (): void => {
		if (!active || state.pendingHoldExpiresAt.size === 0) return;
		for (const runId of [...state.pendingHoldExpiresAt.keys()]) {
			state.pendingHoldExpiresAt.delete(runId);
			state.pending.delete(runId);
		}
		// `refresh()` re-arms from `max(now, lastEnqueuedAt)`, so the cadence
		// resumes at the first future boundary and never at a missed one.
		refresh();
	};

	const scheduleWorkflowHeartbeats = (
		run: WorkflowHeartbeatRun,
		intervalMinutes: number,
	): WorkflowHeartbeatScheduleResult => {
		state.scheduled.delete(run.id);
		// A resolved interval of 0 creates no timer and no schedule record at all.
		if (intervalMinutes <= 0) return { kind: "disabled" };
		if (run.status !== "running") return { kind: "disabled" };
		// Recovery and resume both land here: the floor is `now`, so missed
		// boundaries are skipped rather than replayed.
		const floor = Math.max(now(), state.lastEnqueuedAt.get(run.id) ?? Number.NEGATIVE_INFINITY);
		const scheduledAt = nextWorkflowHeartbeatBoundary(run.startedAt, intervalMinutes, floor);
		if (scheduledAt === undefined) return { kind: "disabled" };
		state.scheduled.set(run.id, {
			runId: run.id,
			scheduledAt,
			workflowName: run.name,
			startedAt: run.startedAt,
			intervalMinutes,
		});
		return { kind: "scheduled", scheduledAt };
	};

	const enqueueWorkflowHeartbeat = (payload: WorkflowHeartbeatEventDetails): WorkflowHeartbeatEnqueueResult => {
		if (!active || typeof send !== "function") return { kind: "suppressed", reason: "unavailable" };
		// Pre-enqueue guard: an independent read of live status, so a run that
		// finished between the processing batch and this call is suppressed.
		const run = findRun(readGraphStoreSnapshot(options.store), payload.runId);
		if (run === undefined) return { kind: "suppressed", reason: "missing" };
		if (isTerminalRunStatus(effectiveRunStatus(run))) return { kind: "suppressed", reason: "terminal" };
		if (!isWorkflowHeartbeatEligibleRun(run)) return { kind: "suppressed", reason: "paused" };
		// One pending event per run, and the oldest one wins: a newer boundary is
		// not enqueued while an identity is still in flight.
		if (state.pending.has(payload.runId)) return { kind: "suppressed", reason: "duplicate" };
		if ((state.lastEnqueuedAt.get(payload.runId) ?? Number.NEGATIVE_INFINITY) >= payload.scheduledAt) {
			return { kind: "suppressed", reason: "duplicate" };
		}
		const identity: WorkflowHeartbeatIdentity = { runId: payload.runId, scheduledAt: payload.scheduledAt };
		state.pending.set(payload.runId, identity);
		state.lastEnqueuedAt.set(payload.runId, payload.scheduledAt);
		delivery.deliver(payload);
		return { kind: "enqueued", identity };
	};

	const arm = (): void => {
		if (timerHandle !== undefined) {
			timers.clearTimeout(timerHandle);
			timerHandle = undefined;
		}
		if (!active) return;
		// One globally-next-due wake-up covers both kinds of deadline: the next
		// cadence boundary and the next held-slot expiry.
		const nextAt = nextWorkflowHeartbeatWakeUp(state);
		if (nextAt === undefined) return;
		// One globally-next-due wake-up, not one recurring timer per run.
		const delay = Math.min(Math.max(1, Math.ceil(nextAt - now())), MAX_TIMER_DELAY_MS);
		const handle = timers.setTimeout(() => {
			timerHandle = undefined;
			processDue();
		}, delay);
		handle.unref?.();
		timerHandle = handle;
	};

	const refresh = (): void => {
		if (!active || typeof send !== "function") return;
		const snapshot = readGraphStoreSnapshot(options.store);
		const observed = new Set<string>();
		for (const run of snapshot.runs) {
			if (!isTopLevelWorkflowRun(run)) continue;
			observed.add(run.id);
			if (state.pending.has(run.id) || !isWorkflowHeartbeatEligibleRun(run)) {
				state.scheduled.delete(run.id);
				continue;
			}
			const intervalMinutes = resolveRunIntervalMinutes(options.resolveIntervalMinutes, run.name);
			if (intervalMinutes === undefined) {
				state.scheduled.delete(run.id);
				continue;
			}
			scheduleWorkflowHeartbeats(run, intervalMinutes);
		}
		for (const runId of [...state.scheduled.keys()]) {
			if (!observed.has(runId)) state.scheduled.delete(runId);
		}
		// Slice 3 owns terminal cleanup and restart-recovery invalidation
		// (issue #1975): a terminal run simply stops producing a schedule entry
		// here, and no cleanup door is installed by this slice.
		arm();
	};

	const processDue = (): void => {
		if (!active) return;
		const at = now();
		// A held slot whose cap has elapsed is released first, so the cadence
		// resumes in the same pass rather than waiting for another wake-up.
		for (const [runId, expiresAt] of [...state.pendingHoldExpiresAt]) {
			if (expiresAt > at) continue;
			state.pendingHoldExpiresAt.delete(runId);
			state.pending.delete(runId);
		}
		const due = [...state.scheduled.values()]
			.filter((details) => details.scheduledAt <= at)
			.sort(compareWorkflowHeartbeatOrder);
		// Pre-process guard: live status read taken immediately before the batch,
		// separate from the per-enqueue read below.
		const snapshot = readGraphStoreSnapshot(options.store);
		for (const details of due) {
			state.scheduled.delete(details.runId);
			const run = findRun(snapshot, details.runId);
			if (run === undefined || !isWorkflowHeartbeatEligibleRun(run)) continue;
			enqueueWorkflowHeartbeat(details);
		}
		refresh();
	};

	const unsubscribe = subscribeStoreInvalidation(options.store, refresh);
	refresh();

	return {
		scheduleWorkflowHeartbeats,
		enqueueWorkflowHeartbeat,
		notifyParentAvailable,
		state,
		dispose() {
			active = false;
			unsubscribe();
			if (timerHandle !== undefined) {
				timers.clearTimeout(timerHandle);
				timerHandle = undefined;
			}
			state.scheduled.clear();
			delivery.dispose();
		},
	};
}

/** Due heartbeats process in `scheduledAt` order, with `runId` as the stable tie-break. */
export function compareWorkflowHeartbeatOrder(a: WorkflowHeartbeatIdentity, b: WorkflowHeartbeatIdentity): number {
	if (a.scheduledAt !== b.scheduledAt) return a.scheduledAt - b.scheduledAt;
	if (a.runId === b.runId) return 0;
	return a.runId < b.runId ? -1 : 1;
}

/**
 * The single next deadline the scheduler must wake for: the earliest cadence
 * boundary, or the earliest held-slot expiry, whichever comes first.
 */
function nextWorkflowHeartbeatWakeUp(state: WorkflowHeartbeatSchedulerState): number | undefined {
	let earliest: WorkflowHeartbeatEventDetails | undefined;
	for (const details of state.scheduled.values()) {
		if (earliest === undefined || compareWorkflowHeartbeatOrder(details, earliest) < 0) earliest = details;
	}
	let nextAt = earliest?.scheduledAt;
	for (const expiresAt of state.pendingHoldExpiresAt.values()) {
		if (nextAt === undefined || expiresAt < nextAt) nextAt = expiresAt;
	}
	return nextAt;
}

/**
 * When an admitted heartbeat's pending slot is released even though the parent
 * never reported becoming available. One cadence interval, so the cap scales
 * with the workflow's own cadence rather than with a fixed wall-clock guess.
 */
function workflowHeartbeatHoldExpiry(details: WorkflowHeartbeatEventDetails, at: number): number {
	const holdMs = details.intervalMinutes * MS_PER_MINUTE * WORKFLOW_HEARTBEAT_MAX_PENDING_HOLD_INTERVALS;
	if (!Number.isFinite(holdMs) || holdMs <= 0) return at;
	return at + holdMs;
}

function resolveRunIntervalMinutes(
	resolve: (workflowName: string) => number | undefined,
	workflowName: string,
): number | undefined {
	const intervalMinutes = resolve(workflowName);
	if (intervalMinutes === undefined) return undefined;
	// The authoring door already rejected negative and non-finite values; a
	// definition that is missing or unreadable schedules nothing rather than
	// failing a background pass.
	if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) return undefined;
	return intervalMinutes;
}

function findRun(snapshot: StoreSnapshot, runId: string): RunSnapshot | undefined {
	return snapshot.runs.find((run) => run.id === runId);
}

function warnWorkflowHeartbeatSendFailure(error: unknown): void {
	if (process.env.ATOMIC_WORKFLOW_DEBUG !== "1") return;
	const message = error instanceof Error ? error.message : String(error);
	console.warn("[workflows] workflow heartbeat send failed", message);
}
