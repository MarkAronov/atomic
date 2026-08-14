import type { WorkflowHeartbeatEventDetails } from "../shared/workflow-heartbeat-contract.js";

/** Timer seam so the scheduler and its retries are testable without real waiting. */
export interface WorkflowHeartbeatTimerHandle {
	unref?: () => void;
}

export interface WorkflowHeartbeatTimerApi {
	setTimeout(handler: () => void, delayMs: number): WorkflowHeartbeatTimerHandle;
	clearTimeout(handle: WorkflowHeartbeatTimerHandle): void;
}

export const defaultWorkflowHeartbeatTimerApi: WorkflowHeartbeatTimerApi = {
	setTimeout: (handler, delayMs) => setTimeout(handler, delayMs) as WorkflowHeartbeatTimerHandle,
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Attempts a single heartbeat identity is given before its pending slot is
 * released. A heartbeat is a periodic nudge, not an exactly-once terminal
 * notice: retrying forever would hold the run's one pending slot and silence
 * every later boundary on the cadence. Releasing the slot lets the next future
 * boundary arm normally.
 */
export const WORKFLOW_HEARTBEAT_MAX_DELIVERY_ATTEMPTS = 5;

interface WorkflowHeartbeatDeliveryOptions {
	readonly emit: (details: WorkflowHeartbeatEventDetails) => boolean | Promise<boolean>;
	/**
	 * Live re-check taken immediately before every attempt, the retries included.
	 * A run that reached a terminal state between attempt 1 and attempt 5 must not
	 * be sent, so the guard belongs on the attempt rather than on the enqueue.
	 */
	readonly canDeliver?: (details: WorkflowHeartbeatEventDetails) => boolean;
	/** Called exactly once per identity, after success or after attempts are exhausted. */
	readonly onSettled: (details: WorkflowHeartbeatEventDetails, delivered: boolean) => void;
	readonly timers: WorkflowHeartbeatTimerApi;
}

export interface WorkflowHeartbeatDelivery {
	deliver(details: WorkflowHeartbeatEventDetails): void;
	dispose(): void;
}

/** Stable delivery key for one boundary: the slice-1 `runId + scheduledAt` identity. */
export function workflowHeartbeatIdentityKey(identity: { runId: string; scheduledAt: number }): string {
	return `${identity.runId}:${identity.scheduledAt}`;
}

/**
 * Owns one heartbeat identity's admission with capped-backoff retry. Every
 * retry re-sends the identical `WorkflowHeartbeatEventDetails`, so the
 * `runId + scheduledAt` identity is reused rather than re-derived from the
 * retry's own clock. Deliberately separate from `createLifecycleNoticeDelivery`:
 * that helper is hard-typed to lifecycle notices and its exact retry/handover
 * semantics are pinned by existing tests.
 */
export function createWorkflowHeartbeatDelivery(options: WorkflowHeartbeatDeliveryOptions): WorkflowHeartbeatDelivery {
	const retryTimers = new Set<WorkflowHeartbeatTimerHandle>();
	const attempts = new Map<string, number>();
	let active = true;

	const deliver = (details: WorkflowHeartbeatEventDetails): void => {
		if (!active) return;
		const key = workflowHeartbeatIdentityKey(details);
		if (options.canDeliver !== undefined && !options.canDeliver(details)) {
			// Suppressed rather than sent, and never retried: the run's state is the
			// reason, and no amount of backoff changes it.
			attempts.delete(key);
			options.onSettled(details, false);
			return;
		}
		const attempt = (attempts.get(key) ?? 0) + 1;
		attempts.set(key, attempt);
		const settle = (delivered: boolean): void => {
			if (delivered || attempt >= WORKFLOW_HEARTBEAT_MAX_DELIVERY_ATTEMPTS || !active) {
				attempts.delete(key);
				options.onSettled(details, delivered);
				return;
			}
			const handle = options.timers.setTimeout(
				() => {
					retryTimers.delete(handle);
					if (active) deliver(details);
				},
				Math.min(20 * 2 ** (attempt - 1), 1_000),
			);
			handle.unref?.();
			retryTimers.add(handle);
		};
		const result = options.emit(details);
		if (typeof result === "boolean") settle(result);
		else void result.then(settle);
	};

	return {
		deliver,
		dispose() {
			active = false;
			for (const handle of retryTimers) options.timers.clearTimeout(handle);
			retryTimers.clear();
			attempts.clear();
			// An in-flight send is left to settle on its own; `active` keeps it from
			// starting a further retry.
		},
	};
}
