// @ts-nocheck

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
	accumulate,
	plan_comparisons,
	rank_candidates,
	select_pivots,
	soft_win,
} from "../../packages/workflows/builtin/selection-math.js";
import {
	assertOutputTypes,
	assertWorkflowDefinition,
	fieldDefault,
	fieldKind,
	fieldRequired,
	makeMockCtx,
} from "./builtin-workflows-helpers.js";

let tempCwd = "";
beforeEach(() => {
	tempCwd = mkdtempSync(join(tmpdir(), "atomic-pattern-builtins-"));
});
afterEach(() => {
	rmSync(tempCwd, { recursive: true, force: true });
});

function withCwd<T extends object>(ctx: T): T & { cwd: string } {
	return Object.assign(ctx, { cwd: tempCwd });
}

describe("tournament builtin", () => {
	test("declares bounded defaults and the soft-scored outputs", async () => {
		const { default: definition } = await import("../../packages/workflows/builtin/tournament.js");
		assertWorkflowDefinition(definition);
		assert.equal(definition.name, "tournament");
		assert.equal(fieldRequired(definition.inputs.prompt), true);
		assert.equal(fieldKind(definition.inputs.num_attempts), "integer");
		assert.equal(fieldDefault(definition.inputs.num_attempts), 4);
		assert.equal(fieldDefault(definition.inputs.max_concurrency), 4);
		assert.equal(fieldDefault(definition.inputs.n_evaluations), 2);
		assert.equal(fieldDefault(definition.inputs.pivots), 1);
		assert.equal(fieldDefault(definition.inputs.seed), 0);
		assert.equal(definition.inputs.num_attempts.minimum, 2);
		assert.equal(definition.inputs.num_attempts.maximum, 8);
		assert.equal(definition.inputs.n_evaluations.minimum, 1);
		assert.equal(definition.inputs.pivots.minimum, 1);
		assert.equal(fieldKind(definition.inputs.criteria), "array");
		assert.equal(fieldKind(definition.inputs.models), "array");
		assertOutputTypes(definition.outputs, {
			result: "text",
			winner: "text",
			winner_artifact_path: "text",
			result_path: "text",
			attempt_artifact_paths: "array",
			judge_artifact_paths: "array",
			comparisons_path: "text",
			ranking: "array",
			seed: "integer",
			artifact_dir: "text",
		});
	});

	function validJudgeReport(): string {
		return JSON.stringify({
			criterion_id: "correctness",
			score_a: 18,
			score_b: 6,
			evidence: ["observable evidence"],
		});
	}

	test("runs the ring and pivot phases and writes a complete comparisons ledger", async () => {
		const { default: definition } = await import("../../packages/workflows/builtin/tournament.js");
		const ctx = withCwd(
			makeMockCtx(
				{
					prompt: "Design a safe migration",
					num_attempts: 4,
					max_concurrency: 2,
					n_evaluations: 2,
					pivots: 1,
					seed: 7,
				},
				{ task: (name) => (name.startsWith("judge-") ? validJudgeReport() : undefined) },
			),
		);
		const output = await definition.run(ctx);
		assert.deepEqual(ctx.calls.parallel[0], ["attempt-1", "attempt-2", "attempt-3", "attempt-4"]);
		assert.ok(ctx.calls.task.some((name) => name.startsWith("judge-0-")));
		assert.ok(ctx.calls.task.some((name) => name.endsWith("-r1")));
		assert.ok(ctx.calls.task.includes("comparisons-reducer"));
		const firstJudgeName = ctx.calls.task.find((name) => name.startsWith("judge-"));
		assert.notEqual(firstJudgeName, undefined);
		const firstJudge = ctx.calls.taskOptions[firstJudgeName!][0];
		assert.match(firstJudge.prompt, /<scoring_head>/);
		assert.match(firstJudge.prompt, /<criterion>/);
		assert.equal(firstJudge.context, "fresh");
		assert.equal(firstJudge.reads.length, 0);
		const ledger = JSON.parse(readFileSync(output.comparisons_path, "utf8"));
		assert.equal(ledger.seed, 7);
		assert.equal(ledger.params.n, 4);
		assert.equal(ledger.params.n_evaluations, 2);
		assert.equal(ledger.params.criteria.length, 3);
		assert.ok(ledger.comparisons.length > 0);
		assert.equal(
			ledger.comparisons.every((entry) => entry.invalid === true || typeof entry.score_a === "number"),
			true,
		);
		assert.equal(
			ledger.comparisons.every((entry) => entry.judge_artifact_path.endsWith(".json")),
			true,
		);
		const schedule = plan_comparisons({
			n: ledger.params.n,
			pivots: ledger.params.pivots,
			repeats: ledger.params.n_evaluations,
			seed: ledger.seed,
		});
		const ringGroups = new Map();
		for (const entry of ledger.comparisons) {
			if (entry.phase !== "ring") continue;
			const key = `${entry.a}:${entry.b}`;
			const records = ringGroups.get(key) ?? [];
			records.push(entry);
			ringGroups.set(key, records);
		}
		const ringPreferences = [];
		for (const records of ringGroups.values()) {
			const valid = records.filter((entry) => entry.invalid !== true && typeof entry.score_a === "number");
			const first = records[0];
			const p =
				valid.length === 0
					? 0.5
					: soft_win(
							valid.reduce((sum, entry) => sum + entry.score_a, 0) / valid.length,
							valid.reduce((sum, entry) => sum + entry.score_b, 0) / valid.length,
						);
			ringPreferences.push({ a: first.a, b: first.b, p });
		}
		const ringWeights = Array.from({ length: ledger.params.n }, () => 0);
		const ringCounts = Array.from({ length: ledger.params.n }, () => 0);
		accumulate(ringPreferences, ringWeights, ringCounts);
		const recordedPivots = select_pivots(ringWeights, ringCounts, ledger.params.pivots);
		const expectedJobs =
			schedule.jobs(
				schedule.ring,
				ledger.params.criteria.map((criterion) => criterion.id),
			).length +
			schedule.jobs(
				schedule.pivotRounds(recordedPivots),
				ledger.params.criteria.map((criterion) => criterion.id),
			).length;
		assert.equal(ledger.comparisons.length, expectedJobs);
		const n = ledger.params.n;
		const k = ledger.params.pivots;
		const repeats = ledger.params.n_evaluations;
		assert.equal(
			ledger.budget.planned,
			(n + k * (n - k) + (k * (k - 1)) / 2) * ledger.params.criteria.length * repeats,
		);
		assert.ok(ledger.budget.executed >= ledger.comparisons.length);
		assert.equal(ledger.ranking.length, 4);
		assert.equal(output.winner, ledger.ranking[0].label);
		assert.equal(output.judge_artifact_paths.length, ledger.comparisons.length);
		assert.equal(output.attempt_artifact_paths.length, 4);
	});

	test("re-asks one invalid report and excludes a fully invalid pair", async () => {
		const { default: definition } = await import("../../packages/workflows/builtin/tournament.js");
		let invalidPair = "";
		let firstJudge = "";
		let firstPair = "";
		const ctx = withCwd(
			makeMockCtx(
				{ prompt: "Compare fixtures", num_attempts: 2, max_concurrency: 2, n_evaluations: 1, pivots: 1, seed: 3 },
				{
					task: (name) => {
						if (!name.startsWith("judge-")) return undefined;
						const pair = name.match(/^judge-(\d+)-(\d+)-/);
						const pairPrefix = pair === null ? "" : `judge-${pair[1]}-${pair[2]}-`;
						if (firstJudge === "") {
							firstJudge = name;
							firstPair = pairPrefix;
							return "garbage";
						}
						if (name === `${firstJudge}-reask`) return validJudgeReport();
						if (invalidPair === "" && pairPrefix !== firstPair) invalidPair = pairPrefix;
						if (name.startsWith(invalidPair)) return "garbage";
						return validJudgeReport();
					},
				},
			),
		);
		const output = await definition.run(ctx);
		assert.ok(ctx.calls.task.includes(`${firstJudge}-reask`));
		const ledger = JSON.parse(readFileSync(output.comparisons_path, "utf8"));
		assert.ok(ledger.comparisons.some((entry) => entry.invalid === true));
		assert.ok(ledger.comparisons.some((entry) => entry.invalid !== true && typeof entry.score_a === "number"));
		const invalidRecords = ledger.comparisons.filter((entry) => entry.invalid === true);
		assert.ok(invalidRecords.length > 0);
		assert.equal(
			invalidRecords.every((entry) => entry.score_a === undefined && entry.score_b === undefined),
			true,
		);
		const invalidPairRecord = ledger.pairs.find(
			(pair) => pair.a === invalidRecords[0].a && pair.b === invalidRecords[0].b,
		);
		assert.equal(invalidPairRecord.invalid, true);
		assert.equal(invalidPairRecord.valid_reports, 0);
		assert.equal(invalidPairRecord.p_ab, 0.5);
		const reaskCount = ctx.calls.task.filter((name) => name.endsWith("-reask")).length;
		assert.ok(reaskCount > 0);
		assert.ok(ledger.budget.executed >= ledger.comparisons.length);
		assert.equal(ledger.budget.executed, ledger.comparisons.length + reaskCount);
	});

	test("maps swapped slot scores back to candidate order and recomputes ranking from comparisons", async () => {
		const { default: definition } = await import("../../packages/workflows/builtin/tournament.js");
		const ctx = withCwd(
			makeMockCtx(
				{ prompt: "Rank fixtures", num_attempts: 3, max_concurrency: 2, n_evaluations: 2, pivots: 1, seed: 11 },
				{ task: (name) => (name.startsWith("judge-") ? validJudgeReport() : undefined) },
			),
		);
		const output = await definition.run(ctx);
		const ledger = JSON.parse(readFileSync(output.comparisons_path, "utf8"));
		const swapped = ledger.comparisons.find((entry) => entry.swapped === true && entry.invalid !== true);
		assert.equal(swapped.score_a, 6);
		assert.equal(swapped.score_b, 18);
		const weights = Array.from({ length: ledger.params.n }, () => 0);
		const counts = Array.from({ length: ledger.params.n }, () => 0);
		const grouped = new Map();
		for (const entry of ledger.comparisons) {
			const key = `${entry.a}:${entry.b}:${entry.phase}`;
			const records = grouped.get(key) ?? [];
			records.push(entry);
			grouped.set(key, records);
		}
		for (const records of grouped.values()) {
			const valid = records.filter((entry) => entry.invalid !== true && typeof entry.score_a === "number");
			const first = records[0];
			const p =
				valid.length === 0
					? 0.5
					: soft_win(
							valid.reduce((sum, entry) => sum + entry.score_a, 0) / valid.length,
							valid.reduce((sum, entry) => sum + entry.score_b, 0) / valid.length,
						);
			accumulate([{ a: first.a, b: first.b, p }], weights, counts);
		}
		assert.deepEqual(weights, ledger.w);
		assert.deepEqual(counts, ledger.c);
		const expectedRanking = rank_candidates(weights, counts).map((entry) => ({
			label: `attempt-${entry.index + 1}`,
			index: entry.index,
			meanPreference: entry.meanPreference,
		}));
		assert.deepEqual(expectedRanking, ledger.ranking);
	});

	test("keeps the seeded ledger schedule stable and records model round-robin assignments", async () => {
		const { default: definition } = await import("../../packages/workflows/builtin/tournament.js");
		const run = async () => {
			const ctx = withCwd(
				makeMockCtx(
					{
						prompt: "Compare models",
						num_attempts: 3,
						max_concurrency: 2,
						n_evaluations: 1,
						pivots: 1,
						seed: 19,
						models: ["model-a", "model-b"],
					},
					{ task: (name) => (name.startsWith("judge-") ? validJudgeReport() : undefined) },
				),
			);
			const output = await definition.run(ctx);
			const ledger = JSON.parse(readFileSync(output.comparisons_path, "utf8"));
			return {
				ledger: {
					...ledger,
					comparisons: ledger.comparisons.map(({ judge_artifact_path, ...entry }) => entry),
					pairs: ledger.pairs,
				},
				ctx,
			};
		};
		const first = await run();
		const second = await run();
		assert.deepEqual(first.ledger, second.ledger);
		assert.deepEqual(first.ledger.model_assignment, {
			"attempt-1": "model-a",
			"attempt-2": "model-b",
			"attempt-3": "model-a",
		});
		assert.equal(first.ctx.calls.taskOptions["attempt-1"][0].model, "model-a");
		assert.equal(first.ctx.calls.taskOptions["attempt-2"][0].model, "model-b");
		assert.equal(first.ctx.calls.taskOptions["attempt-3"][0].model, "model-a");
	});
});

describe("loop-until-done builtin", () => {
	test("declares a bounded loop and precise composable output contract", async () => {
		const { default: definition } = await import("../../packages/workflows/builtin/loop-until-done.js");
		assertWorkflowDefinition(definition);
		assert.equal(definition.name, "loop-until-done");
		assert.equal(fieldRequired(definition.inputs.prompt), true);
		assert.equal(fieldDefault(definition.inputs.max_iterations), 5);
		assert.equal(definition.inputs.max_iterations.minimum, 1);
		assert.equal(definition.inputs.max_iterations.maximum, 20);
		assertOutputTypes(definition.outputs, {
			result: "text",
			status: "select",
			iterations_completed: "integer",
			ledger_path: "text",
			iteration_artifact_paths: "array",
			evaluation_artifact_paths: "array",
			result_path: "text",
			remaining_work: "text",
			artifact_dir: "text",
		});
	});

	test("persists progress and stops only after an evidence-backed done decision", async () => {
		const { default: definition } = await import("../../packages/workflows/builtin/loop-until-done.js");
		const ctx = withCwd(
			makeMockCtx(
				{ prompt: "Make every check pass", max_iterations: 3 },
				{
					task: (name) => {
						if (name === "evaluate-1")
							return JSON.stringify({
								done: false,
								summary: "one remains",
								new_findings: ["lint"],
								failures: ["lint failed"],
								validation_evidence: ["tests pass"],
								remaining_work: "fix lint",
							});
						if (name === "evaluate-2")
							return JSON.stringify({
								done: true,
								summary: "all pass",
								new_findings: [],
								failures: [],
								validation_evidence: ["tests pass", "lint passes"],
								remaining_work: "",
							});
						return undefined;
					},
				},
			),
		);
		const output = await definition.run(ctx);
		assert.equal(output.status, "complete");
		assert.equal(output.iterations_completed, 2);
		assert.deepEqual(ctx.calls.task.slice(0, 5), [
			"iteration-1",
			"evaluate-1",
			"iteration-2",
			"evaluate-2",
			"completion-summary",
		]);
		assert.equal(ctx.calls.taskOptions["evaluate-1"][0].context, "fresh");
		assert.equal(ctx.calls.taskOptions["evaluate-1"][0].output, undefined);
		const evaluation = JSON.parse(readFileSync(output.evaluation_artifact_paths[0], "utf8"));
		assert.deepEqual(evaluation, {
			done: false,
			summary: "one remains",
			new_findings: ["lint"],
			failures: ["lint failed"],
			validation_evidence: ["tests pass"],
			remaining_work: "fix lint",
		});
		assert.ok(ctx.calls.taskOptions["iteration-2"][0].reads.includes(output.ledger_path));
		const ledger = JSON.parse(readFileSync(output.ledger_path, "utf8"));
		assert.equal(ledger.status, "complete");
		assert.equal(ledger.entries[0].failures[0], "lint failed");
		assert.deepEqual(ledger.entries[1].validation_evidence, ["tests pass", "lint passes"]);
	});

	test("returns inspectable failed exhaustion with ledger and remaining work", async () => {
		const { default: definition } = await import("../../packages/workflows/builtin/loop-until-done.js");
		const ctx = withCwd(
			makeMockCtx(
				{ prompt: "Finish safely", max_iterations: 1 },
				{
					task: (name) =>
						name === "evaluate-1"
							? JSON.stringify({
									done: false,
									summary: "not done",
									new_findings: [],
									failures: ["check failed"],
									validation_evidence: [],
									remaining_work: "repair check",
								})
							: undefined,
				},
			),
		);
		const output = await definition.run(ctx);
		assert.equal(output.status, "failed");
		assert.equal(output.remaining_work, "repair check");
		assert.equal(output.result_path, output.ledger_path);
		const ledger = JSON.parse(readFileSync(output.ledger_path, "utf8"));
		assert.equal(ledger.status, "failed");
		assert.equal(ledger.iterations_completed, 1);
	});
});
