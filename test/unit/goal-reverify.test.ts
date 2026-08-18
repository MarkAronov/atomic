import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import { writeReviewRoundArtifact } from "../../packages/workflows/builtin/goal-artifacts.js";
import {
	apply_reverify_results,
	DEFAULT_REVERIFY_THRESHOLD,
	is_reverifiable,
	type ReverifiableConsolidatedFinding,
	type ReverifiableFinding,
	type ReverifyContext,
	reverify_finding,
} from "../../packages/workflows/builtin/goal-reverify.js";
import { summarizeReviewConvergence } from "../../packages/workflows/builtin/review-convergence.js";
import type {
	WorkflowSerializableValue,
	WorkflowTaskOptions,
	WorkflowTaskResult,
} from "../../packages/workflows/src/shared/types.js";

function finding(overrides: Partial<ReverifiableFinding> = {}): ReverifiableFinding {
	return {
		title: "[P2] A concrete defect",
		body: "The cited implementation has a defect.",
		confidence_score: 0.4,
		objective_alignment: "consistent_with_objective",
		priority: 2,
		code_location: {
			absolute_file_path: "/repo/src/file.ts",
		},
		...overrides,
	};
}

function entry(
	findingOverrides: Partial<ReverifiableFinding> = {},
	overrides: Partial<ReverifiableConsolidatedFinding> = {},
): ReverifiableConsolidatedFinding {
	return {
		finding: finding(findingOverrides),
		reviewers: ["reviewer-a"],
		blocking: true,
		...overrides,
	};
}

function taskResult(structured?: WorkflowSerializableValue): WorkflowTaskResult {
	return structured === undefined
		? { stageName: "stub", text: "not structured" }
		: { stageName: "stub", text: "structured", structured };
}

function stubContext(responses: readonly (WorkflowSerializableValue | undefined)[]): {
	readonly ctx: ReverifyContext;
	readonly calls: readonly { readonly name: string; readonly options: WorkflowTaskOptions }[];
} {
	const pending = [...responses];
	const calls: { name: string; options: WorkflowTaskOptions }[] = [];
	const ctx: ReverifyContext = {
		task: async (name, options) => {
			calls.push({ name, options });
			return taskResult(pending.shift());
		},
	};
	return { ctx, calls };
}

function score(score: number, evidence = `Observed evidence for score ${score}.`): WorkflowSerializableValue {
	return { score, evidence: [evidence] };
}

const context = {
	objective: "Keep the objective contract true.",
	candidateRefs: ["/repo/research.md", "/repo/receipt.md"],
};

describe("goal reverify eligibility", () => {
	test("is_reverifiable covers alignments, corroboration, confidence, and blocking", () => {
		for (const alignment of ["required_by_objective", "consistent_with_objective"] as const) {
			assert.equal(is_reverifiable(entry({ objective_alignment: alignment }), DEFAULT_REVERIFY_THRESHOLD), true);
		}
		for (const alignment of ["beyond_objective", "contradicts_objective"] as const) {
			assert.equal(is_reverifiable(entry({ objective_alignment: alignment }), DEFAULT_REVERIFY_THRESHOLD), false);
		}
		assert.equal(is_reverifiable(entry({ confidence_score: 0.7 }), DEFAULT_REVERIFY_THRESHOLD), false);
		assert.equal(is_reverifiable(entry({ confidence_score: 0.9 }), DEFAULT_REVERIFY_THRESHOLD), false);
		assert.equal(is_reverifiable(entry({ confidence_score: undefined }), DEFAULT_REVERIFY_THRESHOLD), false);
		assert.equal(is_reverifiable(entry({}, { blocking: false }), DEFAULT_REVERIFY_THRESHOLD), false);
		assert.equal(
			is_reverifiable(entry({}, { reviewers: ["reviewer-a", "reviewer-b"] }), DEFAULT_REVERIFY_THRESHOLD),
			false,
		);
	});
});

describe("goal reverify scoring", () => {
	test("demotes a low mean and retains audit evidence while shrinking only the blocking set", async () => {
		const { ctx, calls } = stubContext([score(5), score(6), score(4)]);
		const original = entry();
		const result = await reverify_finding(ctx, { finding: original, context });
		assert.deepEqual(result.perRepeat, [5, 6, 4]);
		assert.equal(result.meanScore, 5);
		assert.equal(result.verdict, "demoted");
		assert.equal(result.evidence.length, 3);
		const reshaped = apply_reverify_results([original], [{ finding: original, ...result }]);
		assert.equal(reshaped.batch.length, 1);
		assert.equal(reshaped.batch[0]?.blocking, false);
		assert.strictEqual(reshaped.batch[0]?.finding, original.finding);
		assert.equal(reshaped.audits[0]?.verdict, "demoted");
		assert.deepEqual(reshaped.audits[0]?.perRepeat, [5, 6, 4]);
		assert.equal(
			calls.every((call) => call.options.context === "fresh"),
			true,
		);
		assert.deepEqual(calls[0]?.options.reads, ["/repo/src/file.ts", "/repo/research.md", "/repo/receipt.md"]);
		assert.match(calls[0]?.options.prompt ?? "", /<scoring_head>/u);
		assert.match(calls[0]?.options.prompt ?? "", /<criterion>/u);
		assert.match(calls[0]?.options.prompt ?? "", /is it a real, objective-relevant, currently-unresolved blocker\?/u);
	});

	test("invalid repeats re-ask once, then default to confirmed and preserve the zero-valid sentinel", async () => {
		const { ctx, calls } = stubContext([undefined, undefined, undefined, undefined, undefined, undefined]);
		const result = await reverify_finding(ctx, { finding: entry(), context });
		assert.equal(result.verdict, "confirmed");
		assert.equal(result.meanScore, 0);
		assert.deepEqual(result.perRepeat, [null, null, null]);
		assert.equal(calls.length, 6);
		assert.equal(calls.filter((call) => call.name.startsWith("reverify-")).length, 6);
		assert.equal(result.evidence.length, 3);
	});

	test("a parse failure is re-asked once and the re-ask can supply the valid repeat", async () => {
		const { ctx, calls } = stubContext([undefined, score(7), score(8), score(9)]);
		const result = await reverify_finding(ctx, { finding: entry(), context });
		assert.deepEqual(result.perRepeat, [7, 8, 9]);
		assert.equal(result.verdict, "demoted");
		assert.equal(calls.length, 4);
		assert.equal(calls[0]?.name, "reverify-1");
		assert.equal(calls[1]?.name, "reverify-1-reask");
	});

	test("required findings use the stricter unanimous bar while standard findings at 8 demote", async () => {
		const standard = await reverify_finding(stubContext([score(8), score(8), score(8)]).ctx, {
			finding: entry({ objective_alignment: "consistent_with_objective" }),
			context,
		});
		const requiredAtEight = await reverify_finding(stubContext([score(8), score(8), score(8)]).ctx, {
			finding: entry({ objective_alignment: "required_by_objective" }),
			context,
		});
		const requiredAtFive = await reverify_finding(stubContext([score(5), score(5), score(5)]).ctx, {
			finding: entry({ objective_alignment: "required_by_objective" }),
			context,
		});
		const requiredWithInvalid = await reverify_finding(stubContext([score(5), score(5), undefined, undefined]).ctx, {
			finding: entry({ objective_alignment: "required_by_objective" }),
			context,
		});
		assert.equal(standard.verdict, "demoted");
		assert.equal(requiredAtEight.verdict, "confirmed");
		assert.equal(requiredAtFive.verdict, "demoted");
		assert.equal(requiredWithInvalid.verdict, "confirmed");
		assert.deepEqual(requiredWithInvalid.perRepeat, [5, 5, null]);
	});

	test("corroborated findings are ineligible and the door throws", async () => {
		const corroborated = entry({}, { reviewers: ["reviewer-a", "reviewer-b"] });
		assert.equal(is_reverifiable(corroborated), false);
		await assert.rejects(
			reverify_finding(stubContext([]).ctx, { finding: corroborated, context }),
			/ineligible finding/u,
		);
	});

	test("when demotion empties blocking findings, stop_review_loop remains the only approval authority", async () => {
		const original = entry();
		const { ctx } = stubContext([score(5), score(6), score(4)]);
		const result = await reverify_finding(ctx, { finding: original, context });
		const reshaped = apply_reverify_results([original], [{ finding: original, ...result }]);
		assert.equal(
			reshaped.batch.every((item) => item.blocking === false),
			true,
		);
		const round = summarizeReviewConvergence({
			parsed: true,
			approved: false,
			stopReviewLoop: false,
			nextAction: "implementation",
			diagnostics: [],
		});
		assert.equal(round.stopReviewLoop, false);
		assert.equal(round.approved, false);
	});
	test("round artifacts retain demotion audit evidence and the original finding", async () => {
		const { ctx } = stubContext([score(5), score(6), score(4)]);
		const original = entry();
		const result = await reverify_finding(ctx, { finding: original, context });
		const reshaped = apply_reverify_results([original], [{ finding: original, ...result }]);
		const artifactDir = await mkdtemp(join(tmpdir(), "goal-reverify-"));
		try {
			const artifactPath = await writeReviewRoundArtifact(artifactDir, [], reshaped.batch, reshaped.audits);
			const saved = JSON.parse(await readFile(artifactPath, "utf8")) as {
				readonly consolidated_findings: readonly {
					readonly blocking: boolean;
					readonly finding: { readonly title: string };
				}[];
				readonly reverification: readonly {
					readonly verdict: string;
					readonly meanScore: number;
					readonly perRepeat: readonly (number | null)[];
					readonly evidence: readonly string[];
				}[];
			};
			assert.equal(saved.consolidated_findings[0]?.blocking, false);
			assert.equal(saved.consolidated_findings[0]?.finding.title, original.finding.title);
			assert.equal(saved.reverification[0]?.verdict, "demoted");
			assert.equal(saved.reverification[0]?.meanScore, 5);
			assert.deepEqual(saved.reverification[0]?.perRepeat, [5, 6, 4]);
			assert.equal(saved.reverification[0]?.evidence.length, 3);
		} finally {
			await rm(artifactDir, { recursive: true, force: true });
		}
	});
});
