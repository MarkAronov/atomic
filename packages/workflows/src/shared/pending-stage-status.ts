import type { ExpandedWorkflowStage } from "./expanded-workflow-graph.js";
import { isTerminalRunStatus } from "./store-internal.js";
import type { RunSnapshot, RunStatus, StageSnapshot } from "./store-types.js";

/** Actionable identity and pre-start delivery state for one materialized pending stage. */
export interface PendingWorkflowStageStatus {
	readonly stageId: string;
	readonly name: string;
	readonly lifecycle: "pending";
	readonly pendingStageDeliveryAvailable: boolean;
	/** Exact Intercom target, present only when pre-start delivery is available. */
	readonly target?: string;
}
type PendingWorkflowRun = {
	readonly id: string;
	readonly status: RunStatus | "crashed";
};
export type PendingWorkflowRunStatusResolver = (runId: string) => RunStatus | "crashed" | undefined;

function pendingStageTarget(
	runId: string,
	stage: StageSnapshot,
): Pick<ExpandedWorkflowStage["workflowGraphTarget"], "runId" | "stageId"> {
	return "workflowGraphTarget" in stage
		? (stage as ExpandedWorkflowStage).workflowGraphTarget
		: { runId, stageId: stage.id };
}

export function pendingWorkflowStageStatus(
	run: PendingWorkflowRun,
	stage: StageSnapshot,
	resolveOwningRunStatus?: PendingWorkflowRunStatusResolver,
): PendingWorkflowStageStatus | undefined {
	if (stage.status !== "pending") return undefined;
	const identity = pendingStageTarget(run.id, stage);
	const owningRunStatus = identity.runId === run.id ? run.status : resolveOwningRunStatus?.(identity.runId);
	const pendingStageDeliveryAvailable =
		owningRunStatus !== undefined &&
		owningRunStatus !== "crashed" &&
		!isTerminalRunStatus(owningRunStatus) &&
		stage.pendingStageDeliveryAvailable === true;
	return {
		stageId: identity.stageId,
		name: stage.name,
		lifecycle: "pending",
		pendingStageDeliveryAvailable,
		...(pendingStageDeliveryAvailable ? { target: `${identity.runId}:${identity.stageId}` } : {}),
	};
}

export function pendingWorkflowStageStatuses(
	run: Pick<RunSnapshot, "id" | "status" | "stages">,
	resolveOwningRunStatus?: PendingWorkflowRunStatusResolver,
): PendingWorkflowStageStatus[] {
	return run.stages.flatMap((stage) => {
		const pending = pendingWorkflowStageStatus(run, stage, resolveOwningRunStatus);
		return pending === undefined ? [] : [pending];
	});
}
