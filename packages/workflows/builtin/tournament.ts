import { Type } from "typebox";
import { workflow } from "../src/authoring/workflow.js";
import { withSteeringPropagationContext } from "./steering-context.js";
import { runTournament } from "./tournament-runner.js";

export default workflow({
	name: "tournament",
	description: "Run independent whole-task attempts through a soft-scored pivot-pairing schedule and return an auditable ranking.",
	// The 15-minute default, stated rather than inherited: this is a per-workflow
	// product decision, so a future change to the global default must not silently
	// re-cadence a long autonomous run.
	heartbeatIntervalMinutes: 15,
	inputs: {
		prompt: Type.String({ description: "Task every competing agent must attempt independently." }),
		num_attempts: Type.Integer({
			minimum: 2,
			maximum: 8,
			default: 4,
			description: "Number of independent whole-task attempts (2-8).",
		}),
		max_concurrency: Type.Integer({
			minimum: 1,
			maximum: 8,
			default: 4,
			description: "Maximum simultaneously active attempts or pairwise judges (1-8).",
		}),
		n_evaluations: Type.Integer({
			minimum: 1,
			default: 2,
			description: "Number of repeated evaluations per criterion and directed pair.",
		}),
		pivots: Type.Integer({
			minimum: 1,
			default: 1,
			description: "Number of pivot candidates used for the second comparison phase.",
		}),
		seed: Type.Integer({
			default: 0,
			description: "Seed for the deterministic comparison schedule.",
		}),
		criteria: Type.Optional(Type.Union([
			Type.String(),
			Type.Record(Type.String(), Type.String()),
			Type.Array(Type.String()),
			Type.Array(Type.Object({
				id: Type.Optional(Type.String()),
				name: Type.Optional(Type.String()),
				description: Type.String(),
			}, { additionalProperties: true })),
		], {
			description: "Optional V1 judge criteria; accepts a markdown rubric, record, string list, or CriterionInput list; omitted uses the default three-criterion rubric.",
		})),
		models: Type.Optional(Type.Array(Type.String(), {
			description: "Optional ordered model ids assigned round-robin to attempt slots.",
		})),
	},
	outputs: {
		result: Type.String({ description: "Compact reference to the final reducer report; read `result_path` for the full report." }),
		winner: Type.String({ description: "Stable attempt label selected as the top-ranked tournament winner." }),
		winner_artifact_path: Type.String({ description: "Path to the original winning attempt artifact." }),
		result_path: Type.String({ description: "Path to the final reducer report artifact." }),
		attempt_artifact_paths: Type.Array(Type.String(), { description: "Paths to every independent attempt artifact." }),
		judge_artifact_paths: Type.Array(Type.String(), { description: "Paths to all per-job structured judge artifacts." }),
		comparisons_path: Type.String({ description: "Path to the durable JSON soft-scored comparisons ledger." }),
		ranking: Type.Array(Type.Object({
			label: Type.String(),
			meanPreference: Type.Number(),
		}, { additionalProperties: false }), { description: "All attempts ordered by mean preference." }),
		seed: Type.Integer({ description: "Seed used for the deterministic comparison schedule." }),
		artifact_dir: Type.String({ description: "Run-specific directory containing tournament artifacts." }),
	},
	run: async (ctx) => await runTournament(withSteeringPropagationContext(ctx)),
});
