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
 * Scheduler state.
 *
 * The cadence itself is derived, never stored twice: a boundary is a pure
 * function of `RunSnapshot.startedAt` — a required `number`
 * (`shared/store-types.ts`) written through `workflow.run.start`
 * (`shared/persistence-session-entries.ts`) and restored verbatim on every
 * branch of `shared/persistence-restore.ts` — and the `heartbeatIntervalMinutes`
 * frozen at the authoring door. A restart recomputes the identical series.
 *
 * The durable record in `durable/workflow-heartbeat-schedule.ts` persists only
 * the last boundary raised, and is read back only as a monotone floor, so it
 * cannot move a boundary. `pending` is deliberately never persisted: after a
 * process exit the host session and its queue are gone, so re-delivering that
 * identity would backfill a missed boundary, which the spec forbids.
 */
export interface WorkflowHeartbeatSchedulerState {
	/** Next due boundary per enabled active run. At most one entry per run. */
	readonly scheduled: Map<string, WorkflowHeartbeatEventDetails>;
	/** Outstanding heartbeat per run — in flight, or admitted and awaiting pickup. */
	readonly pending: Map<string, WorkflowHeartbeatIdentity>;
	/** Runs whose heartbeat the host admitted and the parent has not picked up. */
	readonly awaitingParentPickup: Set<string>;
	/** Most recently enqueued boundary per run, so a boundary is never re-raised. */
	readonly lastEnqueuedAt: Map<string, number>;
}

export function createWorkflowHeartbeatSchedulerState(): WorkflowHeartbeatSchedulerState {
	return {
		scheduled: new Map<string, WorkflowHeartbeatEventDetails>(),
		pending: new Map<string, WorkflowHeartbeatIdentity>(),
		awaitingParentPickup: new Set<string>(),
		lastEnqueuedAt: new Map<string, number>(),
	};
}

export function resetWorkflowHeartbeatSchedulerState(state: WorkflowHeartbeatSchedulerState): void {
	state.scheduled.clear();
	state.pending.clear();
	state.awaitingParentPickup.clear();
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
	/**
	 * Whether the host reports parent availability, by routing its `agent_settled`
	 * event to `notifyParentAvailable()`.
	 *
	 * The host resolves `sendMessage` when the card is admitted into the parent's
	 * queue, not when the parent reads it. When availability is reported, an
	 * admitted heartbeat holds its slot until pickup, with no deadline — that is
	 * what "retain exactly one pending event" requires, and a deadline of any
	 * length would breach it. When it is not reported nothing could ever release
	 * the slot, so an admitted heartbeat releases it at once rather than silencing
	 * the run.
	 */
	readonly parentAvailabilityReported?: boolean;
	/** Persisted schedule floor, best-effort. Omitted disables the durable record. */
	readonly scheduleStore?: WorkflowHeartbeatScheduleStore;
	readonly state?: WorkflowHeartbeatSchedulerState;
	readonly now?: () => number;
	readonly timers?: WorkflowHeartbeatTimerApi;
}

/**
 * Durable schedule seam. Both sides are best-effort: a backend that is not ready
 * must degrade to the derived cadence rather than fail a background pass.
 */
export interface WorkflowHeartbeatScheduleStore {
	/** Last boundary durably recorded for a run, used only as a monotone floor. */
	readLastScheduledAt(runId: string): number | undefined;
	/** Persist the boundary just raised. Never called for a non-positive interval. */
	recordScheduled(record: { runId: string; scheduledAt: number; intervalMinutes: number }): void;
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
 * The arithmetic `n` is tried first, then `n + 1` for the ordinary rounding
 * case. Neither suffices for a cadence far finer than one ULP at the anchor:
 * at a real epoch anchor near `1.7e12` one ULP is about `0.000244 ms`, so a
 * `1e-9`-minute cadence (`0.00006 ms`) first lands a representable step at
 * `n = 3`. Those two probes would call an authoring-valid interval
 * unschedulable, so a bounded bracket-and-narrow finds the smallest such `n`
 * while keeping the boundary exactly on the anchored series.
 *
 * Returns `undefined` only when no finite `n` produces a representable
 * boundary — a non-positive or non-finite interval, or a cadence so fine that
 * `n` overflows before the sum moves (`Number.MIN_VALUE` minutes). Authoring
 * accepts those values, and no schedulable boundary is the narrow, non-throwing
 * answer for them.
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
	const boundaryAt = (n: number): number => startedAt + n * intervalMs;
	const elapsed = after - startedAt;
	const estimate = elapsed < 0 ? 1 : Math.floor(elapsed / intervalMs) + 1;
	if (!Number.isFinite(estimate)) return undefined;
	if (boundaryAt(estimate) > after) return finiteBoundaryAfter(boundaryAt(estimate), after);
	// Floating-point rounding can land the computed boundary exactly on or a hair
	// before `after`; step one whole interval rather than shaving the anchor.
	if (boundaryAt(estimate + 1) > after) return finiteBoundaryAfter(boundaryAt(estimate + 1), after);
	// Sub-ULP cadence. Double until the anchored multiple is representably past
	// `after`, then narrow back to the smallest one, so the boundary raised is
	// still the first on the series rather than an arbitrary later multiple.
	let low = estimate + 1;
	let high = low;
	while (boundaryAt(high) <= after) {
		low = high;
		high *= 2;
		if (!Number.isFinite(high)) return undefined;
	}
	while (high - low > 1) {
		const mid = Math.floor(low / 2 + high / 2);
		// No integer strictly between them is representable at this magnitude.
		if (mid <= low || mid >= high) break;
		if (boundaryAt(mid) > after) high = mid;
		else low = mid;
	}
	return finiteBoundaryAfter(boundaryAt(high), after);
}

function finiteBoundaryAfter(scheduledAt: number, after: number): number | undefined {
	return Number.isFinite(scheduledAt) && scheduledAt > after ? scheduledAt : undefined;
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
	const parentAvailabilityReported = options.parentAvailabilityReported === true;
	const scheduleStore = options.scheduleStore;
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
				state.awaitingParentPickup.delete(details.runId);
				refresh();
				return;
			}
			if (!parentAvailabilityReported) {
				// This host reports no pickup signal, so nothing could ever release a
				// held slot. Releasing on admission is the only choice that keeps the
				// run heartbeating at all.
				state.pending.delete(details.runId);
				refresh();
				return;
			}
			// The host resolves `sendMessage` once the card is admitted into the
			// parent's queue, not once the parent reads it. Releasing the slot here
			// would let the next boundary stack a second card behind the first, so
			// the slot is held — with no deadline — until the parent reports picking
			// it up. The cadence pauses rather than stacking.
			state.awaitingParentPickup.add(details.runId);
			refresh();
		},
	});

	const notifyParentAvailable = (): void => {
		if (!active || state.awaitingParentPickup.size === 0) return;
		for (const runId of [...state.awaitingParentPickup]) {
			state.awaitingParentPickup.delete(runId);
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
		// boundaries are skipped rather than replayed. The durable record only
		// raises that floor to a boundary already raised in an earlier process,
		// and a restored value is always in the past, so it can suppress a repeat
		// but can never move a boundary.
		const floor = Math.max(now(), lastEnqueuedFloor(run.id));
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
		if (lastEnqueuedFloor(payload.runId) >= payload.scheduledAt) {
			return { kind: "suppressed", reason: "duplicate" };
		}
		const identity: WorkflowHeartbeatIdentity = { runId: payload.runId, scheduledAt: payload.scheduledAt };
		state.pending.set(payload.runId, identity);
		state.lastEnqueuedAt.set(payload.runId, payload.scheduledAt);
		// Best-effort durable schedule record: one per run, only for a positive
		// interval, carrying the boundary just raised. The seam is declared
		// best-effort, so a store that fails degrades to the derived cadence here
		// rather than at every call site.
		try {
			scheduleStore?.recordScheduled({
				runId: payload.runId,
				scheduledAt: payload.scheduledAt,
				intervalMinutes: payload.intervalMinutes,
			});
		} catch {
			// A durable backend that is not ready must not stop a heartbeat.
		}
		delivery.deliver(payload);
		return { kind: "enqueued", identity };
	};

	const arm = (): void => {
		if (timerHandle !== undefined) {
			timers.clearTimeout(timerHandle);
			timerHandle = undefined;
		}
		if (!active) return;
		// One globally-next-due wake-up, not one recurring timer per run.
		const next = earliestScheduled(state);
		if (next === undefined) return;
		const nextAt = next.scheduledAt;
		// A held slot has no deadline, so it contributes no wake-up of its own.
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

	/**
	 * Floor for the next boundary of a run: the last boundary this process
	 * raised, or the durably recorded one when this process has raised none yet.
	 * Always in the past, so it can only ever suppress an already-raised
	 * boundary — never move one.
	 */
	function lastEnqueuedFloor(runId: string): number {
		const local = state.lastEnqueuedAt.get(runId);
		if (local !== undefined) return local;
		try {
			return scheduleStore?.readLastScheduledAt(runId) ?? Number.NEGATIVE_INFINITY;
		} catch {
			// A durable backend that is not ready falls back to the derived cadence.
			return Number.NEGATIVE_INFINITY;
		}
	}

	const processDue = (): void => {
		if (!active) return;
		const at = now();
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

function earliestScheduled(state: WorkflowHeartbeatSchedulerState): WorkflowHeartbeatEventDetails | undefined {
	let earliest: WorkflowHeartbeatEventDetails | undefined;
	for (const details of state.scheduled.values()) {
		if (earliest === undefined || compareWorkflowHeartbeatOrder(details, earliest) < 0) earliest = details;
	}
	return earliest;
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
