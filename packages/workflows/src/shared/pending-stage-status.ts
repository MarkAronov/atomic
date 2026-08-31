import type { RunSnapshot, StageSnapshot } from "./store-types.js";

/** Actionable identity and pre-start delivery state for one materialized pending stage. */
export interface PendingWorkflowStageStatus {
	readonly stageId: string;
	readonly name: string;
	readonly lifecycle: "pending";
	readonly pendingStageDeliveryAvailable: boolean;
	/** Exact Intercom target, present only when pre-start delivery is available. */
	readonly target?: string;
}

export function pendingWorkflowStageStatus(
	runId: string,
	stage: StageSnapshot,
): PendingWorkflowStageStatus | undefined {
	if (stage.status !== "pending") return undefined;
	const pendingStageDeliveryAvailable = stage.pendingStageDeliveryAvailable === true;
	return {
		stageId: stage.id,
		name: stage.name,
		lifecycle: "pending",
		pendingStageDeliveryAvailable,
		...(pendingStageDeliveryAvailable ? { target: `${runId}:${stage.id}` } : {}),
	};
}

export function pendingWorkflowStageStatuses(run: Pick<RunSnapshot, "id" | "stages">): PendingWorkflowStageStatus[] {
	return run.stages.flatMap((stage) => {
		const pending = pendingWorkflowStageStatus(run.id, stage);
		return pending === undefined ? [] : [pending];
	});
}
