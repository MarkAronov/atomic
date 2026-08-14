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
 * The cadence is derived, never stored twice: a boundary is a pure function of
 * the run's original start time and the `heartbeatIntervalMinutes` frozen at the
 * authoring door. Session restore already preserves the start time verbatim
 * (`shared/persistence-restore.ts`).
 *
 * One durable record exists, and only because one input is genuinely not
 * derivable: a durable resume re-dispatches under the original workflow id but
 * mints a fresh `RunSnapshot.startedAt`, so the original start survives nowhere
 * else. `durable/workflow-heartbeat-anchor.ts` carries it, write-once, and is
 * read as `min(run.startedAt, anchorAt)` — it can only restore the original
 * anchor, never advance it.
 *
 * `pending` is deliberately never persisted: after a process exit the host
 * session and its queue are gone, so re-delivering that identity would backfill
 * a missed boundary, which the spec forbids.
 */
export interface WorkflowHeartbeatSchedulerState {
	/** Next due boundary per enabled active run. At most one entry per run. */
	readonly scheduled: Map<string, WorkflowHeartbeatEventDetails>;
	/** Outstanding heartbeat per run — in flight, or admitted and awaiting pickup. */
	readonly pending: Map<string, WorkflowHeartbeatIdentity>;
	/** Content of each admitted heartbeat the parent has not consumed yet, by run. */
	readonly awaitingParentPickup: Map<string, string>;
	/** Most recently enqueued boundary per run, so a boundary is never re-raised. */
	readonly lastEnqueuedAt: Map<string, number>;
	/** Resolved cadence anchor per run, memoized after its first durable read. */
	readonly anchorAt: Map<string, number>;
	/** Runs whose cadence anchor is already persisted, so the write stops retrying. */
	readonly anchorPersisted: Set<string>;
	/**
	 * Cadence each run launched with, captured the first time it resolved.
	 *
	 * An in-flight run keeps the interval its own definition was authored with.
	 * Re-reading the live registry every pass would let a mid-run `/workflow
	 * reload`, rename, edit, or delete change or stop an already-enabled run —
	 * and nothing else in the system lets a reload reach a run in flight, because
	 * the executor closes over its own definition for the life of the run.
	 */
	readonly intervalMinutes: Map<string, number>;
}

export function createWorkflowHeartbeatSchedulerState(): WorkflowHeartbeatSchedulerState {
	return {
		scheduled: new Map<string, WorkflowHeartbeatEventDetails>(),
		pending: new Map<string, WorkflowHeartbeatIdentity>(),
		awaitingParentPickup: new Map<string, string>(),
		lastEnqueuedAt: new Map<string, number>(),
		anchorAt: new Map<string, number>(),
		anchorPersisted: new Set<string>(),
		intervalMinutes: new Map<string, number>(),
	};
}

export function resetWorkflowHeartbeatSchedulerState(state: WorkflowHeartbeatSchedulerState): void {
	state.scheduled.clear();
	state.pending.clear();
	state.awaitingParentPickup.clear();
	state.lastEnqueuedAt.clear();
	state.anchorAt.clear();
	state.anchorPersisted.clear();
	state.intervalMinutes.clear();
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
	 * Whether the host reports heartbeat consumption, by routing its `message_end`
	 * event to `notifyHeartbeatConsumed()`.
	 *
	 * The host resolves `sendMessage` when the card is admitted into the parent's
	 * queue, not when the parent reads it. When consumption is reported, an
	 * admitted heartbeat holds its slot until the card is actually injected into
	 * the conversation, with no deadline — that is what "retain exactly one
	 * pending event" requires, and a deadline of any length would breach it. When
	 * it is not reported nothing could ever release the slot, so an admitted
	 * heartbeat releases it at once rather than silencing the run.
	 */
	readonly parentAvailabilityReported?: boolean;
	/** Persisted cadence anchor, best-effort. Omitted disables the durable record. */
	readonly anchorStore?: WorkflowHeartbeatAnchorStore;
	readonly state?: WorkflowHeartbeatSchedulerState;
	readonly now?: () => number;
	readonly timers?: WorkflowHeartbeatTimerApi;
}

/**
 * Durable cadence-anchor seam. Both sides are best-effort: a backend that is not
 * ready must degrade to the run's own `startedAt` rather than fail a background
 * pass.
 */
export interface WorkflowHeartbeatAnchorStore {
	/** The run's persisted original start time, when one was recorded. */
	readAnchorAt(runId: string): number | undefined;
	/**
	 * Persist the run's cadence anchor. Write-once; later calls are no-ops.
	 * Returns whether the anchor is durably readable afterwards, so the caller can
	 * stop retrying.
	 */
	recordAnchorAt(runId: string, anchorAt: number): boolean;
}

export interface WorkflowHeartbeatScheduler {
	/** Maintain at most one next-due heartbeat schedule for one enabled active run. */
	scheduleWorkflowHeartbeats(run: WorkflowHeartbeatRun, intervalMinutes: number): WorkflowHeartbeatScheduleResult;
	/** Queue one due heartbeat for the parent chat without interrupting it. */
	enqueueWorkflowHeartbeat(payload: WorkflowHeartbeatEventDetails): WorkflowHeartbeatEnqueueResult;
	/**
	 * The parent chat consumed a heartbeat card: the host injected it into the
	 * conversation. Releases that run's held slot and re-arms it at its first
	 * future boundary — never at a missed one.
	 *
	 * Consumption, not turn completion, is the release condition. The host emits
	 * its turn-settled event even when a paused queue held the card back, so
	 * releasing on that would let a second card stack behind a parked first one.
	 */
	notifyHeartbeatConsumed(content: string): void;
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
	const anchorStore = options.anchorStore;
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
				// This host reports no consumption signal, so nothing could ever
				// release a held slot. Releasing on admission is the only choice that
				// keeps the run heartbeating at all.
				state.pending.delete(details.runId);
				refresh();
				return;
			}
			// The host resolves `sendMessage` once the card is admitted into the
			// parent's queue, not once the parent reads it — and its turn-settled
			// event fires even when a paused queue held the card back. Releasing on
			// either would let the next boundary stack a second card behind the
			// first, so the slot is held — with no deadline — until the card is
			// actually consumed into the conversation. The cadence pauses rather
			// than stacking.
			//
			// The match key is the exact text this scheduler authored: the host's
			// hidden reconciliation copies `content` verbatim, and the visible card
			// never reaches extensions at all, so there is no admission/consumption
			// ambiguity to disambiguate.
			state.awaitingParentPickup.set(details.runId, formatWorkflowHeartbeatNoticeText(details));
			refresh();
		},
	});

	const notifyHeartbeatConsumed = (content: string): void => {
		if (!active || state.awaitingParentPickup.size === 0) return;
		let released = false;
		for (const [runId, held] of [...state.awaitingParentPickup]) {
			if (held !== content) continue;
			state.awaitingParentPickup.delete(runId);
			state.pending.delete(runId);
			released = true;
		}
		if (!released) return;
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
		const anchorAt = resolveAnchorAt(run);
		const scheduledAt = nextWorkflowHeartbeatBoundary(anchorAt, intervalMinutes, floor);
		if (scheduledAt === undefined) return { kind: "disabled" };
		// Persist the cadence anchor here rather than at the first delivery. A run
		// that gains durable progress and then pauses, quits, or crashes before its
		// first boundary would otherwise have no record, and a durable resume —
		// which reclaims the original run id but remints `startedAt` — would put it
		// on a fresh series. The write is a no-op until the run has durable progress
		// of its own, and any such progress bumps the store, so this runs on the
		// first refresh after the run becomes resumable.
		persistAnchorOnce(run.id, anchorAt);
		state.scheduled.set(run.id, {
			runId: run.id,
			scheduledAt,
			workflowName: run.name,
			// The anchor, not the snapshot's own `startedAt`: after a durable
			// resume those differ, and the payload must stay consistent with the
			// series the boundary came from.
			startedAt: anchorAt,
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
			// An entry that already came due is owed and is kept as it is. Re-deriving
			// it here would floor at `now` and silently advance it to the following
			// boundary, so any ordinary store mutation landing between a boundary and
			// its armed callback would drop that heartbeat. A sticky entry carries the
			// `intervalMinutes` captured when it was derived, so a workflow reload in
			// that window does not retro-fit a new cadence onto an owed boundary.
			const owed = state.scheduled.get(run.id);
			if (owed !== undefined && owed.scheduledAt <= now()) continue;
			const intervalMinutes = resolveRunIntervalMinutes(state, options.resolveIntervalMinutes, run);
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
	 * The run's cadence anchor: its original start time. A durable resume mints a
	 * fresh `RunSnapshot.startedAt` under the original workflow id, so the
	 * persisted anchor is what keeps the resumed run on its original series.
	 * Taking the minimum means the record can only restore the original anchor,
	 * never advance it.
	 *
	 * A failed-run continuation legitimately starts a new series: it carries a
	 * fresh run id, and the slice-1 identity is `runId + scheduledAt`, so it is a
	 * different run and reads no anchor of its own.
	 */
	function resolveAnchorAt(run: WorkflowHeartbeatRun): number {
		const cached = state.anchorAt.get(run.id);
		if (cached !== undefined) return Math.min(cached, run.startedAt);
		let stored: number | undefined;
		try {
			stored = anchorStore?.readAnchorAt(run.id);
		} catch {
			// A durable backend that is not ready falls back to the live start time.
			stored = undefined;
		}
		const anchorAt = stored === undefined ? run.startedAt : Math.min(stored, run.startedAt);
		state.anchorAt.set(run.id, anchorAt);
		return anchorAt;
	}

	/**
	 * Write the run's cadence anchor at most once per process, best-effort.
	 *
	 * `recordAnchorAt` is itself a no-op until the run has durable progress of its
	 * own, so this is called on every schedule pass until it succeeds and then
	 * never again. Bounding it matters because a schedule pass runs on every store
	 * invalidation for every running run.
	 */
	function persistAnchorOnce(runId: string, anchorAt: number): void {
		if (anchorStore === undefined || state.anchorPersisted.has(runId)) return;
		try {
			if (anchorStore.recordAnchorAt(runId, anchorAt)) state.anchorPersisted.add(runId);
		} catch {
			// A durable backend that is not ready must not stop a heartbeat; the
			// next pass retries.
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
		notifyHeartbeatConsumed,
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

/**
 * The cadence for a run: the one it launched with, resolved from its definition
 * the first time and memoized thereafter.
 *
 * Only a successful resolution memoizes, so a run observed during startup
 * warmup — before discovery has finished — picks its cadence up on a later pass
 * rather than being frozen as unresolvable. Once resolved, a `/workflow reload`,
 * rename, edit, or delete cannot change or stop that run.
 */
function resolveRunIntervalMinutes(
	state: WorkflowHeartbeatSchedulerState,
	resolve: (workflowName: string) => number | undefined,
	run: WorkflowHeartbeatRun,
): number | undefined {
	const memoized = state.intervalMinutes.get(run.id);
	if (memoized !== undefined) return memoized;
	const intervalMinutes = resolve(run.name);
	if (intervalMinutes === undefined) return undefined;
	// The authoring door already rejected negative and non-finite values; a
	// definition that is missing, unreadable, or disabled schedules nothing rather
	// than failing a background pass. Those two cases are indistinguishable here,
	// which is why editing a live workflow from a positive cadence to `0` leaves
	// an in-flight run on its launch cadence.
	if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) return undefined;
	state.intervalMinutes.set(run.id, intervalMinutes);
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

/**
 * The text of a consumed custom message, narrowed from an untyped host
 * `message_end` payload.
 *
 * The workflows-side `on` handler is typed `(event?: unknown, ctx?) => unknown`,
 * so the payload is narrowed here rather than cast. Both the string and the
 * normalized part-array content shapes are accepted, because the host may have
 * normalized the message before it is injected.
 */
export function workflowHeartbeatConsumedContent(event: unknown): string | undefined {
	if (typeof event !== "object" || event === null) return undefined;
	const message = (event as { message?: unknown }).message;
	if (typeof message !== "object" || message === null) return undefined;
	const candidate = message as { role?: unknown; content?: unknown };
	if (candidate.role !== "custom") return undefined;
	if (typeof candidate.content === "string") return candidate.content;
	if (!Array.isArray(candidate.content)) return undefined;
	let text = "";
	for (const part of candidate.content) {
		if (typeof part !== "object" || part === null) continue;
		const piece = part as { type?: unknown; text?: unknown };
		if (piece.type === "text" && typeof piece.text === "string") text += piece.text;
	}
	return text.length === 0 ? undefined : text;
}
