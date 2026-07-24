import type { RunSnapshot, StageSnapshot } from "../shared/store-types.js";
import type { WorkflowInputValues, WorkflowSerializableValue } from "../shared/types.js";
import { isReopenableSessionTranscript } from "../shared/session-transcript.js";
import type { DurableWorkflowBackend } from "./backend.js";
import {
  DURABLE_STAGE_TOPOLOGY_VERSION,
  type DurableCheckpoint,
  type DurableStageCheckpoint,
  type ResumableWorkflowEntry,
} from "./types.js";
import { resolveDurableEntry } from "./resume-runtime.js";
import { priorRunElapsedMs } from "./run-timing.js";
import { boundaryTransitionError, resolveBoundaryLifecycle } from "./boundary-lifecycle.js";
import { groupByDurableStageKey, immutableStageGroupError } from "./stage-topology-validation.js";
import { parseWorkflowChildResult } from "./workflow-child-result.js";

export type CompletedWorkflowResolution =
  | { readonly kind: "found"; readonly entry: ResumableWorkflowEntry; readonly snapshot: RunSnapshot }
  | { readonly kind: "ambiguous"; readonly matches: readonly ResumableWorkflowEntry[] }
  | { readonly kind: "not_found" }
  | { readonly kind: "stale"; readonly entry: ResumableWorkflowEntry };


interface StageDraft {
  readonly replayKey: string;
  readonly name: string;
  readonly firstCompletedAt: number;
  readonly output?: DurableStageCheckpoint["output"];
  readonly result?: string;
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly durationMs?: number;
  readonly model?: string;
  readonly fastMode?: boolean;
  readonly attemptedModels?: readonly string[];
  readonly modelAttempts?: DurableStageCheckpoint["modelAttempts"];
  readonly topology?: DurableStageCheckpoint["topology"];
}

/** Authoritative completed rows. This path is deliberately separate from resumability. */
export function listCompletedFromBackend(
  backend: DurableWorkflowBackend,
): readonly ResumableWorkflowEntry[] {
  return backend.listCompletedWorkflows();
}

/** Completed rows whose authoritative stage topology reconstructs safely. */
export function listOpenableCompletedWorkflows(
  backend: DurableWorkflowBackend,
): readonly ResumableWorkflowEntry[] {
  return listCompletedFromBackend(backend)
    .filter((entry) => completedWorkflowSnapshot(backend, entry) !== undefined)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function resolveCompletedWorkflow(
  workflowIdOrPrefix: string,
  backend: DurableWorkflowBackend,
  openableCatalog: readonly ResumableWorkflowEntry[] = listOpenableCompletedWorkflows(backend),
): CompletedWorkflowResolution {
  const resolved = resolveDurableEntry(workflowIdOrPrefix, openableCatalog);
  if (resolved !== undefined) {
    if ("kind" in resolved) return { kind: "ambiguous", matches: resolved.matches };
    const snapshot = completedWorkflowSnapshot(backend, resolved);
    if (snapshot === undefined) {
      return { kind: "stale", entry: resolved };
    }
    return { kind: "found", entry: resolved, snapshot };
  }

  const authoritative = resolveDurableEntry(workflowIdOrPrefix, listCompletedFromBackend(backend));
  if (authoritative === undefined) return { kind: "not_found" };
  if ("kind" in authoritative) return { kind: "ambiguous", matches: authoritative.matches };
  return { kind: "stale", entry: authoritative };
}

export function completedWorkflowSnapshot(
  backend: DurableWorkflowBackend,
  entry: ResumableWorkflowEntry,
): RunSnapshot | undefined {
  const runs = completedWorkflowRunSnapshots(backend, entry);
  return runs.find((run) => run.id === entry.workflowId);
}

/** Rebuild the root plus every nested child run required by graph expansion. */
export function completedWorkflowRunSnapshots(
  backend: DurableWorkflowBackend,
  entry: ResumableWorkflowEntry,
): readonly RunSnapshot[] {
  const handle = backend.getWorkflow(entry.workflowId);
  if (handle === undefined || handle.status !== "completed") return [];
  const checkpoints = backend.listCheckpoints(entry.workflowId);
  if (checkpoints.length === 0) return [];
  const runs = runSnapshotsFromCheckpoints(checkpoints, handle.workflowId, handle.name, handle.updatedAt)
    .map((run) => ({ ...run, stages: run.stages.map(validatedStageTranscript) }));
  const rootIndex = runs.findIndex((run) => run.id === handle.workflowId);
  if (rootIndex < 0) return [];
  const rootDuration = priorRunElapsedMs(backend, handle.workflowId)
    ?? Math.max(0, handle.updatedAt - handle.createdAt);
  const root: RunSnapshot = {
    ...runs[rootIndex]!,
    inputs: { ...handle.inputs } as WorkflowInputValues,
    startedAt: handle.createdAt,
    endedAt: handle.updatedAt,
    durationMs: rootDuration,
    resumable: false,
  };
  return [root, ...runs.filter((_, index) => index !== rootIndex)];
}

/** Rebuild completed nested runs while a paused root is replaying cached boundaries. */
export function durableNestedRunSnapshots(
  backend: DurableWorkflowBackend,
  rootWorkflowId: string,
): readonly RunSnapshot[] {
  const handle = backend.getWorkflow(rootWorkflowId);
  if (handle === undefined) return [];
  return runSnapshotsFromCheckpoints(
    backend.listCheckpoints(rootWorkflowId),
    rootWorkflowId,
    handle.name,
    handle.updatedAt,
    false,
  ).filter((run) => run.id !== rootWorkflowId);
}

function validatedStageTranscript(stage: StageSnapshot): StageSnapshot {
  if (stage.sessionFile === undefined || isReopenableSessionTranscript(stage.sessionFile)) return stage;
  const { sessionFile, ...withoutSessionFile } = stage;
  void sessionFile;
  return withoutSessionFile;
}


function runSnapshotsFromCheckpoints(
  checkpoints: readonly DurableCheckpoint[],
  rootRunId: string,
  rootRunName: string,
  fallbackCompletedAt: number,
  strict = true,
): RunSnapshot[] {
  if (!validBoundaryRecordSet(checkpoints, strict)) return [];
  const stageRecords = checkpoints.filter((checkpoint): checkpoint is DurableStageCheckpoint => checkpoint.kind === "stage");
  if (immutableStageGroupError(stageRecords) !== undefined) return [];
  const recordsByGroup = groupByDurableStageKey(stageRecords);
  const drafts = new Map<string, StageDraft>();
  for (const [groupKey, records] of recordsByGroup) {
    drafts.set(groupKey, mergeStageGroup(records, stageRecords));
  }
  const candidates = [...drafts.values()]
    .filter((draft) => !strict || draft.topology?.run === undefined
      || draft.endedAt !== undefined || draft.output !== undefined);
  if (candidates.length === 0) {
    return strict ? [] : [syntheticRun(rootRunId, rootRunName, checkpoints.length, fallbackCompletedAt)];
  }

  const grouped = new Map<string, StageDraft[]>();
  for (const draft of candidates) {
    if (draft.topology?.version !== DURABLE_STAGE_TOPOLOGY_VERSION) {
      if (strict) return [];
      continue;
    }
    const runId = draft.topology.run?.runId ?? rootRunId;
    const group = grouped.get(runId) ?? [];
    group.push(draft);
    grouped.set(runId, group);
  }
  for (const group of grouped.values()) group.sort(compareDraftSourceOrder);
  retainReachableRunGroups(grouped, rootRunId);
  if (!validateRunGroups(grouped, rootRunId)) return [];

  const runs: RunSnapshot[] = [];
  for (const [runId, runDrafts] of grouped) {
    if (!validStageGroup(runDrafts, runId)) return [];
    const stages = runDrafts.map((draft) => stageSnapshotFromDraft(
      draft,
      draft.topology!.stageId,
      draft.topology!.parentIds,
    ));
    const run = runDrafts.find((draft) => draft.topology?.run !== undefined)?.topology?.run;
    const startedAt = Math.min(...stages.map((stage) => stage.startedAt ?? fallbackCompletedAt));
    const endedAt = Math.max(...stages.map((stage) => stage.endedAt ?? fallbackCompletedAt));
    const owner = runId === rootRunId ? undefined : boundaryOwner(grouped, runId);
    runs.push({
      id: runId,
      name: run?.runName ?? rootRunName,
      inputs: {},
      status: owner === undefined ? "completed" : childRunStatus(owner),
      stages,
      startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - startedAt),
      ...(run?.parentRunId !== undefined ? { parentRunId: run.parentRunId } : {}),
      ...(run?.parentStageId !== undefined ? { parentStageId: run.parentStageId } : {}),
      ...(run?.rootRunId !== undefined ? { rootRunId: run.rootRunId } : {}),
      resumable: false,
    });
  }
  return runs;
}

function validBoundaryRecordSet(checkpoints: readonly DurableCheckpoint[], strict: boolean): boolean {
  const allStages = checkpoints.filter((checkpoint): checkpoint is DurableStageCheckpoint => checkpoint.kind === "stage");
  const boundaryStages = allStages.filter((checkpoint) => checkpoint.topology?.boundary !== undefined);
  const startsByReplay = new Map<string, DurableStageCheckpoint[]>();
  for (const checkpoint of boundaryStages) {
    if (checkpoint.topology!.boundary!.event !== "start") continue;
    const starts = startsByReplay.get(checkpoint.replayKey) ?? [];
    starts.push(checkpoint);
    startsByReplay.set(checkpoint.replayKey, starts);
  }
  if ([...startsByReplay.values()].some((starts) => starts.length !== 1)) return false;
  if (boundaryStages.some((checkpoint) => checkpoint.topology!.boundary!.event === "terminal"
    && startsByReplay.get(checkpoint.replayKey)?.length !== 1)) return false;
  for (const starts of startsByReplay.values()) {
    if (boundaryTransitionError(starts[0]!, allStages, strict) !== undefined) return false;
  }
  return true;
}

function validStageGroup(drafts: readonly StageDraft[], runId: string): boolean {
  if (drafts.some((draft) => draft.topology!.stageId.length === 0)) return false;
  const ids = new Set(drafts.map((draft) => draft.topology!.stageId));
  if (ids.size !== drafts.length) return false;
  const orders = drafts.flatMap((draft) => draft.topology!.sourceOrder === undefined
    ? [] : [draft.topology!.sourceOrder]);
  if (new Set(orders).size !== orders.length) return false;
  if (drafts.some((draft) => draft.topology!.parentIds.some((parentId) => !ids.has(parentId)))) return false;
  const runTopologies = drafts.flatMap((draft) => draft.topology?.run === undefined ? [] : [draft.topology.run]);
  const firstRun = runTopologies[0];
  if (runTopologies.some((run) => run.runId !== runId || (firstRun !== undefined
    && (run.runName !== firstRun.runName || run.parentRunId !== firstRun.parentRunId
      || run.parentStageId !== firstRun.parentStageId || run.rootRunId !== firstRun.rootRunId)))) return false;
  const parents = new Map(drafts.map((draft) => [draft.topology!.stageId, draft.topology!.parentIds]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cyclic = (stageId: string): boolean => {
    if (visiting.has(stageId)) return true;
    if (visited.has(stageId)) return false;
    visiting.add(stageId);
    if ((parents.get(stageId) ?? []).some(cyclic)) return true;
    visiting.delete(stageId);
    visited.add(stageId);
    return false;
  };
  return ![...ids].some(cyclic);
}

function compareDraftSourceOrder(left: StageDraft, right: StageDraft): number {
  const leftOrder = left.topology?.sourceOrder;
  const rightOrder = right.topology?.sourceOrder;
  if (leftOrder !== undefined && rightOrder !== undefined) return leftOrder - rightOrder;
  if (leftOrder !== undefined) return -1;
  if (rightOrder !== undefined) return 1;
  return left.firstCompletedAt - right.firstCompletedAt;
}

function validateRunGroups(grouped: Map<string, StageDraft[]>, rootRunId: string): boolean {
  const owners = new Map<string, StageDraft>();
  for (const [parentRunId, drafts] of grouped) {
    for (const draft of drafts) {
      const childRunId = childRunIdFromDraft(draft);
      if (childRunId === undefined) continue;
      if (!grouped.has(childRunId) || childRunId === parentRunId || owners.has(childRunId)) return false;
      const childRun = grouped.get(childRunId)!
        .find((candidate) => candidate.topology?.run !== undefined)?.topology?.run;
      if (childRun?.parentRunId !== parentRunId
        || childRun.parentStageId !== draft.topology?.stageId
        || childRun.rootRunId !== rootRunId) return false;
      owners.set(childRunId, draft);
    }
  }
  for (const [runId, drafts] of grouped) {
    if (runId === rootRunId) continue;
    const run = drafts.find((draft) => draft.topology?.run !== undefined)?.topology?.run;
    if (run === undefined || owners.get(runId) === undefined) return false;
  }
  for (const runId of owners.keys()) {
    const seen = new Set<string>();
    let current: string | undefined = runId;
    while (current !== undefined && current !== rootRunId) {
      if (seen.has(current)) return false;
      seen.add(current);
      current = grouped.get(current)?.[0]?.topology?.run?.parentRunId;
    }
    if (current !== rootRunId) return false;
  }
  return true;
}

function retainReachableRunGroups(grouped: Map<string, StageDraft[]>, rootRunId: string): void {
  const reachable = new Set([rootRunId]);
  const pending = [rootRunId];
  while (pending.length > 0) {
    const drafts = grouped.get(pending.pop()!);
    if (drafts === undefined) continue;
    for (const draft of drafts) {
      const childRunId = childRunIdFromDraft(draft);
      if (childRunId === undefined || reachable.has(childRunId) || !grouped.has(childRunId)) continue;
      reachable.add(childRunId);
      pending.push(childRunId);
    }
  }
  for (const runId of grouped.keys()) if (!reachable.has(runId)) grouped.delete(runId);
}

function childRunIdFromDraft(draft: StageDraft): string | undefined {
  const boundary = draft.topology?.boundary;
  if (boundary !== undefined) {
    return boundary.status === "failed" || boundary.status === "skipped"
      ? undefined
      : boundary.child.runId;
  }
  return workflowChildFromOutput(draft.output)?.runId;
}

function boundaryOwner(grouped: Map<string, StageDraft[]>, childRunId: string): StageDraft | undefined {
  for (const drafts of grouped.values()) {
    const owner = drafts.find((draft) => childRunIdFromDraft(draft) === childRunId);
    if (owner !== undefined) return owner;
  }
  return undefined;
}

function childRunStatus(owner: StageDraft): RunSnapshot["status"] {
  const child = workflowChildFromOutput(owner.output);
  if (child !== undefined) return child.status;
  const status = owner.topology?.boundary?.status;
  if (status === "failed" || status === "skipped" || status === "completed") return status;
  return "running";
}

function mergeStageGroup(
  records: readonly DurableStageCheckpoint[],
  allStages: readonly DurableStageCheckpoint[],
): StageDraft {
  let merged: StageDraft | undefined;
  for (const record of records) merged = mergeStageDraft(merged, record);
  const draft = merged!;
  const start = records.find((record) => record.topology?.boundary?.event === "start");
  if (start === undefined) return draft;
  const resolved = resolveBoundaryLifecycle(start, allStages, false);
  if ("error" in resolved) return draft;
  const terminal = resolved.lifecycle.latestTerminal;
  const { output: _output, result: _result, topology: _topology, ...identityAndMetadata } = draft;
  void _output;
  void _result;
  void _topology;
  if (terminal === undefined) return { ...identityAndMetadata, topology: start.topology };
  return {
    ...identityAndMetadata,
    topology: terminal.topology,
    ...(terminal.output !== undefined ? { output: terminal.output } : {}),
    ...(terminal.output !== undefined && terminal.result !== undefined ? { result: terminal.result } : {}),
  };
}

function mergeStageDraft(
  existing: StageDraft | undefined,
  checkpoint: DurableStageCheckpoint,
): StageDraft {
  return {
    replayKey: checkpoint.replayKey,
    name: existing?.name ?? checkpoint.name,
    firstCompletedAt: Math.min(existing?.firstCompletedAt ?? checkpoint.completedAt, checkpoint.completedAt),
    ...valueOrExisting("output", checkpoint, existing),
    ...valueOrExisting("result", checkpoint, existing),
    ...valueOrExisting("sessionId", checkpoint, existing),
    ...valueOrExisting("sessionFile", checkpoint, existing),
    ...valueOrExisting("startedAt", checkpoint, existing),
    ...valueOrExisting("endedAt", checkpoint, existing),
    ...valueOrExisting("durationMs", checkpoint, existing),
    ...valueOrExisting("model", checkpoint, existing),
    ...valueOrExisting("fastMode", checkpoint, existing),
    ...valueOrExisting("attemptedModels", checkpoint, existing),
    ...valueOrExisting("modelAttempts", checkpoint, existing),
    ...preferredTopology(checkpoint, existing),
  };
}

function preferredTopology(
  checkpoint: DurableStageCheckpoint,
  existing: StageDraft | undefined,
): Pick<StageDraft, "topology"> | object {
  return checkpoint.topology !== undefined
    ? { topology: checkpoint.topology }
    : existing?.topology !== undefined ? { topology: existing.topology } : {};
}

function valueOrExisting<
  K extends keyof Omit<StageDraft, "replayKey" | "name" | "firstCompletedAt">
>(key: K, checkpoint: DurableStageCheckpoint, existing: StageDraft | undefined): Pick<StageDraft, K> | object {
  const checkpointValue = checkpoint[key];
  if (checkpointValue !== undefined) return { [key]: checkpointValue } as Pick<StageDraft, K>;
  const existingValue = existing?.[key];
  return existingValue === undefined ? {} : { [key]: existingValue } as Pick<StageDraft, K>;
}

function workflowChildFromOutput(output: WorkflowSerializableValue | undefined): StageSnapshot["workflowChild"] | undefined {
  const child = parseWorkflowChildResult(output);
  if (child === undefined) return undefined;
  return {
    alias: child.workflow,
    workflow: child.workflow,
    runId: child.runId,
    status: child.status,
    exited: child.exited,
    outputs: child.outputs,
    ...(typeof child.exitReason === "string" ? { exitReason: child.exitReason } : {}),
  };
}

function stageSnapshotFromDraft(
  draft: StageDraft,
  id: string,
  parentIds: readonly string[],
): StageSnapshot {
  const status = draft.topology?.status ?? "completed";
  const startedAt = draft.startedAt ?? draft.firstCompletedAt;
  const endedAt = draft.endedAt ?? (status === "running" ? undefined : draft.firstCompletedAt);
  const workflowChild = workflowChildFromOutput(draft.output);
  const boundary = draft.topology?.boundary;
  return {
    id,
    name: draft.name,
    status,
    parentIds,
    startedAt,
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(endedAt !== undefined ? { durationMs: draft.durationMs ?? Math.max(0, endedAt - startedAt) } : {}),
    ...(stageResult(draft) !== undefined ? { result: stageResult(draft) } : {}),
    replayKey: draft.replayKey,
    toolEvents: [],
    attachable: false,
    ...(workflowChild !== undefined ? { workflowChild } : {}),
    ...(workflowChild === undefined && boundary !== undefined
      && status !== "failed" && status !== "skipped" ? { workflowChildRun: {
        alias: boundary.alias,
        workflow: boundary.workflow,
        runId: boundary.child.runId,
      } } : {}),
    ...(draft.sessionId !== undefined ? { sessionId: draft.sessionId } : {}),
    ...(draft.sessionFile !== undefined ? { sessionFile: draft.sessionFile } : {}),
    ...(draft.model !== undefined ? { model: draft.model } : {}),
    ...(draft.fastMode !== undefined ? { fastMode: draft.fastMode } : {}),
    ...(draft.attemptedModels !== undefined ? { attemptedModels: draft.attemptedModels } : {}),
    ...(draft.modelAttempts !== undefined ? { modelAttempts: draft.modelAttempts } : {}),
  };
}

function stageResult(draft: StageDraft): string | undefined {
  if (draft.result !== undefined) return draft.result;
  if (draft.output === undefined) return undefined;
  return typeof draft.output === "string" ? draft.output : JSON.stringify(draft.output);
}

function syntheticRun(runId: string, runName: string, checkpointCount: number, completedAt: number): RunSnapshot {
  return {
    id: runId,
    name: runName,
    inputs: {},
    status: "completed",
    stages: [syntheticCheckpointStage(checkpointCount, completedAt)],
    startedAt: completedAt,
    endedAt: completedAt,
    durationMs: 0,
    resumable: false,
  };
}

function syntheticCheckpointStage(checkpointCount: number, completedAt: number): StageSnapshot {
  return {
    id: "completed-checkpoints",
    name: "durable checkpoints",
    status: "completed",
    parentIds: [],
    startedAt: completedAt,
    endedAt: completedAt,
    durationMs: 0,
    result: `${checkpointCount} durable checkpoint${checkpointCount === 1 ? "" : "s"}`,
    toolEvents: [],
    attachable: false,
  };
}
