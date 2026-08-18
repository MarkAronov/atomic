import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Value } from "typebox/value";
import { test } from "vitest";
import adversarialVerification from "../../packages/workflows/builtin/adversarial-verification.js";
import generateAndFilter from "../../packages/workflows/builtin/generate-and-filter.js";
import { VERIFICATION_SCALE } from "../../packages/workflows/builtin/verification-criteria.js";
import {
	assertOutputTypes,
	assertWorkflowDefinition,
	fieldDefault,
	fieldKind,
	fieldRequired,
	makeMockCtx,
	readPaths,
} from "./builtin-workflows-helpers.js";

async function withTempCwd<T>(run: (cwd: string) => Promise<T>): Promise<T> {
	const cwd = await mkdtemp(join(tmpdir(), "pattern-workflow-test-"));
	try {
		return await run(cwd);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

function assignCwd<T extends object>(ctx: T, cwd: string): T {
	Object.defineProperty(ctx, "cwd", { value: cwd, enumerable: true });
	return ctx;
}

function criterionId(prompt: string): string {
	const match = prompt.match(/\nid: ([^\n]+)/);
	assert.ok(match?.[1], "criterion verifier prompt must name its criterion");
	return match[1];
}

function criterionReport(
	prompt: string,
	score = 20,
	findings: readonly { finding: string; severity: "veto" | "blocking" | "note" }[] = [],
): string {
	return JSON.stringify({ criterion_id: criterionId(prompt), score, evidence: ["checked"], findings });
}

function schemaShape(schema: unknown): Record<string, unknown> {
	return schema as Record<string, unknown>;
}

test("adversarial-verification declares the graded input and output contracts", () => {
	assertWorkflowDefinition(adversarialVerification);
	assert.equal(adversarialVerification.normalizedName, "adversarial-verification");
	assert.equal(fieldKind(adversarialVerification.inputs.task), "text");
	assert.equal(fieldRequired(adversarialVerification.inputs.task), true);
	assert.deepEqual(fieldDefault(adversarialVerification.inputs.criteria), {
		task_fit: "The candidate satisfies the literal task.",
		evidence: "Important claims cite observable evidence, and file findings cite file:line where applicable.",
		completeness:
			"Relevant validation is executed and reported with commands run and observed output, and no blocking correctness, safety, or completeness gap remains.",
	});
	assert.equal(fieldKind(adversarialVerification.inputs.criteria), "unknown");
	assert.equal(fieldRequired(adversarialVerification.inputs.criteria), false);
	const criteriaSchema = adversarialVerification.inputs.criteria;
	const markdownCriteria = "## Criteria\n### Task fit {#task_fit}\nFits.";
	assert.equal(Value.Check(criteriaSchema, markdownCriteria), true);
	assert.equal(Value.Check(criteriaSchema, { task_fit: "Fits." }), true);
	assert.equal(Value.Check(criteriaSchema, ["Fits."]), false);
	assert.equal(Value.Check(criteriaSchema, 14), false);
	assert.equal(fieldDefault(adversarialVerification.inputs.verifier_count), 3);
	assert.equal(fieldDefault(adversarialVerification.inputs.max_repairs), 2);
	assert.equal(fieldDefault(adversarialVerification.inputs.accept_mean), 14);
	assert.equal(fieldDefault(adversarialVerification.inputs.reask_limit), 1);
	assert.equal(Reflect.get(adversarialVerification.inputs.verifier_count, "minimum"), 1);
	assert.equal(Reflect.get(adversarialVerification.inputs.verifier_count, "maximum"), 5);
	assert.equal(Reflect.get(adversarialVerification.inputs.max_repairs, "maximum"), 5);
	assert.equal(Reflect.get(adversarialVerification.inputs.accept_mean, "minimum"), 1);
	assert.equal(Reflect.get(adversarialVerification.inputs.accept_mean, "maximum"), 20);
	assertOutputTypes(adversarialVerification.outputs, {
		approved: "boolean",
		mean_score: "number",
		score_table_path: "text",
		repairs_completed: "integer",
		candidate_path: "text",
		review_report_path: "text",
		remaining_work: "array",
	});
});

test("adversarial-verification fans out one fresh schema-backed stage per criterion and verifier", async () => {
	await withTempCwd(async (cwd) => {
		const ctx = assignCwd(
			makeMockCtx(
				{
					task: "verify this",
					verifier_count: 2,
					max_repairs: 1,
					criteria:
						"## Criteria\n### Task fit {#task_fit}\nThe task is satisfied.\n\n### Evidence {#evidence}\nClaims have evidence.",
					accept_mean: 14,
					reask_limit: 1,
				},
				{
					task: (name, options) =>
						name.startsWith("verifier-") ? criterionReport(String(options.prompt)) : undefined,
				},
			),
			cwd,
		);
		const result = await adversarialVerification.run(ctx);
		assert.equal(result.approved, true);
		assert.equal(result.mean_score, 20);
		assert.equal(result.repairs_completed, 0);
		assert.equal(ctx.calls.parallel.length, 1);
		assert.equal(ctx.calls.parallel[0]?.length, 4);
		assert.deepEqual(ctx.calls.parallel[0], [
			"verifier-0-task_fit-1",
			"verifier-0-task_fit-2",
			"verifier-0-evidence-1",
			"verifier-0-evidence-2",
		]);
		for (const name of ctx.calls.parallel[0]!) {
			const options = ctx.calls.taskOptions[name]?.[0];
			assert.equal(options?.context, "fresh");
			assert.equal(options?.schema === undefined, false);
			assert.ok(readPaths(options).some((path) => path.endsWith("candidate.md")));
			assert.ok(readPaths(options).some((path) => path.endsWith("criteria.md")));
			const schema = schemaShape(options?.schema);
			assert.equal(schema.additionalProperties, false);
			const properties = schemaShape(schema.properties);
			assert.equal(schemaShape(properties.criterion_id).type, "string");
			assert.equal(properties.score, VERIFICATION_SCALE.schema);
			assert.equal(schemaShape(properties.evidence).type, "array");
			assert.equal(schemaShape(properties.findings).type, "array");
			const findingSchema = schemaShape(schemaShape(properties.findings).items);
			assert.equal(findingSchema.additionalProperties, false);
		}
		for (const criterion of ["task_fit", "evidence"]) {
			for (const index of [1, 2]) {
				const artifact = join(dirname(result.score_table_path), `verification-0-${criterion}-${index}.json`);
				assert.deepEqual(JSON.parse(readFileSync(artifact, "utf8")), {
					criterion_id: criterion,
					score: 20,
					evidence: ["checked"],
					findings: [],
				});
			}
		}
		const summary = JSON.parse(readFileSync(result.score_table_path, "utf8")) as {
			scores: unknown[];
			mean: number;
			invalidCount: number;
			decision: { kind: string };
		};
		assert.equal(summary.scores.length, 4);
		assert.equal(summary.mean, 20);
		assert.equal(summary.invalidCount, 0);
		assert.equal(summary.decision.kind, "accept");
		assert.equal(
			readFileSync(join(dirname(result.score_table_path), "criteria.md"), "utf8").includes("## Criteria"),
			true,
		);
	});
});

test("adversarial-verification re-asks invalid reports without counting them as scores", async () => {
	await withTempCwd(async (cwd) => {
		const ctx = assignCwd(
			makeMockCtx(
				{
					task: "verify this",
					verifier_count: 2,
					max_repairs: 0,
					criteria: { task_fit: "The task is satisfied." },
					accept_mean: 14,
					reask_limit: 1,
				},
				{
					task: (name, options) => {
						if (!name.startsWith("verifier-")) return undefined;
						if (name === "verifier-0-task_fit-1") return "prose instead of structured output";
						return criterionReport(String(options.prompt));
					},
				},
			),
			cwd,
		);
		const result = await adversarialVerification.run(ctx);
		assert.equal(result.approved, true);
		assert.deepEqual(
			ctx.calls.parallel.map((steps) => steps.length),
			[2, 1],
		);
		assert.equal(ctx.calls.parallel[1]?.[0], "verifier-0-task_fit-1-reask-1");
		const root = dirname(result.score_table_path);
		assert.deepEqual(JSON.parse(readFileSync(join(root, "verification-0-task_fit-1.json"), "utf8")), {
			invalid: true,
			stage: "verifier-0-task_fit-1",
		});
		assert.deepEqual(JSON.parse(readFileSync(join(root, "verification-0-task_fit-1-reask-1.json"), "utf8")), {
			criterion_id: "task_fit",
			score: 20,
			evidence: ["checked"],
			findings: [],
		});
		const summary = JSON.parse(readFileSync(result.score_table_path, "utf8")) as {
			scores: Array<{ criterion_id: string }>;
			mean: number;
			invalidCount: number;
			decision: { kind: string };
		};
		assert.equal(summary.scores.length, 2);
		assert.equal(summary.invalidCount, 1);
		assert.equal(summary.mean, 20);
		assert.equal(summary.decision.kind, "accept");
	});
});

test("adversarial-verification preserves confirmed findings and reads the successful re-ask artifact", async () => {
	await withTempCwd(async (cwd) => {
		const rawFindings = [
			{ finding: "  veto finding\nline two  ", severity: "veto" },
			{ finding: "blocking → exact", severity: "blocking" },
			{ finding: "blocking → exact", severity: "blocking" },
		] as const;
		const expectedRemaining = rawFindings.map(({ finding }) => finding);
		const ctx = assignCwd(
			makeMockCtx(
				{
					task: "repair this",
					verifier_count: 2,
					max_repairs: 0,
					criteria: { task_fit: "The task is satisfied." },
					accept_mean: 14,
					reask_limit: 1,
				},
				{
					task: (name, options) => {
						if (name === "verifier-0-task_fit-1") return "invalid initial report";
						if (name === "verifier-0-task_fit-1-reask-1") {
							return criterionReport(String(options.prompt), 20, rawFindings);
						}
						if (name.startsWith("verifier-")) return criterionReport(String(options.prompt));
						if (name.startsWith("consolidate-findings-")) {
							return JSON.stringify({ repair_guidance: "repair the veto", remaining_work: ["rewritten"] });
						}
						return undefined;
					},
				},
			),
			cwd,
		);
		const result = await adversarialVerification.run(ctx);
		assert.equal(result.approved, false);
		assert.equal(result.mean_score, 20);
		assert.equal(result.repairs_completed, 0);
		assert.equal(ctx.calls.task.includes("consolidate-findings-0"), true);
		assert.equal(ctx.calls.task.includes("repair-1"), false);
		assert.deepEqual(result.remaining_work, expectedRemaining);
		const consolidatorReads = readPaths(ctx.calls.taskOptions["consolidate-findings-0"]?.[0]);
		assert.equal(
			consolidatorReads.some((path) => path.endsWith("verification-0-task_fit-1-reask-1.json")),
			true,
		);
		assert.equal(
			consolidatorReads.some((path) => path.endsWith("verification-0-task_fit-1.json")),
			false,
		);
		const summary = JSON.parse(readFileSync(result.score_table_path, "utf8")) as {
			invalidCount: number;
			decision: { kind: string; mean: number };
		};
		assert.equal(summary.invalidCount, 1);
		assert.equal(summary.decision.kind, "repair");
		assert.equal(summary.decision.mean, 20);
		assert.deepEqual(JSON.parse(readFileSync(result.review_report_path, "utf8")), {
			repair_guidance: "repair the veto",
			remaining_work: expectedRemaining,
		});
	});
});

test("adversarial-verification repeats indeterminate rounds once and records quorum failure", async () => {
	await withTempCwd(async (cwd) => {
		const ctx = assignCwd(
			makeMockCtx(
				{
					task: "verify this",
					verifier_count: 1,
					max_repairs: 2,
					criteria: { task_fit: "The task is satisfied." },
					accept_mean: 14,
					reask_limit: 1,
				},
				{ task: (name) => (name.startsWith("verifier-") ? "permanently invalid" : undefined) },
			),
			cwd,
		);
		const result = await adversarialVerification.run(ctx);
		assert.equal(result.approved, false);
		assert.equal(result.repairs_completed, 0);
		assert.equal(ctx.calls.parallel.length, 4);
		assert.deepEqual(
			ctx.calls.parallel.map((steps) => steps.length),
			[1, 1, 1, 1],
		);
		assert.equal(
			ctx.calls.task.some((name) => name.startsWith("consolidate-findings-")),
			false,
		);
		assert.match(result.remaining_work[0] ?? "", /Quorum failure/);
		const root = dirname(result.score_table_path);
		assert.deepEqual(JSON.parse(readFileSync(join(root, "verification-1-task_fit-1.json"), "utf8")), {
			invalid: true,
			stage: "verifier-1-task_fit-1",
		});
		assert.deepEqual(JSON.parse(readFileSync(join(root, "verification-1-task_fit-1-reask-1.json"), "utf8")), {
			invalid: true,
			stage: "verifier-1-task_fit-1-reask-1",
		});
		const summary = JSON.parse(readFileSync(result.score_table_path, "utf8")) as {
			scores: unknown[];
			invalidCount: number;
			decision: { kind: string; missing: number };
		};
		assert.deepEqual(summary.scores, []);
		assert.equal(summary.invalidCount, 2);
		assert.equal(summary.decision.kind, "indeterminate");
		assert.equal(summary.decision.missing, 1);
		const review = JSON.parse(readFileSync(result.review_report_path, "utf8")) as { evidence: string[] };
		assert.match(review.evidence[0] ?? "", /Quorum failure/);
	});
});

test("generate-and-filter declares bounded composable contracts", () => {
	assertWorkflowDefinition(generateAndFilter);
	assert.equal(generateAndFilter.normalizedName, "generate-and-filter");
	assert.equal(fieldKind(generateAndFilter.inputs.prompt), "text");
	assert.equal(fieldRequired(generateAndFilter.inputs.prompt), true);
	assert.equal(fieldDefault(generateAndFilter.inputs.num_candidates), 8);
	assert.equal(fieldDefault(generateAndFilter.inputs.shortlist_size), 3);
	assert.equal(fieldDefault(generateAndFilter.inputs.use_judge), true);
	assert.equal(fieldDefault(generateAndFilter.inputs.max_concurrency), 4);
	assert.equal(Reflect.get(generateAndFilter.inputs.num_candidates, "minimum"), 2);
	assert.equal(Reflect.get(generateAndFilter.inputs.num_candidates, "maximum"), 20);
	assert.equal(Reflect.get(generateAndFilter.inputs.shortlist_size, "maximum"), 10);
	assertOutputTypes(generateAndFilter.outputs, {
		result: "text",
		shortlist: "array",
		candidate_artifact_paths: "array",
		filter_path: "text",
		judge_path: "unknown",
		final_path: "text",
		artifact_dir: "text",
		manifest_path: "text",
	});
});

test("generate-and-filter fans out, dedupes, optionally judges, and finalizes artifact shortlist", async () => {
	await withTempCwd(async (cwd) => {
		const ctx = assignCwd(
			makeMockCtx(
				{ prompt: "generate options", num_candidates: 3, shortlist_size: 2, use_judge: true, max_concurrency: 2 },
				{
					task: (name, options) =>
						name === "dedupe-and-filter"
							? JSON.stringify({
									shortlist: readPaths(options)
										.filter((path) => path.endsWith(".md"))
										.slice(0, 2),
									discarded: [],
								})
							: name === "judge"
								? JSON.stringify({
										shortlist: readPaths(options).filter((path) => path.includes("candidate-")),
										rationale: "ranked",
									})
								: undefined,
				},
			),
			cwd,
		);
		const originalTask = ctx.task.bind(ctx);
		Object.defineProperty(ctx, "task", {
			value: async (name: string, options: Parameters<typeof ctx.task>[1]) => {
				const taskResult = await originalTask(name, options);
				return name === "final-shortlist"
					? { ...taskResult, text: `Saved output to ${String(options.output)}` }
					: taskResult;
			},
		});
		const result = await generateAndFilter.run(ctx);
		assert.deepEqual(ctx.calls.parallel, [["generate-1", "generate-2", "generate-3"]]);
		assert.equal(ctx.calls.parallelOptions[0]?.concurrency, 2);
		assert.deepEqual(ctx.calls.task.slice(-3), ["dedupe-and-filter", "judge", "final-shortlist"]);
		assert.equal(result.shortlist.length, 2);
		// `result` carries the compact artifact reference, never the report body:
		// the full text belongs in `final_path` so it stays out of the caller's
		// context window.
		assert.match(result.result, /Saved output to/);
		assert.doesNotMatch(result.result, /\[mock-task:final-shortlist\]/);
		assert.match(readFileSync(result.final_path, "utf8"), /\[mock-task:final-shortlist\]/);
		assert.ok(
			readPaths(ctx.calls.taskOptions["dedupe-and-filter"]?.[0]).some((path) => path.endsWith("manifest.json")),
		);
		assert.ok(readPaths(ctx.calls.taskOptions.judge?.[0]).some((path) => path.endsWith("filter.json")));
		assert.ok(readPaths(ctx.calls.taskOptions["final-shortlist"]?.[0]).some((path) => path.endsWith("judge.json")));
		const filterReport = JSON.parse(readFileSync(result.filter_path, "utf8")) as {
			shortlist: string[];
			discarded: unknown[];
		};
		assert.equal(filterReport.shortlist.length, 2);
		assert.ok(filterReport.shortlist.every((path) => path.includes("candidate-")));
		assert.deepEqual(filterReport.discarded, []);
		const judgeReport = JSON.parse(readFileSync(result.judge_path ?? "", "utf8")) as {
			shortlist: string[];
			rationale: string;
		};
		assert.ok(judgeReport.shortlist.every((path) => path.includes("candidate-")));
		assert.equal(judgeReport.rationale, "ranked");
	});
});

test("generate-and-filter skips judge when disabled", async () => {
	await withTempCwd(async (cwd) => {
		const ctx = assignCwd(
			makeMockCtx({
				prompt: "generate options",
				num_candidates: 2,
				shortlist_size: 1,
				use_judge: false,
				max_concurrency: 1,
			}),
			cwd,
		);
		const result = await generateAndFilter.run(ctx);
		assert.equal(result.judge_path, null);
		assert.equal(ctx.calls.task.includes("judge"), false);
		assert.ok(readPaths(ctx.calls.taskOptions["final-shortlist"]?.[0]).some((path) => path.endsWith("filter.json")));
		assert.deepEqual(JSON.parse(readFileSync(result.filter_path, "utf8")), { shortlist: [], discarded: [] });
	});
});

test("generate-and-filter keeps the full shortlist when shortlist_size equals num_candidates", async () => {
	await withTempCwd(async (cwd) => {
		const ctx = assignCwd(
			makeMockCtx(
				{ prompt: "generate options", num_candidates: 2, shortlist_size: 2, use_judge: false, max_concurrency: 2 },
				{
					task: (name, options) =>
						name === "dedupe-and-filter"
							? JSON.stringify({
									shortlist: readPaths(options).filter((path) => path.includes("candidate-")),
									discarded: [],
								})
							: undefined,
				},
			),
			cwd,
		);
		const result = await generateAndFilter.run(ctx);
		assert.equal(result.shortlist.length, 2);
		assert.deepEqual([...result.shortlist].sort(), [...result.candidate_artifact_paths].sort());
		const filterPrompt = String(ctx.calls.taskOptions["dedupe-and-filter"]?.[0]?.prompt ?? "");
		assert.match(filterPrompt, /Select at most 2 strongest candidates/);
	});
});
