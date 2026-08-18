import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import {
	classify_convergence,
	convergence_escalation_evidence,
	record_convergence,
	type ConvergenceEntry,
} from "../../packages/workflows/builtin/goal-convergence.js";
import { fold_usage } from "../../packages/workflows/builtin/verification-usage.js";
import { reduceGoalDecision } from "../../packages/workflows/builtin/goal-reducer.js";
import type { GoalLedger, ReviewRecord } from "../../packages/workflows/builtin/goal-types.js";
import type { WorkflowTaskResult } from "../../packages/workflows/src/shared/types.js";
import { makeMockCtx } from "./builtin-workflows-helpers.js";

function usageResult(
	name: string,
	input: number,
	output: number,
): WorkflowTaskResult {
	return {
		name,
		stageName: name,
		text: "stage result",
		modelAttempts: [{
			model: "mock/model",
			success: true,
			usage: { input, output, cacheRead: 2, cacheWrite: 3, cost: 0.5, turns: 1 },
		}],
	};
}

function entry(overrides: Partial<ConvergenceEntry> = {}): ConvergenceEntry {
	return {
		unresolvedBlockingCount: 4,
		meanFindingConfidence: null,
		fractionProven: 0,
		demotions: 0,
		usage: fold_usage([]),
		...overrides,
	};
}

function ledger(): GoalLedger {
	const now = new Date().toISOString();
	return {
		goal_id: "convergence-goal",
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
}

function review(
	reviewer: string,
	decision: "complete" | "continue" | "blocked",
): ReviewRecord {
	const approved = decision === "complete";
	return {
		findings: [],
		overall_correctness: approved ? "patch is correct" : "patch is incorrect",
		overall_explanation: "mock convergence review",
		overall_confidence_score: 0.8,
		goal_oracle_satisfied: approved,
		requirements_traceability: [{
			requirement: "complete objective",
			status: approved ? "proven" : "missing",
			evidence: approved ? "observed proof" : "work remains",
		}],
		receipt_assessment: "mock receipt",
		verification_remaining: approved ? "none" : "work remains",
		stop_review_loop: approved,
		reviewer_error: null,
		decision,
		evidence: [],
		gaps: [],
		blocker: decision === "blocked" ? "external dependency" : null,
		confidence_score: 0.8,
		explanation: "mock convergence review",
		turn: 1,
		reviewer,
		artifact_path: `/tmp/${reviewer}.json`,
		parsed: true,
		approved,
		parse_diagnostics: [],
		convergence_decision: {
			parsed: true,
			approved,
			stopReviewLoop: approved,
			nextAction: approved ? "finish" : "implementation",
			finalActionRemaining: false,
			diagnostics: [],
		},
	};
}

const reviewOptions = {
	turn: 1,
	maxTurns: 10,
	reviewQuorum: 2,
	blockerThreshold: 1,
	nextActionOnComplete: "finish",
} as const;

function sixFlatEntries(): ConvergenceEntry[] {
	return Array.from({ length: 6 }, () => entry());
}

function goalReviewJson(): string {
	return JSON.stringify({
		findings: [],
		overall_correctness: "patch is incorrect",
		overall_explanation: "The mock review leaves the objective unresolved.",
		overall_confidence_score: 0.5,
		goal_oracle_satisfied: false,
		requirements_traceability: [{
			requirement: "complete objective",
			status: "missing",
			evidence: "work remains",
		}],
		receipt_assessment: "mock receipt",
		verification_remaining: "work remains",
		stop_review_loop: false,
		reviewer_error: null,
	});
}

describe("goal convergence", () => {
	test("record_convergence shapes exactly five fields and folds usage", () => {
		const usage = fold_usage([usageResult("orchestrator", 10, 20), usageResult("reviewer", 30, 40)]);
		const shaped = record_convergence({
			unresolvedBlockingCount: 2,
			meanFindingConfidence: null,
			fractionProven: 0.5,
			demotions: 1,
			usage,
		});
		assert.deepEqual(Object.keys(shaped).sort(), [
			"demotions",
			"fractionProven",
			"meanFindingConfidence",
			"unresolvedBlockingCount",
			"usage",
		].sort());
		assert.equal(shaped.unresolvedBlockingCount, 2);
		assert.equal(shaped.meanFindingConfidence, null);
		assert.equal(shaped.fractionProven, 0.5);
		assert.equal(shaped.demotions, 1);
		assert.deepEqual(shaped.usage, {
			calls: 2,
			input: 40,
			output: 60,
			cacheRead: 4,
			cacheWrite: 6,
			cost: 1,
			turns: 2,
			cacheHitRate: 4 / 44,
		});
		assert.equal(record_convergence({
			unresolvedBlockingCount: 0,
			meanFindingConfidence: null,
			fractionProven: 0,
			demotions: 0,
			usage: fold_usage([]),
		}).meanFindingConfidence, null);
	});

	test("classify_convergence uses V7 trends and preserves raw series evidence", () => {
		const entries = [
			entry({ unresolvedBlockingCount: 4, fractionProven: 0.1 }),
			entry({ unresolvedBlockingCount: 4, fractionProven: 0.2 }),
			entry({ unresolvedBlockingCount: 3, fractionProven: 0.3 }),
			entry({ unresolvedBlockingCount: 2, fractionProven: 0.4 }),
			entry({ unresolvedBlockingCount: 1, fractionProven: 0.5 }),
		];
		const result = classify_convergence(entries);
		assert.equal(result.blocking.trend, "regressing");
		assert.equal(result.proven.trend, "flat");
		assert.deepEqual(result.blocking.evidence.series, [4, 4, 3, 2, 1]);
		assert.deepEqual(result.proven.evidence.series, [0.1, 0.2, 0.3, 0.4, 0.5]);
	});

	test("convergence escalation evidence cites six flat rounds before exhaustion", () => {
		const evidence = convergence_escalation_evidence(sixFlatEntries());
		const text = evidence.join("\n");
		assert.match(text, /6 rounds/);
		assert.match(text, /flat/);
		assert.match(text, /no convergence/);
		assert.match(text, /\[4,4,4,4,4,4\]/);
		assert.match(text, /no findings were filed/);
		assert.match(text, /EVIDENCE only/);
		assert.deepEqual(convergence_escalation_evidence([]), []);
		const outcome = reduceGoalDecision(
			ledger(),
			[review("reviewer-a", "continue"), review("reviewer-b", "continue")],
			{ ...reviewOptions, turn: 10, maxTurns: 10, convergence: sixFlatEntries() },
		);
		assert.match(outcome.decision.reason, /6 rounds/);
		assert.match(outcome.decision.reason, /flat/);
	});

	test("runGoalWorkflow convergence ledger records one usage block per round and failed-review escalation", async () => {
		const mod = await import("../../packages/workflows/builtin/goal.js");
		const ctx = makeMockCtx(
			{
				objective: "Keep the objective true",
				max_turns: 10,
				base_branch: "origin/main",
				git_worktree_dir: "",
				create_pr: false,
			},
			{
				task: (name) => name.startsWith("completion-reviewer-") ||
					name.startsWith("evidence-reviewer-") || name.startsWith("risk-reviewer-")
					? goalReviewJson()
					: undefined,
				parallel: async (steps) => {
					if (steps[0]?.name.endsWith("-6")) throw new Error("mock reviewer execution failure");
					return undefined;
				},
			},
		);
		const result = await mod.default.run(ctx);
		const saved = JSON.parse(readFileSync(String(result.ledger_path), "utf8")) as {
			readonly convergence: readonly {
				readonly unresolvedBlockingCount: number;
				readonly meanFindingConfidence: number | null;
				readonly fractionProven: number;
				readonly demotions: number;
				readonly usage: { readonly calls: number };
			}[];
			readonly decisions: readonly { readonly reason: string }[];
		};
		assert.equal(result.status, "needs_human");
		assert.equal(saved.convergence.length, 6);
		for (const round of saved.convergence) {
			assert.equal(round.unresolvedBlockingCount, 0);
			assert.equal(round.meanFindingConfidence, null);
			assert.equal(round.fractionProven, 0);
			assert.equal(round.demotions, 0);
			assert.equal(typeof round.usage.calls, "number");
		}
		assert.match(saved.decisions.at(-1)?.reason ?? "", /6 rounds/);
		assert.match(saved.decisions.at(-1)?.reason ?? "", /flat/);
		assert.match(saved.decisions.at(-1)?.reason ?? "", /EVIDENCE only/);
	});

	test("convergence evidence never changes complete blocked or continue decisions", () => {
		const series = sixFlatEntries();
		const cases = [
			{
				name: "complete convergence",
				reviews: [review("a", "complete"), review("b", "complete")],
				options: reviewOptions,
			},
			{
				name: "blocked convergence",
				reviews: [review("a", "blocked")],
				options: reviewOptions,
			},
			{
				name: "continue convergence",
				reviews: [review("a", "continue")],
				options: reviewOptions,
			},
		] as const;
		for (const testCase of cases) {
			const baseline = reduceGoalDecision(ledger(), testCase.reviews, testCase.options);
			const withEvidence = reduceGoalDecision(ledger(), testCase.reviews, {
				...testCase.options,
				convergence: series,
			});
			assert.equal(withEvidence.status, baseline.status, testCase.name);
			assert.equal(withEvidence.decision.decision, baseline.decision.decision, testCase.name);
			assert.equal(withEvidence.decision.reason, baseline.decision.reason, testCase.name);
			assert.equal(withEvidence.decision.approved, baseline.decision.approved, testCase.name);
			assert.equal(withEvidence.decision.stopReviewLoop, baseline.decision.stopReviewLoop, testCase.name);
		}
		assert.equal(convergence_escalation_evidence(series).length > 0, true);
	});
});
