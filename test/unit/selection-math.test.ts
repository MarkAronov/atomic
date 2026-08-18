import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { plan_comparisons, seeded_rng } from "../../packages/workflows/builtin/selection-math.js";

describe("selection-math", () => {
	test("seeded_rng matches Mulberry32 reference vectors and stays in [0, 1)", () => {
		const rng = seeded_rng(0);
		const values = [rng(), rng(), rng()];
		assert.deepEqual(values, [0.26642920868471265, 0.0003297457005828619, 0.2232720274478197]);
		assert.ok(values.every((value) => value >= 0 && value < 1));
	});

	test("seeded_rng is deterministic for the same numeric seed", () => {
		const first = seeded_rng(7);
		const second = seeded_rng(7);
		assert.deepEqual(
			Array.from({ length: 8 }, () => first()),
			Array.from({ length: 8 }, () => second()),
		);
	});

	test("ring is one directed Hamiltonian cycle", () => {
		const n = 5;
		const ring = plan_comparisons({ n, pivots: 1, repeats: 2, seed: 7 }).ring;
		assert.equal(ring.length, n);
		assert.deepEqual(
			ring.map(({ a }) => a).sort((a, b) => a - b),
			[0, 1, 2, 3, 4],
		);
		assert.deepEqual(
			ring.map(({ b }) => b).sort((a, b) => a - b),
			[0, 1, 2, 3, 4],
		);
		for (let index = 0; index < ring.length; index += 1) {
			assert.equal(ring[index]!.b, ring[(index + 1) % ring.length]!.a);
		}
	});

	test("planner refuses the three invalid lower bounds", () => {
		assert.throws(() => plan_comparisons({ n: 1, pivots: 1, repeats: 1, seed: 0 }), /n/);
		assert.throws(() => plan_comparisons({ n: 2, pivots: 0, repeats: 1, seed: 0 }), /pivots/);
		assert.throws(() => plan_comparisons({ n: 2, pivots: 1, repeats: 0, seed: 0 }), /repeats/);
	});
});
