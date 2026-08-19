import type { WorkflowDefinition, WorkflowInputValues, WorkflowOutputValues } from "../src/authoring.js";

export type LoopUntilDoneWorkflowStatus = "complete" | "failed";
export type LoopUntilDoneProgressTrend = "rising" | "flat" | "regressing";

export type LoopUntilDoneWorkflowInputs = WorkflowInputValues & {
  readonly prompt: string;
  readonly max_iterations: number;
  readonly progress_scoring: boolean;
  readonly progress_repeats: number;
};

export type LoopUntilDoneWorkflowRunInputs = WorkflowInputValues & {
  readonly prompt: string;
  readonly max_iterations?: number;
  readonly progress_scoring?: boolean;
  readonly progress_repeats?: number;
};

export type LoopUntilDoneWorkflowOutputs = WorkflowOutputValues & {
  readonly result: string;
  readonly status: LoopUntilDoneWorkflowStatus;
  readonly iterations_completed: number;
  readonly ledger_path: string;
  readonly iteration_artifact_paths: string[];
  readonly evaluation_artifact_paths: string[];
  readonly result_path: string;
  readonly remaining_work: string;
  readonly artifact_dir: string;
  readonly progress_curve: number[];
  readonly final_trend: LoopUntilDoneProgressTrend;
  readonly progress_disclaimer: string;
};

export type LoopUntilDoneWorkflowDefinition = WorkflowDefinition<
  LoopUntilDoneWorkflowInputs,
  LoopUntilDoneWorkflowOutputs,
  LoopUntilDoneWorkflowRunInputs
>;

declare const workflow: LoopUntilDoneWorkflowDefinition;
export default workflow;
