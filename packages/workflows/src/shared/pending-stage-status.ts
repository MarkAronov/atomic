import type { ExpandedWorkflowStage } from "./expanded-workflow-graph.js";
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

function pendingStageTarget(
	runId: string,
	stage: StageSnapshot,
): Pick<ExpandedWorkflowStage["workflowGraphTarget"], "runId" | "stageId"> {
	return "workflowGraphTarget" in stage
		? (stage as ExpandedWorkflowStage).workflowGraphTarget
		: { runId, stageId: stage.id };
}

export function pendingWorkflowStageStatus(
	runId: string,
	stage: StageSnapshot,
): PendingWorkflowStageStatus | undefined {
	if (stage.status !== "pending") return undefined;
	const pendingStageDeliveryAvailable = stage.pendingStageDeliveryAvailable === true;
	const identity = pendingStageTarget(runId, stage);
	return {
		stageId: identity.stageId,
		name: stage.name,
		lifecycle: "pending",
		pendingStageDeliveryAvailable,
		...(pendingStageDeliveryAvailable ? { target: `${identity.runId}:${identity.stageId}` } : {}),
	};
}

export function pendingWorkflowStageStatuses(run: Pick<RunSnapshot, "id" | "stages">): PendingWorkflowStageStatus[] {
	return run.stages.flatMap((stage) => {
		const pending = pendingWorkflowStageStatus(run.id, stage);
		return pending === undefined ? [] : [pending];
	});
}
