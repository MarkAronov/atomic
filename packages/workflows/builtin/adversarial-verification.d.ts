import type { WorkflowDefinition, WorkflowInputValues, WorkflowOutputValues } from "../src/authoring.js";

export type AdversarialVerificationCriteria = string | Record<string, string>;
export type AdversarialVerificationInputs = WorkflowInputValues & {
  readonly task: string;
  readonly verifier_count: number;
  readonly max_repairs: number;
  readonly criteria: AdversarialVerificationCriteria;
  readonly accept_mean: number;
  readonly reask_limit: number;
};
export type AdversarialVerificationRunInputs = WorkflowInputValues & {
  readonly task: string;
  readonly verifier_count?: number;
  readonly max_repairs?: number;
  readonly criteria?: AdversarialVerificationCriteria;
  readonly accept_mean?: number;
  readonly reask_limit?: number;
};
export type AdversarialVerificationOutputs = WorkflowOutputValues & {
  readonly approved: boolean;
  readonly mean_score: number;
  readonly score_table_path: string;
  readonly repairs_completed: number;
  readonly candidate_path: string;
  readonly review_report_path: string;
  readonly remaining_work: string[];
};
export type AdversarialVerificationDefinition = WorkflowDefinition<
  AdversarialVerificationInputs,
  AdversarialVerificationOutputs,
  AdversarialVerificationRunInputs
>;
declare const workflow: AdversarialVerificationDefinition;
export default workflow;
