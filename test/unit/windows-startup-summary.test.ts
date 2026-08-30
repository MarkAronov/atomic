import assert from "node:assert/strict";
import { test } from "vitest";
import { createBalancedOrder } from "../../scripts/perf/windows-startup/benchmark.js";
import type { BenchmarkSample } from "../../scripts/perf/windows-startup/samples.js";
import { summarizeSamples } from "../../scripts/perf/windows-startup/summarize.js";

function sample(id: string, startupCompleteMs: number | undefined, state: BenchmarkSample["state"]): BenchmarkSample {
	return {
		schemaVersion: 1,
		id,
		lane: "release",
		build: "baseline",
		profile: "warm",
		state,
		command: "atomic --session-dir run --provider benchmark-loopback --model benchmark-model",
		startedAt: "2026-01-01T00:00:00.000Z",
		marksNs: {},
		metricsMs:
			startupCompleteMs === undefined
				? undefined
				: { startupCompleteMs, dispatchMs: startupCompleteMs / 2, spawnToDispatchMs: startupCompleteMs * 1.5 },
		artifactHashes: {},
		rawArtifactDirectory: `raw/${id}`,
		failures: state === "success" ? [] : [state],
	};
}

test("p95 uses nearest-rank selection", () => {
	const samples = Array.from({ length: 20 }, (_, index) => sample(String(index), index + 1, "success"));
	const summary = summarizeSamples(samples);
	assert.equal(summary.metrics.startupCompleteMs?.median, 10.5);
	assert.equal(summary.metrics.startupCompleteMs?.p95, 19);
});

test("balanced execution order is deterministic and alternates AB/BA pairs", () => {
	const order = createBalancedOrder(["baseline", "candidate"], 4, 17);
	assert.deepEqual(order, createBalancedOrder(["baseline", "candidate"], 4, 17));
	assert.deepEqual(order.slice(0, 4), [order[0], order[1], order[1], order[0]]);
	assert.equal(order.filter((build) => build === "baseline").length, 4);
	assert.equal(order.filter((build) => build === "candidate").length, 4);
});

test("invalid samples and product failures remain counted and never enter successful statistics", () => {
	const samples = [
		sample("good-a", 10, "success"),
		sample("good-b", 20, "success"),
		sample("bad", 1, "invalid"),
		sample("crash", undefined, "product-failure"),
	];
	const summary = summarizeSamples(samples);
	assert.equal(summary.totalCount, 4);
	assert.equal(summary.successCount, 2);
	assert.equal(summary.invalidCount, 1);
	assert.equal(summary.productFailureCount, 1);
	assert.equal(summary.metrics.startupCompleteMs?.median, 15);
	assert.deepEqual([...summary.excludedSampleIds].sort(), ["bad", "crash"]);
});
