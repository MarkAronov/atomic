import { recordRunTimingCheckpointAsync } from "../durable/run-timing.js";
import { type DurableStageDeps, recordStageSessionCheckpoint } from "../durable/stage-primitive.js";
import { recordWorkflowHeartbeatAnchor } from "../durable/workflow-heartbeat-anchor.js";
import type { StageSessionCheckpointOptions } from "../runs/foreground/executor-types.js";
import type { RunSnapshot, StageSnapshot } from "../shared/store-types.js";

export interface DurableStageSessionRecorderInput {
	readonly runId: string;
	readonly deps: DurableStageDeps;
	readonly onStageSession?: (
		runId: string,
		snapshot: StageSnapshot,
		options?: StageSessionCheckpointOptions,
	) => unknown;
	/**
	 * Live root-run snapshot. When present, stage-session checkpoints also
	 * refresh the debounced run-level elapsed record so a durable resume can
	 * seed the total workflow duration. Omitted for child runs — run timing is
	 * only tracked for the root workflow.
	 */
	readonly runSnapshot?: RunSnapshot;
	/** Cadence declared by the live definition that minted `runSnapshot`. */
	readonly heartbeatIntervalMinutes: number;
}

export function createDurableStageSessionRecorder(
	input: DurableStageSessionRecorderInput,
): (stageRunId: string, snapshot: StageSnapshot, options?: StageSessionCheckpointOptions) => Promise<void> {
	return async (stageRunId, snapshot, options) => {
		if (stageRunId === input.runId) {
			await recordStageSessionCheckpoint(input.deps, snapshot, { force: options?.forceDurable === true });
			if (input.runSnapshot !== undefined) {
				await recordRunTimingCheckpointAsync(input.deps.backend, input.runSnapshot, {
					debounce: options?.forceDurable !== true,
				});
				// A forced pause/quit capture can be the first checkpoint that makes
				// the run resumable. The run is already published as paused then, so
				// the heartbeat scheduler will not get another active schedule pass in
				// which to retry its no-progress-guarded launch-record write. Persist
				// it at this durability boundary, after ordinary progress exists and
				// while the live run still owns the original start and launch cadence.
				const intervalMinutes = input.heartbeatIntervalMinutes;
				if (options?.forceDurable === true && Number.isFinite(intervalMinutes * 60_000)) {
					await recordWorkflowHeartbeatAnchor(input.deps.backend, {
						runId: input.runId,
						anchorAt: input.runSnapshot.startedAt,
						intervalMinutes,
						now: input.deps.now?.() ?? Date.now(),
					});
				}
			}
		}
		await input.onStageSession?.(stageRunId, snapshot, options);
	};
}
