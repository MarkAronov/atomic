import assert from "node:assert/strict";
import { test } from "vitest";
import { fold_usage } from "../../packages/workflows/builtin/verification-usage.js";
import type { WorkflowModelAttempt, WorkflowTaskResult } from "../../packages/workflows/src/shared/types.js";

function result(modelAttempts?: readonly WorkflowModelAttempt[]): WorkflowTaskResult {
	return {
		stageName: "stage",
		text: "",
		...(modelAttempts === undefined ? {} : { modelAttempts }),
	};
}

test("usage-fold treats absent usage fields as zero", () => {
	const totals = fold_usage([
		result(),
		result([{ model: "missing", success: false }]),
		result([{ model: "partial", success: true, usage: { input: 4, cost: 0.5 } }]),
	]);

	assert.deepEqual(totals, {
		calls: 2,
		input: 4,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0.5,
		turns: 0,
		cacheHitRate: 0,
	});
});

test("usage-fold sums every retried model attempt, including failed attempts", () => {
	const totals = fold_usage([
		result([
			{ model: "primary", success: false, usage: { input: 10, output: 2, cost: 0.1, turns: 1 } },
			{
				model: "fallback",
				success: true,
				usage: { input: 20, output: 5, cacheRead: 8, cacheWrite: 3, cost: 0.2, turns: 2 },
			},
		]),
	]);

	assert.deepEqual(totals, {
		calls: 2,
		input: 30,
		output: 7,
		cacheRead: 8,
		cacheWrite: 3,
		cost: 0.1 + 0.2,
		turns: 3,
		cacheHitRate: 8 / 38,
	});
});

test("usage-fold derives cache hit rate from folded totals and guards zero denominator", () => {
	assert.equal(
		fold_usage([result([{ model: "cached", success: true, usage: { input: 6, cacheRead: 4 } }])]).cacheHitRate,
		0.4,
	);
	assert.equal(fold_usage([result([{ model: "empty", success: true, usage: {} }])]).cacheHitRate, 0);
});

test("usage-fold returns all zero totals for an empty set", () => {
	assert.deepEqual(fold_usage([]), {
		calls: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		turns: 0,
		cacheHitRate: 0,
	});
});
