/**
 * Durable workflow-heartbeat schedule record.
 *
 * Storage shape: a reserved tool-kind checkpoint (name/argsHash
 * `workflow-heartbeat-schedule`), exactly as `run-timing.ts` stores run-level
 * elapsed time. Tool checkpoints round-trip through the DBOS envelope untouched
 * and are ignored by stage-graph reconstruction, so no phantom stage appears in
 * durable inspection. Repeated writes use distinct checkpoint ids; the latest
 * record wins on hydration because the in-memory mirror replays checkpoints in
 * completion order.
 *
 * What this record is for, and what it deliberately is not: the cadence itself
 * is derived from `RunSnapshot.startedAt` and the frozen
 * `heartbeatIntervalMinutes`, both already persisted and restored by existing
 * authorities. This record therefore carries no cadence of its own. It is read
 * back only as a *monotone floor* on the next boundary, and a restored floor is
 * always in the past, so it is structurally incapable of moving a boundary
 * earlier or later than the derived series. Its worst case is being ignored,
 * which is what keeps it from becoming a second source of truth.
 *
 * Deleting or invalidating the record on a terminal run is slice 3's door
 * (issue #1975); a stale record is inert for the reason above.
 *
 * cross-ref: packages/workflows/src/extension/workflow-heartbeat-scheduler.ts
 */

import type { DurableWorkflowBackend } from "./backend.js";
import type { DurableToolCheckpoint } from "./types.js";

/** Reserved checkpoint name AND args-hash for heartbeat schedule records. */
export const WORKFLOW_HEARTBEAT_SCHEDULE_CHECKPOINT_NAME = "workflow-heartbeat-schedule";

export interface WorkflowHeartbeatScheduleRecord {
	/** Most recently raised cadence boundary for this run, in Unix milliseconds. */
	readonly scheduledAt: number;
	/** Resolved cadence the boundary came from, for inspection only. */
	readonly intervalMinutes: number;
}

/** The persisted schedule record for a run, or undefined when absent or malformed. */
export function readWorkflowHeartbeatScheduleRecord(
	backend: DurableWorkflowBackend,
	workflowId: string,
): WorkflowHeartbeatScheduleRecord | undefined {
	const output = backend.getToolOutput(workflowId, WORKFLOW_HEARTBEAT_SCHEDULE_CHECKPOINT_NAME);
	if (typeof output !== "object" || output === null || Array.isArray(output)) return undefined;
	const record = output as Record<string, unknown>;
	const scheduledAt = record.scheduledAt;
	const intervalMinutes = record.intervalMinutes;
	if (typeof scheduledAt !== "number" || !Number.isFinite(scheduledAt)) return undefined;
	if (typeof intervalMinutes !== "number" || !Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
		return undefined;
	}
	return { scheduledAt, intervalMinutes };
}

/**
 * Record the boundary just raised for a run. One record per run, written only
 * for a positive resolved interval, so a disabled workflow leaves no record at
 * all. Returns whether the record is durably readable afterwards — the backend
 * silently ignores a checkpoint for a workflow it does not know, so the return
 * value is a read-back rather than an assumption.
 */
export function recordWorkflowHeartbeatScheduleCheckpoint(
	backend: DurableWorkflowBackend,
	record: WorkflowHeartbeatScheduleRecord & { readonly runId: string },
): boolean {
	if (!Number.isFinite(record.scheduledAt)) return false;
	if (!Number.isFinite(record.intervalMinutes) || record.intervalMinutes <= 0) return false;
	const existing = readWorkflowHeartbeatScheduleRecord(backend, record.runId);
	// Monotone: an older boundary never overwrites a newer one, so a retry or a
	// late write cannot walk the floor backwards.
	if (existing !== undefined && existing.scheduledAt >= record.scheduledAt) return false;
	const checkpoint: DurableToolCheckpoint = {
		kind: "tool",
		workflowId: record.runId,
		checkpointId: `workflow-heartbeat-schedule:${record.scheduledAt}`,
		name: WORKFLOW_HEARTBEAT_SCHEDULE_CHECKPOINT_NAME,
		argsHash: WORKFLOW_HEARTBEAT_SCHEDULE_CHECKPOINT_NAME,
		output: { scheduledAt: record.scheduledAt, intervalMinutes: record.intervalMinutes },
		completedAt: record.scheduledAt,
	};
	backend.recordCheckpoint(checkpoint);
	return readWorkflowHeartbeatScheduleRecord(backend, record.runId)?.scheduledAt === record.scheduledAt;
}
