import assert from "node:assert/strict";
import { test } from "vitest";
import {
	packRoutingBatches,
	seededCandidateOrder,
} from "../../packages/coding-agent/src/core/model-routing-tournament.js";

const groups = Array.from({ length: 10 }, (_, index) => ({ model: `provider/model-${index}`, size: index + 1 }));
const fitsUnder = (limit: number) => (batch: readonly { size: number }[]) =>
	batch.reduce((total, group) => total + group.size, 0) <= limit;

test("batches keep input order and never exceed the budget", () => {
	const batches = packRoutingBatches(groups, fitsUnder(12));
	assert.deepEqual(batches.flat(), groups);
	for (const batch of batches) assert.ok(fitsUnder(12)(batch));
	assert.deepEqual(
		batches.map((batch) => batch.map((group) => group.size)),
		[[1, 2, 3, 4], [5, 6], [7], [8], [9], [10]],
	);
});

test("a group larger than the budget still gets its own batch instead of being dropped", () => {
	assert.deepEqual(
		packRoutingBatches(groups.slice(8), fitsUnder(5)).map((batch) => batch.map((group) => group.size)),
		[[9], [10]],
	);
});

test("everything that fits stays in one batch", () => {
	assert.equal(packRoutingBatches(groups, fitsUnder(1_000)).length, 1);
});

test("seeded order is a stable permutation that depends on the seed, not the input order", () => {
	const first = seededCandidateOrder(groups, "review the parser");
	assert.deepEqual(seededCandidateOrder([...groups].reverse(), "review the parser"), first);
	assert.deepEqual(
		[...first].sort((a, b) => a.size - b.size),
		groups,
	);
	assert.notDeepEqual(seededCandidateOrder(groups, "explore the repository"), first);
});
