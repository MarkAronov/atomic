import type { ExpandedWorkflowStage } from "./expanded-workflow-graph.js";
import { isTerminalRunStatus } from "./store-internal.js";
import type { RunSnapshot, RunStatus, StageSnapshot } from "./store-types.js";
import { formatWorkflowStageTarget } from "./workflow-stage-target.js";

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
	readonly rootRunId?: string;
	readonly status: RunStatus | "crashed";
};
export type PendingWorkflowRunStatusResolver = (runId: string) => RunStatus | "crashed" | undefined;
/** Boundary identity of each ancestor hop for a run, root run first; `undefined` when the lineage is broken. */
export type WorkflowBoundarySegmentsResolver = (runId: string) => readonly string[] | undefined;

/**
 * Depth-faithful boundary segments for `runId` (D8 clarification): one segment per
 * ancestor hop below the root, each the boundary-stage name when it is a valid single
 * segment, else that boundary's materialized child-run id. `[]` for the root run;
 * `undefined` when a parent or boundary link is missing from `runs`.
 */
export function workflowBoundarySegments(runs: readonly RunSnapshot[], runId: string): readonly string[] | undefined {
	const runById = new Map(runs.map((run) => [run.id, run]));
	const segments: string[] = [];
	let current = runById.get(runId);
	while (current !== undefined && current.parentRunId !== undefined) {
		const parent = runById.get(current.parentRunId);
		const boundary = parent?.stages.find((stage) => stage.id === current?.parentStageId);
		if (parent === undefined || boundary === undefined) return undefined;
		const boundaryName = boundary.name;
		segments.unshift(
			boundaryName.length > 0 && !boundaryName.includes("/") && !boundaryName.includes("*")
				? boundaryName
				: current.id,
		);
		current = parent;
	}
	return current === undefined ? undefined : segments;
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
	run: PendingWorkflowRun,
	stage: StageSnapshot,
	resolveOwningRunStatus?: PendingWorkflowRunStatusResolver,
	resolveBoundarySegments?: WorkflowBoundarySegmentsResolver,
): PendingWorkflowStageStatus | undefined {
	if (stage.status !== "pending") return undefined;
	const identity = pendingStageTarget(run.id, stage);
	const rootRunId = run.rootRunId ?? run.id;
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
		...(pendingStageDeliveryAvailable
			? {
					target: formatWorkflowStageTarget(
						rootRunId,
						...(identity.runId === rootRunId
							? []
							: (resolveBoundarySegments?.(identity.runId) ?? [identity.runId])),
						identity.stageId,
					),
				}
			: {}),
	};
}

export function pendingWorkflowStageStatuses(
	run: Pick<RunSnapshot, "id" | "status" | "stages">,
	resolveOwningRunStatus?: PendingWorkflowRunStatusResolver,
	resolveBoundarySegments?: WorkflowBoundarySegmentsResolver,
): PendingWorkflowStageStatus[] {
	return run.stages.flatMap((stage) => {
		const pending = pendingWorkflowStageStatus(run, stage, resolveOwningRunStatus, resolveBoundarySegments);
		return pending === undefined ? [] : [pending];
	});
}
