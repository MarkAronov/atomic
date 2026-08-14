/**
 * Durable workflow-heartbeat cadence anchor.
 *
 * The heartbeat cadence is `anchorAt + n × interval`. Every input to that is
 * already persisted except one: the *original* run start time. A durable resume
 * re-dispatches under the original workflow id but mints a fresh
 * `RunSnapshot.startedAt` (`engine/run.ts`), and that fresh value is passed to
 * `registerWorkflow` as `createdAt`, which the backend overwrites
 * unconditionally (`durable/backend.ts`). Checkpoints are the only per-run state
 * that survives re-registration, so this record is the sole surviving carrier of
 * the original start — which is what keeps a resumed run on its original
 * cadence rather than starting a fresh series.
 *
 * Storage shape: a reserved tool-kind checkpoint (name/argsHash
 * `workflow-heartbeat-anchor`), following `run-timing.ts`. Its `checkpointId` is
 * that same constant with no suffix, so `recordCheckpoint`'s duplicate-key early
 * return makes the record **write-once and exactly one row per run** rather than
 * one row per boundary.
 *
 * Three properties this shape is chosen for:
 *
 * - **It cannot manufacture resumability.** `recordCheckpoint` sets
 *   `completedCheckpoints = checkpoints.size`, and `isDurableWorkflowResumable`
 *   gates a running or paused run on `completedCheckpoints > 0`. Writing for a
 *   run with no durable progress of its own would make it look resumable, so the
 *   write is skipped until the run has at least one other checkpoint — the same
 *   guard, and the same reason, as `run-timing.ts`.
 * - **It cannot walk liveness backwards.** `recordCheckpoint` copies
 *   `completedAt` onto the handle as `updatedAt`, which the foreign-liveness
 *   window reads, so `completedAt` is the write time and never a cadence
 *   boundary.
 * - **It cannot move a boundary forward.** It is read as
 *   `min(run.startedAt, anchorAt)`, so it can only restore the original anchor,
 *   never advance it. Recovery still floors at `now`, so no missed boundary is
 *   ever replayed.
 *
 * Deleting or invalidating this record on a terminal run is slice 3's door
 * (issue #1975).
 *
 * cross-ref: packages/workflows/src/extension/workflow-heartbeat-scheduler.ts
 */

import type { DurableWorkflowBackend } from "./backend.js";
import type { DurableToolCheckpoint } from "./types.js";

/** Reserved checkpoint name, args-hash, AND checkpoint id for cadence anchors. */
export const WORKFLOW_HEARTBEAT_ANCHOR_CHECKPOINT_NAME = "workflow-heartbeat-anchor";

/** The persisted original start time for a run, or undefined when absent. */
export function readWorkflowHeartbeatAnchor(backend: DurableWorkflowBackend, workflowId: string): number | undefined {
	const output = backend.getToolOutput(workflowId, WORKFLOW_HEARTBEAT_ANCHOR_CHECKPOINT_NAME);
	if (typeof output !== "object" || output === null || Array.isArray(output)) return undefined;
	const anchorAt = (output as Record<string, unknown>).anchorAt;
	if (typeof anchorAt !== "number" || !Number.isFinite(anchorAt)) return undefined;
	return anchorAt;
}

/**
 * Persist a run's cadence anchor, once. Returns whether the record is readable
 * afterwards — the backend silently drops a checkpoint for a workflow it has
 * never registered, so the return value is a read-back rather than an
 * assumption.
 */
export function recordWorkflowHeartbeatAnchor(
	backend: DurableWorkflowBackend,
	record: { readonly runId: string; readonly anchorAt: number; readonly now: number },
): boolean {
	if (!Number.isFinite(record.anchorAt)) return false;
	const existing = readWorkflowHeartbeatAnchor(backend, record.runId);
	// Write-once: the first anchor stands. A later write cannot move it forward,
	// and the reader takes the minimum anyway.
	if (existing !== undefined) return true;
	// A record for a run with no durable progress of its own would make that run
	// look resumable; the anchor is worth nothing on a run that cannot resume.
	if (backend.listCheckpoints(record.runId).length === 0) return false;
	const checkpoint: DurableToolCheckpoint = {
		kind: "tool",
		workflowId: record.runId,
		checkpointId: WORKFLOW_HEARTBEAT_ANCHOR_CHECKPOINT_NAME,
		name: WORKFLOW_HEARTBEAT_ANCHOR_CHECKPOINT_NAME,
		argsHash: WORKFLOW_HEARTBEAT_ANCHOR_CHECKPOINT_NAME,
		output: { anchorAt: record.anchorAt },
		// Write time, never the boundary: this lands on the handle as `updatedAt`,
		// which the foreign-liveness window reads.
		completedAt: record.now,
	};
	backend.recordCheckpoint(checkpoint);
	return readWorkflowHeartbeatAnchor(backend, record.runId) !== undefined;
}
