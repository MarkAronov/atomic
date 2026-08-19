// @ts-nocheck

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, test } from "vitest";
import { renderReviewerPrompt } from "../../packages/workflows/builtin/goal-prompts.js";
import { reduceGoalDecision } from "../../packages/workflows/builtin/goal-reducer.js";
import { reviewDecisionSchema as goalReviewDecisionSchema } from "../../packages/workflows/builtin/goal-schemas.js";
import {
	reviewDecisionSchema as ralphReviewDecisionSchema,
	workflowCwdContextSection,
} from "../../packages/workflows/builtin/ralph-core.js";
import { reviewDecisionApproved } from "../../packages/workflows/builtin/ralph-review-gate.js";
import { renderRalphReviewerPrompt } from "../../packages/workflows/builtin/ralph-reviewer-prompt.js";
import { findingBlocksClosure } from "../../packages/workflows/builtin/review-convergence.js";
import { REVIEWER_CALIBRATION_RULES } from "../../packages/workflows/builtin/shared-prompts.js";
import { makeMockCtx } from "./builtin-workflows-helpers.js";

function ralphReviewJsonWithBlockingFindings(): string {
	return JSON.stringify({
		findings: Array.from({ length: 5 }, (_, index) => ({
			title: `[P1] Required objective blocker ${index + 1}`,
			body: "A concrete required objective blocker remains.",
			confidence_score: 0.95,
			objective_alignment: "required_by_objective",
			priority: 1,
			code_location: {
				absolute_file_path: "/repo/changed.ts",
				line_range: { start: index + 1, end: index + 1 },
			},
		})),
		overall_correctness: "patch is incorrect",
		overall_explanation: "The mock review leaves required objective blockers unresolved.",
		overall_confidence_score: 0.95,
		requirements_traceability: [
			{
				requirement: "complete objective",
				status: "missing",
				evidence: "required objective blockers remain",
			},
		],
		stop_review_loop: false,
		reviewer_error: null,
	});
}
describe("Ralph convergence", () => {
	let tempCwd: string | undefined;

	beforeEach(() => {
		tempCwd = mkdtempSync(join(tmpdir(), "atomic-ralph-convergence-"));
	});

	afterEach(() => {
		if (tempCwd !== undefined) {
			rmSync(tempCwd, { recursive: true, force: true });
			tempCwd = undefined;
		}
	});

	test("Ralph convergence persists per-iteration usage and escalates without changing approval or loop control", async () => {
		const mod = await import("../../packages/workflows/builtin/ralph.js");
		const cwd = tempCwd!;
		const reviewerPayload = JSON.stringify({
			findings: [
				{
					title: "[P2] A persistent blocker",
					body: "The mock review leaves an objective-relevant blocker unresolved.",
					confidence_score: 0.8,
					objective_alignment: "required_by_objective",
					priority: 2,
					code_location: {
						absolute_file_path: "/repo/changed.ts",
						line_range: { start: 1, end: 1 },
					},
				},
			],
			overall_correctness: "patch is incorrect",
			overall_explanation: "The mock review leaves the objective unresolved.",
			overall_confidence_score: 0.8,
			requirements_traceability: [
				{
					requirement: "complete objective",
					status: "missing",
					evidence: "work remains",
				},
			],
			stop_review_loop: false,
			reviewer_error: null,
		});
		const ctx = makeMockCtx(
			{
				prompt: "Keep the objective true",
				acceptance_criteria: "Keep the objective true",
				max_loops: 2,
				base_branch: "main",
				git_worktree_dir: "",
				create_pr: true,
			},
			{
				task: (name) => (name === "reviewer-a" || name === "reviewer-b" ? reviewerPayload : undefined),
			},
		);

		const result = await mod.default.run({ ...ctx, cwd });
		const saved = JSON.parse(readFileSync(String(result.review_report_path), "utf8"));
		const usageKeys = ["cacheHitRate", "cacheRead", "cacheWrite", "calls", "cost", "input", "output", "turns"];

		assert.equal(result.approved, false);
		assert.equal(result.iterations_completed, 2);
		assert.equal(ctx.calls.parallel.length, 2);
		assert.equal(ctx.calls.task.filter((name) => name === "reviewer-a" || name === "reviewer-b").length, 4);
		assert.equal(saved.convergence.length, 2);
		for (const entry of saved.convergence) {
			assert.deepEqual(Object.keys(entry.usage).sort(), usageKeys);
			for (const key of usageKeys) assert.equal(typeof entry.usage[key], "number", key);
		}
		assert.equal(saved.convergence_decision.approved, false);
		assert.equal(saved.convergence_decision.stopReviewLoop, false);
		assert.equal(saved.convergence_decision.nextAction, "implementation");
		assert.equal(
			saved.reviews.every((review) => review.decision.stop_review_loop === false),
			true,
		);

		const pullRequestPrompt = ctx.calls.prompts["pull-request"]?.[0] ?? "";
		assert.equal(ctx.calls.task.includes("pull-request"), true);
		assert.match(pullRequestPrompt, /2 rounds recorded/);
		assert.match(pullRequestPrompt, /flat/);
		assert.match(pullRequestPrompt, /This is escalation EVIDENCE only; it never approves or terminates anything\./);
	});

	test("Ralph convergence omits a failed reviewer batch from the review ledger and pull-request evidence", async () => {
		const mod = await import("../../packages/workflows/builtin/ralph.js");
		const cwd = tempCwd!;
		const reviewerPayload = ralphReviewJsonWithBlockingFindings();
		const ctx = makeMockCtx(
			{
				prompt: "Keep the objective true",
				acceptance_criteria: "Keep the objective true",
				max_loops: 3,
				base_branch: "main",
				git_worktree_dir: "",
				create_pr: true,
			},
			{
				task: (name) => (name === "reviewer-a" || name === "reviewer-b" ? reviewerPayload : undefined),
				parallel: async (_steps, _options, calls) => {
					if (calls.parallel.length === 3) throw new Error("mock reviewer execution failure");
					return undefined;
				},
			},
		);

		const result = await mod.default.run({ ...ctx, cwd });
		const saved = JSON.parse(readFileSync(String(result.review_report_path), "utf8")) as {
			readonly convergence: readonly { readonly unresolvedBlockingCount: number }[];
		};
		assert.equal(result.approved, false);
		assert.equal(result.iterations_completed, 3);
		assert.deepEqual(
			saved.convergence.map((entry) => entry.unresolvedBlockingCount),
			[5, 5],
		);

		const pullRequestPrompt = ctx.calls.prompts["pull-request"]?.[0] ?? "";
		assert.equal(ctx.calls.task.includes("pull-request"), true);
		assert.match(pullRequestPrompt, /2 rounds recorded/);
		assert.match(pullRequestPrompt, /flat/);
		assert.match(pullRequestPrompt, /This is escalation EVIDENCE only; it never approves or terminates anything\./);
	});
});

test("reviewer calibration convergence prompts retain existing contract sections", () => {
	const goalPrompt = renderReviewerPrompt({
		reviewerRole: "Completion Reviewer",
		focus: "Check the objective evidence.",
		objective: "Keep the objective true",
		ledgerPath: "/tmp/goal-ledger.json",
		orchestratorReceiptPath: "/tmp/orchestrator-receipt.md",
		comparisonBaseBranch: "main",
		reviewQuorum: 2,
		blockerThreshold: 3,
		createPr: false,
	});
	const ralphPrompt = renderRalphReviewerPrompt({
		workflowPrompt: "Keep the objective true",
		acceptanceCriteria: "Keep the objective true",
		workflowCwdContext: workflowCwdContextSection("/tmp/project"),
		comparisonBaseBranch: "main",
		researchPath: "/tmp/research.md",
		implementationNotesPath: "/tmp/implementation-notes.md",
		orchestratorReportPath: "/tmp/orchestrator-report.md",
		qaVideoPath: "/tmp/qa-evidence.webm",
		createPr: false,
	});

	for (const prompt of [goalPrompt, ralphPrompt]) {
		assert.equal(prompt.includes(REVIEWER_CALIBRATION_RULES), true);
		assert.match(prompt, /Literal objective contract:/);
		assert.match(prompt, /Independent verification:/);
		assert.match(prompt, /Convergence flag \(stop_review_loop\):/);
		assert.match(prompt, /discrete, actionable/);
	}
});

test("criterion-score convergence schemas stay optional and audit-only", () => {
	const criterionScores = [{ criterion_id: "criterion-1", score: 10 }];
	const goalDecision = {
		findings: [],
		overall_correctness: "patch is correct",
		overall_explanation: "all requirements proven",
		overall_confidence_score: 0.9,
		goal_oracle_satisfied: true,
		requirements_traceability: [
			{
				requirement: "complete objective",
				status: "proven",
				evidence: "focused checks passed",
			},
		],
		receipt_assessment: "receipt corroborated",
		verification_remaining: "none",
		stop_review_loop: true,
		reviewer_error: null,
	};
	const ralphDecision = {
		findings: [],
		overall_correctness: "patch is correct",
		overall_explanation: "all requirements proven",
		overall_confidence_score: 0.9,
		requirements_traceability: [
			{
				requirement: "complete objective",
				status: "proven",
				evidence: "focused checks passed",
			},
		],
		stop_review_loop: true,
		reviewer_error: null,
	};

	for (const [schema, decision] of [
		[goalReviewDecisionSchema, goalDecision],
		[ralphReviewDecisionSchema, ralphDecision],
	]) {
		assert.equal(Value.Check(schema, decision), true);
		assert.equal(Value.Check(schema, { ...decision, criterion_scores: criterionScores }), true);
		assert.equal(
			Value.Check(schema, { ...decision, criterion_scores: [{ criterion_id: "criterion-1", score: 0 }] }),
			false,
		);
		assert.equal(
			Value.Check(schema, { ...decision, criterion_scores: [{ criterion_id: "criterion-1", score: 21 }] }),
			false,
		);
	}

	const finding = {
		title: "[P2] Audit-only finding",
		body: "A concrete objective-relevant finding remains.",
		confidence_score: 0.9,
		objective_alignment: "consistent_with_objective",
		priority: 2,
		code_location: {
			absolute_file_path: "/repo/changed.ts",
			line_range: { start: 1, end: 1 },
		},
	};
	const goalRecord = (includeCriterionScores: boolean) => ({
		...goalDecision,
		findings: [finding],
		overall_correctness: "patch is incorrect",
		goal_oracle_satisfied: false,
		requirements_traceability: [
			{
				requirement: "complete objective",
				status: "missing",
				evidence: "work remains",
			},
		],
		verification_remaining: "work remains",
		stop_review_loop: false,
		...(includeCriterionScores ? { criterion_scores: criterionScores } : {}),
		decision: "continue",
		evidence: ["receipt corroborated"],
		gaps: ["work remains"],
		blocker: null,
		confidence_score: 0.9,
		explanation: "work remains",
		turn: 1,
		reviewer: "reviewer-a",
		artifact_path: "/tmp/reviewer-a.json",
		parsed: true,
		approved: false,
		parse_diagnostics: [],
		convergence_decision: {
			parsed: true,
			approved: false,
			stopReviewLoop: false,
			nextAction: "implementation",
			finalActionRemaining: false,
			diagnostics: [],
		},
	});
	const withoutCriterionScores = goalRecord(false);
	const withCriterionScores = goalRecord(true);
	assert.equal(
		findingBlocksClosure(withoutCriterionScores.findings[0]),
		findingBlocksClosure(withCriterionScores.findings[0]),
	);
	assert.equal(
		reviewDecisionApproved(ralphDecision),
		reviewDecisionApproved({
			...ralphDecision,
			criterion_scores: criterionScores,
		}),
	);

	const makeLedger = () => {
		const now = new Date().toISOString();
		return {
			goal_id: "criterion-score-convergence",
			objective: "Complete the objective",
			acceptance_criteria: "Complete the objective",
			status: "active",
			turns: 1,
			created_at: now,
			updated_at: now,
			receipts: [],
			reviews: [],
			blockers: [],
			decisions: [],
			lifecycle: [],
		};
	};
	const reducerOptions = {
		turn: 1,
		maxTurns: 2,
		reviewQuorum: 2,
		blockerThreshold: 3,
		nextActionOnComplete: "finish",
	};
	assert.deepEqual(
		reduceGoalDecision(makeLedger(), [withoutCriterionScores], reducerOptions),
		reduceGoalDecision(makeLedger(), [withCriterionScores], reducerOptions),
	);
});
