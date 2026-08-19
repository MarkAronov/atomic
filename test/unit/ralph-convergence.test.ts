// @ts-nocheck

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { makeMockCtx } from "./builtin-workflows-helpers.js";

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
			findings: [{
				title: "[P2] A persistent blocker",
				body: "The mock review leaves an objective-relevant blocker unresolved.",
				confidence_score: 0.8,
				objective_alignment: "required_by_objective",
				priority: 2,
				code_location: {
					absolute_file_path: "/repo/changed.ts",
					line_range: { start: 1, end: 1 },
				},
			}],
			overall_correctness: "patch is incorrect",
			overall_explanation: "The mock review leaves the objective unresolved.",
			overall_confidence_score: 0.8,
			requirements_traceability: [{
				requirement: "complete objective",
				status: "missing",
				evidence: "work remains",
			}],
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
				task: (name) => name === "reviewer-a" || name === "reviewer-b" ? reviewerPayload : undefined,
			},
		);

		const result = await mod.default.run({ ...ctx, cwd });
		const saved = JSON.parse(readFileSync(String(result.review_report_path), "utf8"));
		const usageKeys = [
			"cacheHitRate",
			"cacheRead",
			"cacheWrite",
			"calls",
			"cost",
			"input",
			"output",
			"turns",
		];

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
		assert.equal(saved.reviews.every((review) => review.decision.stop_review_loop === false), true);

		const pullRequestPrompt = ctx.calls.prompts["pull-request"]?.[0] ?? "";
		assert.equal(ctx.calls.task.includes("pull-request"), true);
		assert.match(pullRequestPrompt, /2 rounds recorded/);
		assert.match(pullRequestPrompt, /flat/);
		assert.match(pullRequestPrompt, /This is escalation EVIDENCE only; it never approves or terminates anything\./);
	});
});
