/**
 * Convergence evidence is observational only: it never approves, never
 * terminates, never touches `stop_review_loop`, and feeds only
 * `needs_human`-class escalation text.
 */
import type { UsageTotals } from "./verification-usage.js";
import {
	classify_trend,
	DEFAULT_FALL_DELTA,
	DEFAULT_RISE_DELTA,
	type TrendResult,
} from "./progress-scoring.js";
import { VERIFICATION_SCALE } from "./verification-criteria.js";

/**
 * `fractionProven` remains in its natural [0, 1] units. V7's hysteresis
 * thresholds span a proportional part of `VERIFICATION_SCALE`, so applying
 * that same proportion to the unit interval keeps the two series comparable
 * without hard-coding a fraction-specific magic number.
 */
export const FRACTION_TREND_RISE_DELTA =
	DEFAULT_RISE_DELTA / (VERIFICATION_SCALE.max - VERIFICATION_SCALE.min);
export const FRACTION_TREND_FALL_DELTA =
	DEFAULT_FALL_DELTA / (VERIFICATION_SCALE.max - VERIFICATION_SCALE.min);

export type ConvergenceEntry = {
	readonly unresolvedBlockingCount: number;
	readonly meanFindingConfidence: number | null;
	readonly fractionProven: number;
	readonly demotions: number;
	readonly usage: UsageTotals;
};

/** Purely shape one already-folded review round into a ledger entry. */
export function record_convergence(round: {
	readonly unresolvedBlockingCount: number;
	readonly meanFindingConfidence: number | null;
	readonly fractionProven: number;
	readonly demotions: number;
	readonly usage: UsageTotals;
}): ConvergenceEntry {
	return {
		unresolvedBlockingCount: round.unresolvedBlockingCount,
		meanFindingConfidence: round.meanFindingConfidence,
		fractionProven: round.fractionProven,
		demotions: round.demotions,
		usage: round.usage,
	};
}

export function classify_convergence(entries: readonly ConvergenceEntry[]): {
	blocking: TrendResult;
	proven: TrendResult;
} {
	return {
		blocking: classify_trend(entries.map((entry) => entry.unresolvedBlockingCount)),
		proven: classify_trend(entries.map((entry) => entry.fractionProven), {
			riseDelta: FRACTION_TREND_RISE_DELTA,
			fallDelta: FRACTION_TREND_FALL_DELTA,
		}),
	};
}

/**
 * A FALLING `unresolvedBlockingCount` (classified "regressing" on the raw
 * series) and a RISING `fractionProven` are the converging directions. A
 * rising blocking count is never suppressed because it is the worsening
 * direction on the axis the objective names first.
 */
export function convergence_escalation_evidence(
	entries: readonly ConvergenceEntry[],
): readonly string[] {
	if (entries.length === 0) return [];
	const { blocking, proven } = classify_convergence(entries);
	if (blocking.trend === "regressing" || (proven.trend === "rising" && blocking.trend !== "rising")) return [];

	const latest = entries[entries.length - 1]?.meanFindingConfidence;
	return [
		`${entries.length} round${entries.length === 1 ? "" : "s"} recorded; no observed convergence: the blocking-count trend is ${blocking.trend}.`,
		`Blocking-count trend: ${blocking.trend}; raw series: ${JSON.stringify(blocking.evidence.series)}.`,
		`Fraction-proven trend: ${proven.trend}; raw series: ${JSON.stringify(proven.evidence.series)}.`,
		latest === null
			? "Latest mean finding confidence: no findings were filed."
			: `Latest mean finding confidence: ${latest}.`,
		"This is escalation EVIDENCE only; it never approves or terminates anything.",
	];
}
