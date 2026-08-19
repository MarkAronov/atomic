import { fold_usage } from "../../builtin/verification-usage.js";
import type { RunSnapshot } from "./store-types.js";
import { elapsedRunMs } from "./timing.js";

export interface RunMeterCounters {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

export interface RunMeters {
	readonly durationMs: number;
	readonly tokens: number;
	readonly cost: number;
	readonly perCounter: RunMeterCounters;
}

/** A run and its nested child scopes, used by the tree-wide usage meter. */
export type RunUsageTree =
	| { readonly run: RunSnapshot; readonly children?: readonly RunUsageTree[] }
	| (RunSnapshot & { readonly children?: readonly RunUsageTree[] });
const treeRun = (tree: RunUsageTree): RunSnapshot => ("run" in tree ? tree.run : tree);
type UsageCounters = RunMeterCounters & { readonly cost: number };
const usageFields = ["input", "output", "cacheRead", "cacheWrite", "cost"] as const;
const addUsage = (left: UsageCounters, right: UsageCounters): UsageCounters =>
	Object.fromEntries(usageFields.map((field) => [field, left[field] + right[field]])) as unknown as UsageCounters;

function foldTreeUsage(tree: RunUsageTree): UsageCounters {
	const run = treeRun(tree);
	const folded = fold_usage(
		run.stages
			.filter((stage) => stage.replayed !== true)
			.map((stage) => ({ stageName: stage.name, text: stage.result ?? "", modelAttempts: stage.modelAttempts })),
	);
	return (tree.children ?? []).reduce<UsageCounters>((total, child) => addUsage(total, foldTreeUsage(child)), folded);
}
const meterCounters = (usage: UsageCounters): RunMeterCounters => ({
	input: usage.input,
	output: usage.output,
	cacheRead: usage.cacheRead,
	cacheWrite: usage.cacheWrite,
});

/** Measure one run scope without mutating it or charging a budget. */
export function meter_run(tree: RunUsageTree, now: number): RunMeters {
	const usage = foldTreeUsage(tree);
	return {
		durationMs: elapsedRunMs(treeRun(tree), now),
		tokens: usage.input + usage.output,
		cost: usage.cost,
		perCounter: meterCounters(usage),
	};
}
