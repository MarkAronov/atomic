import { Type } from "typebox";
import { workflow } from "../src/authoring/workflow.js";
import { withSteeringPropagationContext } from "./steering-context.js";
import { DEFAULT_CRITERIA, runAdversarialVerification } from "./adversarial-verification-runner.js";

export default workflow({
  name: "adversarial-verification",
  description: "Produce a candidate, score independent per-criterion verifier reports, and apply a deterministic mean-and-veto gate with bounded repairs.",
  // The 15-minute default, stated rather than inherited: this is a per-workflow
  // product decision, so a future change to the global default must not silently
  // re-cadence a long autonomous run.
  heartbeatIntervalMinutes: 15,
  inputs: {
    task: Type.String({ description: "Task whose candidate result must be independently verified." }),
    verifier_count: Type.Integer({ minimum: 1, maximum: 5, default: 3, description: "Number of independent verifiers for each criterion per round." }),
    max_repairs: Type.Integer({ minimum: 0, maximum: 5, default: 2, description: "Maximum candidate repair rounds before rejection." }),
    criteria: Type.Union([
      Type.String(),
      Type.Record(Type.String(), Type.String()),
    ], { default: DEFAULT_CRITERIA, description: "Criteria record of name-to-description entries, or criteria.md markdown." }),
    accept_mean: Type.Number({ minimum: 1, maximum: 20, default: 14, description: "Mean score required for acceptance on the 1–20 verification scale." }),
    reask_limit: Type.Integer({ minimum: 0, default: 1, description: "Maximum bounded re-ask waves for invalid criterion reports." }),
  },
  outputs: {
    approved: Type.Boolean({ description: "Whether the deterministic mean-and-veto gate accepted the candidate." }),
    mean_score: Type.Number({ description: "Mean score of the final round's schema-valid criterion reports." }),
    score_table_path: Type.String({ description: "Path to the final round per-criterion score summary." }),
    repairs_completed: Type.Integer({ description: "Number of repair rounds performed." }),
    candidate_path: Type.String({ description: "Path to the final candidate artifact." }),
    review_report_path: Type.String({ description: "Path to the final consolidated findings or quorum report." }),
    remaining_work: Type.Array(Type.String(), { description: "Unresolved findings or quorum evidence when not approved." }),
  },
  run: async (ctx) => await runAdversarialVerification(withSteeringPropagationContext(ctx)),
});
