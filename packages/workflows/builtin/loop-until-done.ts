import { Type } from "typebox";
import { workflow } from "../src/authoring/workflow.js";
import { withSteeringPropagationContext } from "./steering-context.js";
import { runLoopUntilDone } from "./loop-until-done-runner.js";

export default workflow({
  name: "loop-until-done",
  description: "Repeat evidence-producing work and independent completion evaluation against a durable ledger until done or an inspectable iteration-limit failure.",
  // The 15-minute default, stated rather than inherited: this is a per-workflow
  // product decision, so a future change to the global default must not silently
  // re-cadence a long autonomous run.
  heartbeatIntervalMinutes: 15,
  inputs: {
    prompt: Type.String({ description: "Objective whose explicit completion condition controls the bounded loop." }),
    max_iterations: Type.Integer({
      minimum: 1,
      maximum: 20,
      default: 5,
      description: "Maximum work/evaluation iterations before returning an inspectable failed status (1-20).",
    }),
    progress_scoring: Type.Boolean({
      default: true,
      description: "Enable advisory progress scoring after each completed iteration.",
    }),
    progress_repeats: Type.Integer({
      minimum: 1,
      default: 1,
      description: "Number of advisory progress-scoring repeats per iteration.",
    }),
  },
  outputs: {
    result: Type.String({ description: "Compact reference to the evidence-backed completion report, or the deterministic exhaustion report; read `result_path` for the full report." }),
    status: Type.Union([Type.Literal("complete"), Type.Literal("failed")], {
      description: "Complete when evidence satisfies the stop condition; failed when max_iterations is exhausted.",
    }),
    iterations_completed: Type.Integer({ description: "Number of completed work/evaluation iterations." }),
    ledger_path: Type.String({ description: "Path to the durable JSON progress ledger." }),
    iteration_artifact_paths: Type.Array(Type.String(), { description: "Ordered paths to per-iteration work artifacts." }),
    evaluation_artifact_paths: Type.Array(Type.String(), { description: "Ordered paths to structured evaluation artifacts." }),
    result_path: Type.String({ description: "Path to the final report, or the ledger on exhausted failure." }),
    remaining_work: Type.String({ description: "Actionable remaining work; empty only after proven completion." }),
    artifact_dir: Type.String({ description: "Run-specific directory containing loop artifacts." }),
    progress_curve: Type.Array(Type.Number(), { description: "Advisory progress scores in iteration order." }),
    final_trend: Type.Union(
      [Type.Literal("rising"), Type.Literal("flat"), Type.Literal("regressing")],
      { description: "Final advisory trend classification; never a stop decision." },
    ),
    progress_disclaimer: Type.String({ description: "Calibration disclaimer for the advisory progress signal." }),
  },
  run: async (ctx) => await runLoopUntilDone(withSteeringPropagationContext(ctx)),
});
