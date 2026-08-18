import type { WorkflowTaskResult } from "../src/shared/types.js";

export type UsageTotals = {
	calls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
	cacheHitRate: number;
};

export function fold_usage(results: readonly WorkflowTaskResult[]): UsageTotals {
	const totals = {
		calls: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		turns: 0,
	};

	for (const result of results) {
		for (const attempt of result.modelAttempts ?? []) {
			totals.calls += 1;
			const usage = attempt.usage;
			if (usage === undefined) continue;
			totals.input += usage.input ?? 0;
			totals.output += usage.output ?? 0;
			totals.cacheRead += usage.cacheRead ?? 0;
			totals.cacheWrite += usage.cacheWrite ?? 0;
			totals.cost += usage.cost ?? 0;
			totals.turns += usage.turns ?? 0;
		}
	}

	const cacheDenominator = totals.input + totals.cacheRead;
	return {
		...totals,
		cacheHitRate: cacheDenominator === 0 ? 0 : totals.cacheRead / cacheDenominator,
	};
}
