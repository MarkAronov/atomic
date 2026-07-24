import { durableHash, type DurableWorkflowBackend } from "../durable/backend.js";
import { durableCompletedNestedRunSubtree } from "../durable/completed-subtree.js";
import { DurableNestedTopologyError } from "../durable/boundary-topology.js";
import {
  recordCachedStageWithTracker,
  recordStageCheckpoint,
  type DurableCompletedStageCheckpoint,
  type DurableStageDeps,
} from "../durable/stage-primitive.js";
import { durableStageCheckpointMetadata } from "../durable/stage-topology.js";
import { promptOccurrenceIdentityError } from "../durable/stage-topology-validation.js";
import type { DurableStageCheckpoint, DurableStageRunTopology, DurableStageTopology } from "../durable/types.js";
import { parseWorkflowChildResult } from "../durable/workflow-child-result.js";
import type { GraphFrontierTracker } from "./graph-inference.js";
import type { RunSnapshot, StageSnapshot } from "../shared/store-types.js";
import type { Store } from "../shared/store.js";
import type { ParallelFailFastScope, RunOpts } from "../runs/foreground/executor-types.js";

export function durableRunTopology(run: RunSnapshot): DurableStageRunTopology {
  return {
    runId: run.id,
    runName: run.name,
    ...(run.parentRunId !== undefined ? { parentRunId: run.parentRunId } : {}),
    ...(run.parentStageId !== undefined ? { parentStageId: run.parentStageId } : {}),
    ...(run.rootRunId !== undefined ? { rootRunId: run.rootRunId } : {}),
  };
}

export function createDurableStageDeps(input: {
  readonly backend: DurableWorkflowBackend;
  readonly run: RunSnapshot;
  readonly nextCheckpointId: () => string;
  readonly nextReplayKey: (stageName: string) => string;
  readonly completedReplayKeys: Map<string, string>;
}): DurableStageDeps {
  return {
    workflowId: input.run.id,
    backend: input.backend,
    nextCheckpointId: input.nextCheckpointId,
    nextReplayKey: input.nextReplayKey,
    replayKeyForCompletedStage: (stage) => input.completedReplayKeys.get(stage.id),
    runTopology: durableRunTopology(input.run),
    sourceOrderForStage: (stage) => {
      const order = input.run.stages.findIndex((candidate) => candidate.id === stage.id);
      return order >= 0 ? order : undefined;
    },
  };
}

export function createDurableStageEndRecorder(input: {
  readonly rootRunId: string;
  readonly deps: DurableStageDeps;
  readonly user?: RunOpts["onStageEnd"];
  readonly metadataOnly?: boolean;
}): (runId: string, snapshot: StageSnapshot) => Promise<void> {
  return async (runId, snapshot): Promise<void> => {
    if (runId === input.rootRunId) {
      await recordStageCheckpoint(input.deps, snapshot, { metadataOnly: input.metadataOnly });
    }
    await input.user?.(runId, snapshot);
  };
}

/** Snapshot prior-process stage identities so live writes cannot be mistaken for resume topology. */
export function createDurableStageTopologyResolver(
  backend: DurableWorkflowBackend,
  workflowId: string,
): (replayKey: string) => DurableStageTopology | undefined {
  const byReplayKey = new Map<string, Map<string, DurableStageTopology>>();
  const ownedStages: DurableStageCheckpoint[] = [];
  for (const checkpoint of backend.listCheckpoints(workflowId)) {
    if (checkpoint.kind !== "stage" || checkpoint.topology === undefined) continue;
    const topology = checkpoint.topology;
    if (topology.run !== undefined && topology.run.runId !== workflowId) continue;
    ownedStages.push(checkpoint);
    const byStage = byReplayKey.get(checkpoint.replayKey) ?? new Map<string, DurableStageTopology>();
    byStage.set(topology.stageId, topology);
    byReplayKey.set(checkpoint.replayKey, byStage);
  }
  const occurrenceError = promptOccurrenceIdentityError(ownedStages);
  const queues = new Map<string, readonly DurableStageTopology[]>();
  for (const [replayKey, byStage] of byReplayKey) {
    const stages = [...byStage.values()];
    const sourceOrders = stages.map((stage) => stage.sourceOrder);
    const safe = stages.length <= 1 || (sourceOrders.every((order) => order !== undefined)
      && new Set(sourceOrders).size === sourceOrders.length);
    queues.set(replayKey, safe
      ? stages.sort((left, right) => (left.sourceOrder ?? 0) - (right.sourceOrder ?? 0))
      : []);
  }
  const indexes = new Map<string, number>();
  return (replayKey): DurableStageTopology | undefined => {
    if (occurrenceError !== undefined) throw new DurableNestedTopologyError(occurrenceError);
    const index = indexes.get(replayKey) ?? 0;
    indexes.set(replayKey, index + 1);
    return queues.get(replayKey)?.[index];
  };
}

/** Persist an in-progress stage identity before an external wait can outlive this process. */
export async function recordDurableActiveStage(
  deps: DurableStageDeps,
  stage: StageSnapshot,
): Promise<boolean> {
  if (stage.replayKey === undefined
    || stage.status === "completed" || stage.status === "failed" || stage.status === "skipped") return false;
  await deps.backend.recordCheckpointAsync({
    kind: "stage",
    workflowId: deps.workflowId,
    checkpointId: `stage-active-meta:${durableHash({ replayKey: stage.replayKey, stageId: stage.id })}`,
    name: stage.name,
    replayKey: stage.replayKey,
    completedAt: Date.now(),
    ...durableStageCheckpointMetadata(stage, deps.runTopology, deps.sourceOrderForStage?.(stage)),
  });
  return true;
}

export function createDurableCachedStageRecorder(input: {
  readonly store: Store;
  readonly tracker: GraphFrontierTracker;
  readonly run: RunSnapshot;
  readonly backend: DurableWorkflowBackend;
  readonly rootBackend: DurableWorkflowBackend;
  readonly completedStageReplayKeys: Map<string, string>;
}): {
  readonly record: (name: string, replayKey: string, checkpoint: DurableCompletedStageCheckpoint, scope?: ParallelFailFastScope) => void;
  readonly metadata: (replayKey: string) => Partial<DurableCompletedStageCheckpoint>;
} {
  const replaySourceOrders = new Map<string, number>();
  return {
    record(name, replayKey, checkpoint, scope): void {
      const cachedChildRunId = workflowChildRunId(checkpoint);
      const durableRootId = input.run.rootRunId ?? input.run.id;
      const cachedDescendants = cachedChildRunId === undefined
        ? undefined
        : durableCompletedNestedRunSubtree(input.rootBackend, durableRootId, cachedChildRunId);
      if (cachedChildRunId !== undefined && cachedDescendants === undefined) {
        throw new DurableNestedTopologyError(
          `cached completed child subtree is incomplete or inconsistent at ${replayKey}`,
        );
      }
      recordCachedStageWithTracker(
        input.store, input.tracker, input.run.id, name, replayKey, checkpoint,
        input.completedStageReplayKeys, scope,
      );
      const sourceOrder = checkpoint.topology?.sourceOrder;
      if (sourceOrder !== undefined) {
        const replayedStage = input.run.stages.find((candidate) => candidate.replayKey === replayKey);
        if (replayedStage !== undefined) replaySourceOrders.set(replayedStage.id, sourceOrder);
        input.run.stages.sort((left, right) =>
          (replaySourceOrders.get(left.id) ?? Number.MAX_SAFE_INTEGER)
          - (replaySourceOrders.get(right.id) ?? Number.MAX_SAFE_INTEGER)
        );
      }
      const stage = input.store.runs().find((run) => run.id === input.run.id)?.stages
        .find((candidate) => candidate.replayKey === replayKey);
      if (stage !== undefined) {
        input.backend.recordCheckpoint({
          kind: "stage", workflowId: input.run.id,
          checkpointId: `stage-replay-meta:${durableHash({ replayKey, stageId: stage.id, parentIds: stage.parentIds })}`,
          name, replayKey, completedAt: Date.now(),
          ...durableStageCheckpointMetadata(
            stage,
            durableRunTopology(input.run),
            sourceOrder ?? input.run.stages.findIndex((candidate) => candidate.id === stage.id),
          ),
        });
      }
      for (const childRun of cachedDescendants ?? []) {
        if (!input.store.runs().some((candidate) => candidate.id === childRun.id)) {
          input.store.recordRunStart(childRun);
        }
      }
    },
    metadata(replayKey) {
      const stage = input.run.stages.find((candidate) => candidate.replayKey === replayKey);
      return stage === undefined ? {} : durableStageCheckpointMetadata(
        stage,
        durableRunTopology(input.run),
        input.run.stages.findIndex((candidate) => candidate.id === stage.id),
      );
    },
  };
}

function workflowChildRunId(checkpoint: DurableCompletedStageCheckpoint): string | undefined {
  return parseWorkflowChildResult(checkpoint.output)?.runId;
}
