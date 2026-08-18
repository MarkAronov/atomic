import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { nextLongRunningTrigger } from "../../packages/subagents/src/runs/shared/long-running-guard.js";
import {
	classify_trend as classifySubagentTrend,
	FLAT_LOW_SCORE_CEILING,
	PROGRESS_ATTENTION_THRESHOLD_FRACTION,
	DEFAULT_FALL_DELTA as subagentFallDelta,
	DEFAULT_RISE_DELTA as subagentRiseDelta,
	DEFAULT_TREND_WINDOW as subagentTrendWindow,
} from "../../packages/subagents/src/runs/shared/progress-trend.js";
import {
	DEFAULT_CONTROL_CONFIG,
	deriveActivityState,
	resolveControlConfig,
} from "../../packages/subagents/src/runs/shared/subagent-control.js";
import type { ResolvedControlConfig } from "../../packages/subagents/src/shared/types-results.js";
import {
	classify_trend as classifyWorkflowTrend,
	DEFAULT_FALL_DELTA as workflowFallDelta,
	DEFAULT_RISE_DELTA as workflowRiseDelta,
	DEFAULT_TREND_WINDOW as workflowTrendWindow,
} from "../../packages/workflows/builtin/progress-scoring.js";

const TREND_CASES = [
	{ name: "rising boundary", series: [1, 1, 1, 2.5, 2.5, 2.5] },
	{ name: "regressing boundary", series: [2.5, 2.5, 2.5, 1, 1, 1] },
	{ name: "alternating noise", series: [6, 10, 6, 10, 6, 10] },
	{ name: "short series", series: [5, 6, 7] },
	{ name: "paper low and flat failure", series: [5, 5, 6, 5, 5, 6] },
];

function controlConfig(progressScores?: number[]): ResolvedControlConfig {
	return {
		...DEFAULT_CONTROL_CONFIG,
		...(progressScores === undefined ? {} : { progressScores }),
		notifyOn: [...DEFAULT_CONTROL_CONFIG.notifyOn],
		notifyChannels: [...DEFAULT_CONTROL_CONFIG.notifyChannels],
	};
}

describe("subagents progress attention", () => {
	test("progress trend copies produce identical mirrored table results", () => {
		assert.equal(subagentTrendWindow, workflowTrendWindow);
		assert.equal(subagentRiseDelta, workflowRiseDelta);
		assert.equal(subagentFallDelta, workflowFallDelta);
		for (const testCase of TREND_CASES) {
			assert.deepEqual(
				classifySubagentTrend(testCase.series),
				classifyWorkflowTrend(testCase.series),
				testCase.name,
			);
		}
		assert.equal(classifySubagentTrend(TREND_CASES[4]!.series).trend, "flat");
		assert.notEqual(classifySubagentTrend(TREND_CASES[4]!.series).trend, "regressing");
	});

	test("progress control config preserves score-series precedence and ordering", () => {
		const globalScores = [12, 11, 10];
		const overrideScores = [5, 5, 6];
		const resolved = resolveControlConfig({ progressScores: globalScores }, { progressScores: overrideScores });
		assert.deepEqual(resolved.progressScores, overrideScores);
		assert.notStrictEqual(resolved.progressScores, overrideScores);
		assert.deepEqual(resolveControlConfig({ progressScores: globalScores }).progressScores, globalScores);
		assert.deepEqual(resolveControlConfig(undefined, { progressScores: [] }).progressScores, []);
	});

	test("progress trend raises attention priority without creating a failure state", () => {
		const baseline = controlConfig();
		const lowFlat = controlConfig([5, 5, 6, 5, 5, 6]);
		const startedAt = 1_000_000;
		const baselineState = deriveActivityState({ config: baseline, startedAt, now: startedAt + 31_000 });
		const raisedState = deriveActivityState({ config: lowFlat, startedAt, now: startedAt + 31_000 });
		assert.equal(baselineState, undefined);
		assert.equal(raisedState, "needs_attention");
		assert.equal(FLAT_LOW_SCORE_CEILING, 8);
		assert.equal(PROGRESS_ATTENTION_THRESHOLD_FRACTION, 0.5);
		assert.notEqual(raisedState, "failed");
	});

	test("progress trend preserves every prior wall-clock attention signal", () => {
		const baseline = controlConfig();
		const progress = controlConfig([10, 10, 10, 5, 5, 5]);
		const startedAt = 2_000_000;
		for (const elapsedMs of [60_001, 120_000, 240_000, 300_000]) {
			assert.equal(
				deriveActivityState({ config: progress, startedAt, now: startedAt + elapsedMs }),
				deriveActivityState({ config: baseline, startedAt, now: startedAt + elapsedMs }),
				`needs-attention wall-clock row ${elapsedMs}`,
			);
		}
		for (const elapsedMs of [240_000, 300_000]) {
			assert.equal(
				nextLongRunningTrigger(progress, { startedAt, now: startedAt + elapsedMs, turns: 0, tokens: 0 }),
				nextLongRunningTrigger(baseline, { startedAt, now: startedAt + elapsedMs, turns: 0, tokens: 0 }),
				`active-long-running wall-clock row ${elapsedMs}`,
			);
		}
		assert.equal(
			nextLongRunningTrigger(progress, { startedAt, now: startedAt, turns: 3, tokens: 0 }),
			nextLongRunningTrigger(baseline, { startedAt, now: startedAt, turns: 3, tokens: 0 }),
		);
		assert.equal(
			nextLongRunningTrigger(progress, { startedAt, now: startedAt, turns: 0, tokens: 3 }),
			nextLongRunningTrigger(baseline, { startedAt, now: startedAt, turns: 0, tokens: 3 }),
		);
	});

	test("progress trend evidence is actionless and cannot mutate run status", () => {
		const config = controlConfig([5, 5, 6, 5, 5, 6]);
		const before = JSON.stringify(config);
		const trend = classifySubagentTrend(config.progressScores ?? []);
		const state = deriveActivityState({ config, startedAt: 3_000_000, now: 3_031_000 });
		assert.deepEqual(Object.keys(trend), ["trend", "evidence"]);
		assert.equal("action" in trend, false);
		assert.equal("failed" in trend, false);
		assert.ok(state === undefined || state === "active_long_running" || state === "needs_attention");
		assert.equal(JSON.stringify(config), before);
	});
});
