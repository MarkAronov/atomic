import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	accumulate,
	plan_comparisons,
	rank_candidates,
	seeded_rng,
	select_pivots,
	soft_win,
} from "../../packages/workflows/builtin/selection-math.js";

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

	test("planner is deterministic and pivot rounds deduplicate ring pairs", () => {
		const input = { n: 6, pivots: 2, repeats: 2, seed: 7 };
		const first = plan_comparisons(input);
		const second = plan_comparisons(input);
		const firstPivots = first.pivotRounds([0, 1]);
		const secondPivots = second.pivotRounds([0, 1]);
		assert.deepEqual(first.ring, second.ring);
		assert.deepEqual(firstPivots, secondPivots);

		const keys = [...first.ring, ...firstPivots].map(({ a, b }) => `${Math.min(a, b)}:${Math.max(a, b)}`);
		assert.equal(new Set(keys).size, keys.length);
		assert.ok(first.ring.length + firstPivots.length <= input.n + input.pivots * (input.n - input.pivots) + 1);
	});

	test("jobs preserve pair and criterion order and swap odd repeats", () => {
		const plan = plan_comparisons({ n: 2, pivots: 1, repeats: 3, seed: 0 });
		const jobs = plan.jobs(
			[
				{ a: 2, b: 3 },
				{ a: 1, b: 0 },
			],
			["quality", "style", "quality"],
		);
		assert.equal(jobs.length, 18);
		assert.deepEqual(jobs.slice(0, 3), [
			{ a: 2, b: 3, criterionId: "quality", rep: 0, swapped: false },
			{ a: 2, b: 3, criterionId: "quality", rep: 1, swapped: true },
			{ a: 2, b: 3, criterionId: "quality", rep: 2, swapped: false },
		]);
		assert.deepEqual(
			jobs.slice(3, 6).map(({ criterionId }) => criterionId),
			["style", "style", "style"],
		);
		assert.deepEqual(
			jobs.slice(9, 12).map(({ a, b }) => [a, b]),
			[
				[1, 0],
				[1, 0],
				[1, 0],
			],
		);
		assert.deepEqual(Object.keys(jobs[0]!), ["a", "b", "criterionId", "rep", "swapped"]);
	});

	test("soft_win normalizes the 1–20 verification scale before sigmoid", () => {
		assert.equal(soft_win(10, 10), 0.5);
		assert.ok(Math.abs(soft_win(20, 1) - 0.7310585786300049) < 1e-15);
		assert.ok(Math.abs(soft_win(20, 1) + soft_win(1, 20) - 1) < 1e-15);
	});

	test("accumulate mutates win mass and counts for every preference", () => {
		const w = [0, 0, 0];
		const c = [0, 0, 0];
		const prefs = [
			{ a: 0, b: 1, p: 0.75 },
			{ a: 1, b: 2, p: 0.25 },
			{ a: 0, b: 1, p: 0.5 },
		];
		accumulate(prefs, w, c);
		assert.deepEqual(w, [1.25, 1, 0.75]);
		assert.deepEqual(c, [2, 3, 1]);
		assert.equal(
			c.reduce((total, count) => total + count, 0),
			2 * prefs.length,
		);
		assert.equal(
			w.reduce((total, preference) => total + preference, 0),
			prefs.length,
		);
	});

	test("select_pivots and rank_candidates use zero-count means and index ties", () => {
		const w = [0, 0.8, 0.4, 0];
		const c = [0, 1, 1, 0];
		assert.deepEqual(select_pivots(w, c, 3), [1, 2, 0]);
		assert.deepEqual(rank_candidates(w, c), [
			{ index: 1, meanPreference: 0.8 },
			{ index: 2, meanPreference: 0.4 },
			{ index: 0, meanPreference: 0 },
			{ index: 3, meanPreference: 0 },
		]);
		assert.equal(rank_candidates(w, c).length, w.length);
	});
	test("planner refuses the three invalid lower bounds", () => {
		assert.throws(() => plan_comparisons({ n: 1, pivots: 1, repeats: 1, seed: 0 }), /n/);
		assert.throws(() => plan_comparisons({ n: 2, pivots: 0, repeats: 1, seed: 0 }), /pivots/);
		assert.throws(() => plan_comparisons({ n: 2, pivots: 1, repeats: 0, seed: 0 }), /repeats/);
	});
});
