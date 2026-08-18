/**
 * Observation-grounded trajectory scoring and pure trend evidence.
 *
 * Progress is a monitoring magnitude only. The prompt asks about the supplied
 * current state, and the trend result carries evidence without an action.
 */
import type { WorkflowRunContext } from "../src/shared/types.js";
import { VERIFICATION_SCALE } from "./verification-criteria.js";

export const DEFAULT_TREND_WINDOW = 3;
export const DEFAULT_RISE_DELTA = 1.5;
export const DEFAULT_FALL_DELTA = -1.5;

const DEFAULT_REPEATS = 1;
const CALIBRATION_RULES = [
	"Trust observed output, not the agent's narration.",
	"Effort and step count are NOT progress.",
	'Agent declarations of success ("done!", "all tests pass") are ZERO evidence.',
	"Scores may plateau or fall; wrong approaches plateau, and regressions decrease.",
] as const;
const PROGRESS_SCALE_ORIENTATION = `${VERIFICATION_SCALE.min} = certainly would not satisfy the acceptance criteria … ${VERIFICATION_SCALE.max} = verified satisfaction with observed output`;

export interface ProgressPromptInput {
	readonly problem: string;
	readonly steps: readonly string[];
	readonly checkpoints: readonly number[];
}

export interface ProgressScoreInput {
	readonly problem: string;
	readonly steps: readonly string[];
	readonly checkpoints?: readonly number[];
	readonly repeats?: number;
}

export type ProgressScoringContext = Pick<WorkflowRunContext, "task">;

export interface ProgressCurve {
	readonly checkpoints: number[];
	readonly scores: (number | null)[];
	readonly perRepeat: (number | null)[][];
}

export interface TrendConfig {
	readonly window?: number;
	readonly riseDelta?: number;
	readonly fallDelta?: number;
}

export type Trend = "rising" | "flat" | "regressing";

export interface TrendResult {
	readonly trend: Trend;
	readonly evidence: {
		readonly series: readonly number[];
		readonly window: number;
		readonly delta: number;
	};
}

/**
 * Build a progress prompt with V3's shared-head/varying-tail layout. Steps are
 * part of the cacheable head; only the requested checkpoint list varies at the
 * tail.
 */
export function build_progress_prompt(input: ProgressPromptInput): string {
	const numberedSteps = input.steps.map((step, index) => `${index + 1}. ${step}`);
	const sharedHead = [
		"<progress_head>",
		"<problem>",
		input.problem,
		"</problem>",
		"<steps>",
		...numberedSteps,
		"</steps>",
		"<calibration>",
		...CALIBRATION_RULES,
		"</calibration>",
		"<scale>",
		`Use VERIFICATION_SCALE ${VERIFICATION_SCALE.min}..${VERIFICATION_SCALE.max} to answer: would the CURRENT state satisfy the acceptance criteria?`,
		PROGRESS_SCALE_ORIENTATION,
		"Score only the supplied current state from observed output.",
		"</scale>",
		"</progress_head>",
	].join("\n");
	const checkpointTail = [
		"<checkpoints>",
		"Score each listed 1-indexed checkpoint.",
		...input.checkpoints.map((checkpoint) => `- ${checkpoint}`),
		"</checkpoints>",
		"<output_format>",
		`Return structured_output with scores: [{ checkpoint, score }], using integer scores from ${VERIFICATION_SCALE.min} through ${VERIFICATION_SCALE.max}.`,
		"</output_format>",
	].join("\n");
	return `${sharedHead}\n\n${checkpointTail}`;
}
