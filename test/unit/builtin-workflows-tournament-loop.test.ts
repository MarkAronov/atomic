// @ts-nocheck

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
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
	test("declares bounded defaulted inputs and parent-consumable outputs", async () => {
		const { default: definition } = await import("../../packages/workflows/builtin/tournament.js");
		assertWorkflowDefinition(definition);
		assert.equal(definition.name, "tournament");
		assert.equal(fieldRequired(definition.inputs.prompt), true);
		assert.equal(fieldKind(definition.inputs.num_attempts), "integer");
		assert.equal(fieldDefault(definition.inputs.num_attempts), 4);
		assert.equal(fieldDefault(definition.inputs.max_concurrency), 4);
		assert.equal(definition.inputs.num_attempts.minimum, 2);
		assert.equal(definition.inputs.num_attempts.maximum, 8);
		assertOutputTypes(definition.outputs, {
			result: "text",
			winner: "text",
			winner_artifact_path: "text",
			result_path: "text",
			attempt_artifact_paths: "array",
			judge_artifact_paths: "array",
			bracket_path: "text",
			artifact_dir: "text",
		});
	});

	test("runs attempts, balanced pairwise judges, and an auditable bracket reducer", async () => {
		const { default: definition } = await import("../../packages/workflows/builtin/tournament.js");
		const ctx = withCwd(
			makeMockCtx(
				{ prompt: "Design a safe migration", num_attempts: 4, max_concurrency: 2 },
				{
					task: (name) =>
						name.startsWith("judge-")
							? JSON.stringify({
									winner: "first",
									rationale: `rubric ${name}`,
									evidence: ["observable evidence"],
								})
							: undefined,
				},
			),
		);
		const output = await definition.run(ctx);
		assert.deepEqual(ctx.calls.parallel[0], ["attempt-1", "attempt-2", "attempt-3", "attempt-4"]);
		assert.ok(ctx.calls.parallel.some((names) => names.includes("judge-round-1-match-1")));
		assert.ok(ctx.calls.parallel.some((names) => names.includes("judge-round-2-match-1")));
		assert.ok(ctx.calls.task.includes("bracket-reducer"));
		const firstJudge = ctx.calls.taskOptions["judge-round-1-match-1"][0];
		const secondJudge = ctx.calls.taskOptions["judge-round-1-match-2"][0];
		assert.match(firstJudge.prompt, /First presentation: attempt-1/);
		assert.match(secondJudge.prompt, /First presentation: attempt-4/);
		assert.equal(firstJudge.context, "fresh");
		assert.equal(firstJudge.reads.length, 2);
		const judgeReport = JSON.parse(readFileSync(join(output.artifact_dir, "judges", "round-1-match-1.json"), "utf8"));
		assert.equal(judgeReport.winner, "first");
		assert.equal(judgeReport.rationale, "rubric judge-round-1-match-1");
		assert.deepEqual(judgeReport.evidence, ["observable evidence"]);
		const bracket = JSON.parse(readFileSync(output.bracket_path, "utf8"));
		assert.equal(bracket.matches.length, 3);
		assert.equal(bracket.winner.label, output.winner);
		assert.equal(output.attempt_artifact_paths.length, 4);
		assert.equal(output.judge_artifact_paths.length, 3);
	});
});

describe("loop-until-done builtin", () => {
	test("declares bounded progress loop inputs and outputs", async () => {
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
			progress_curve: "array",
			final_trend: "select",
			progress_disclaimer: "text",
		});
	});

	test("persists progress and stops only after an evidence-backed done decision", async () => {
		const { default: definition } = await import("../../packages/workflows/builtin/loop-until-done.js");
		let progressScore = 0;
		const ctx = withCwd(
			makeMockCtx(
				{ prompt: "Make every check pass", max_iterations: 3 },
				{
					task: (name) => {
						if (name.startsWith("progress-score-")) {
							progressScore += 1;
							return {
								text: "",
								structured: { scores: [{ checkpoint: progressScore, score: progressScore === 1 ? 5 : 10 }] },
							};
						}
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
		assert.deepEqual(ctx.calls.task, [
			"iteration-1",
			"evaluate-1",
			"progress-score-1",
			"iteration-2",
			"evaluate-2",
			"progress-score-1",
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
		assert.deepEqual(
			ledger.entries.map((entry) => entry.progress.score),
			[5, 10],
		);
		assert.deepEqual(ledger.entries[0].failures, ["lint failed"]);
		assert.deepEqual(ledger.entries[1].validation_evidence, ["tests pass", "lint passes"]);
		assert.deepEqual(output.progress_curve, [5, 10]);
		assert.equal(output.final_trend, "flat");
		assert.equal(
			output.progress_disclaimer,
			"Progress scores are a monitoring signal; VOC separation +0.079; never authoritative.",
		);
		assert.match(output.result, /Progress curve: \[5,10\]/);
		assert.match(output.result, /Final trend: flat/);
	});

	test("returns inspectable failed exhaustion with progress report and remaining work", async () => {
		const { default: definition } = await import("../../packages/workflows/builtin/loop-until-done.js");
		const ctx = withCwd(
			makeMockCtx(
				{ prompt: "Finish safely", max_iterations: 1 },
				{
					task: (name) =>
						name.startsWith("progress-score-")
							? { text: "", structured: { scores: [{ checkpoint: 1, score: 4 }] } }
							: name === "evaluate-1"
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
		assert.deepEqual(output.progress_curve, [4]);
		assert.equal(output.final_trend, "flat");
		assert.match(output.result, /Progress curve: \[4\]/);
		const ledger = JSON.parse(readFileSync(output.ledger_path, "utf8"));
		assert.equal(ledger.status, "failed");
		assert.equal(ledger.iterations_completed, 1);
		assert.deepEqual(ledger.progress_curve, [4]);
		assert.equal(ledger.progress_disclaimer, output.progress_disclaimer);
	});

	test("keeps loop decisions unchanged when progress scoring is disabled or throws", async () => {
		const { default: definition } = await import("../../packages/workflows/builtin/loop-until-done.js");
		const decisions = async (progress_scoring: boolean, throws: boolean, working = false) => {
			let checkpoint = 0;
			const ctx = withCwd(
				makeMockCtx(
					{ prompt: "Bounded fixture", max_iterations: 2, progress_scoring },
					{
						task: (name) => {
							if (name.startsWith("progress-score-")) {
								if (throws) throw new Error("stub scorer failed");
								checkpoint += 1;
								return {
									text: "",
									structured: { scores: [{ checkpoint, score: working ? 7 : 5 }] },
								};
							}
							if (name === "evaluate-1")
								return JSON.stringify({
									done: false,
									summary: "continue",
									new_findings: ["finding"],
									failures: [],
									validation_evidence: [],
									remaining_work: "next",
								});
							if (name === "evaluate-2")
								return JSON.stringify({
									done: true,
									summary: "done",
									new_findings: [],
									failures: [],
									validation_evidence: ["proof"],
									remaining_work: "",
								});
							return undefined;
						},
					},
				),
			);
			const output = await definition.run(ctx);
			const ledger = JSON.parse(readFileSync(output.ledger_path, "utf8"));
			return {
				projection: {
					status: output.status,
					iterations_completed: output.iterations_completed,
					remaining_work: output.remaining_work,
					entries: ledger.entries.map((entry) => ({
						iteration: entry.iteration,
						summary: entry.summary,
						findings: entry.findings,
						failures: entry.failures,
						validation_evidence: entry.validation_evidence,
						done: entry.done,
						remaining_work: entry.remaining_work,
					})),
				},
				progress_curve: output.progress_curve,
			};
		};
		const disabled = await decisions(false, false);
		const throwing = await decisions(true, true);
		const working = await decisions(true, false, true);
		assert.deepEqual(disabled.projection, throwing.projection);
		assert.deepEqual(disabled.projection, working.projection);
		assert.ok(working.progress_curve.length > 0);
	});

	test("keeps low-and-flat progress advisory during the full loop", async () => {
		const { default: definition } = await import("../../packages/workflows/builtin/loop-until-done.js");
		const scores = [5, 5, 6, 5, 5, 6];
		const run = async (progress_scoring: boolean) => {
			let checkpoint = 0;
			const ctx = withCwd(
				makeMockCtx(
					{ prompt: "Bounded low-flat fixture", max_iterations: scores.length, progress_scoring },
					{
						task: (name) => {
							if (name.startsWith("progress-score-")) {
								const current = checkpoint;
								checkpoint += 1;
								return {
									text: "",
									structured: { scores: [{ checkpoint: current + 1, score: scores[current] }] },
								};
							}
							if (name.startsWith("evaluate-")) {
								const iteration = Number(name.slice("evaluate-".length));
								return JSON.stringify({
									done: iteration === scores.length,
									summary: `iteration ${iteration}`,
									new_findings: [],
									failures: [],
									validation_evidence: [],
									remaining_work: iteration === scores.length ? "" : "continue",
								});
							}
							return undefined;
						},
					},
				),
			);
			const output = await definition.run(ctx);
			const ledger = JSON.parse(readFileSync(output.ledger_path, "utf8"));
			return {
				status: output.status,
				iterations_completed: output.iterations_completed,
				done: ledger.entries.map((entry) => entry.done),
				progress_curve: output.progress_curve,
			};
		};
		const disabled = await run(false);
		const enabled = await run(true);
		assert.deepEqual(
			{
				status: enabled.status,
				iterations_completed: enabled.iterations_completed,
				done: enabled.done,
			},
			{
				status: disabled.status,
				iterations_completed: disabled.iterations_completed,
				done: disabled.done,
			},
		);
		assert.deepEqual(enabled.progress_curve, scores);
	});
});
