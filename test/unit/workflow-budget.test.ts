import assert from "node:assert/strict";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import {
	createRunBudgetController,
	WorkflowBudgetExceededError,
} from "../../packages/workflows/src/engine/run-budget.js";
import { loadConfigFile } from "../../packages/workflows/src/extension/config-file-loader.js";
import { withWorkflowDefaults } from "../../packages/workflows/src/extension/config-loader.js";
import { WorkflowParametersSchema } from "../../packages/workflows/src/extension/workflow-schema.js";
import { summarizeRunSnapshot } from "../../packages/workflows/src/extension/workflow-status-summary.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import {
	type EffectiveBudget,
	enforceDurationBudget,
	resolve_budget,
	validateWorkflowBudget,
	type WorkflowBudget,
} from "../../packages/workflows/src/shared/budget.js";
import {
	effectiveRunStatus,
	isReturnedBlockedWorkflowStatus,
	isReturnedResumableBlockedWorkflowStatus,
} from "../../packages/workflows/src/shared/returned-run-status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { makeTempDirectory, removeTempDirectory, writeFileEnsuringDir } from "../helpers/runtime.js";

afterEach(() => vi.useRealTimers());

function budgetRun(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
	return {
		id: "budget-test-run",
		name: "budget-test",
		inputs: {},
		status: "running",
		stages: [],
		startedAt: 0,
		...overrides,
	};
}

const BUDGET_FIELDS = [
	["maxDurationMs", 10, 20, 30],
	["maxTokens", 11, 21, 31],
	["maxCost", 12.5, 22.5, 32.5],
	["warnAtPercent", 13.5, 23.5, 33.5],
] as const satisfies readonly [keyof WorkflowBudget, number, number, number][];

function budgetField(field: keyof WorkflowBudget, value: number): WorkflowBudget {
	return { [field]: value };
}

type IsAssignable<TSource, TTarget> = [TSource] extends [TTarget] ? true : false;
type UnresolvedBudget = {
	readonly maxDurationMs: number;
	readonly maxTokens: number;
	readonly maxCost: number;
	readonly warnAtPercent: number;
};

const effectiveBudgetRejectsUnresolvedDeclarations: IsAssignable<UnresolvedBudget, EffectiveBudget> extends false
	? true
	: never = true;

interface BudgetOutcome {
	readonly status?: string;
	readonly dimension?: string;
	readonly ceiling?: number;
	readonly frontierStage?: string;
	readonly wrapUpSummary?: string;
}

function budgetOutcome(value: object | undefined): BudgetOutcome | undefined {
	return value as BudgetOutcome | undefined;
}

function assertBudgetBlockedSnapshot(snapshot: RunSnapshot | undefined): asserts snapshot is RunSnapshot {
	assert.ok(snapshot);
	assert.equal(effectiveRunStatus(snapshot), "blocked");
	assert.notEqual(snapshot.endedAt, undefined);
	assert.equal(summarizeRunSnapshot(snapshot).status, "blocked");
}

describe("workflow budget resolution", () => {
	test("budget later layers win per field for every layer-presence combination", () => {
		for (const [field, configValue, definitionValue, runValue] of BUDGET_FIELDS) {
			for (const configPresent of [false, true]) {
				for (const definitionPresent of [false, true]) {
					for (const runPresent of [false, true]) {
						const resolved = resolve_budget({
							...(configPresent ? { config: budgetField(field, configValue) } : {}),
							...(definitionPresent ? { definition: budgetField(field, definitionValue) } : {}),
							...(runPresent ? { run: budgetField(field, runValue) } : {}),
						});
						const expected = runPresent
							? runValue
							: definitionPresent
								? definitionValue
								: configPresent
									? configValue
									: field === "warnAtPercent"
										? 80
										: 0;

						assert.equal(
							resolved[field],
							expected,
							`${field}: ${configPresent}/${definitionPresent}/${runPresent}`,
						);
					}
				}
			}
		}
	});

	test("budget later partial layers retain earlier fields", () => {
		const config = { maxDurationMs: 10, maxTokens: 11, maxCost: 12.5, warnAtPercent: 13.5 };
		const runResolved = resolve_budget({ config, run: { maxTokens: 31 } });
		assert.equal(runResolved.maxDurationMs, 10);
		assert.equal(runResolved.maxTokens, 31);
		assert.equal(runResolved.maxCost, 12.5);
		assert.equal(runResolved.warnAtPercent, 13.5);

		const definitionResolved = resolve_budget({ config, definition: { maxCost: 5 } });
		assert.equal(definitionResolved.maxDurationMs, 10);
		assert.equal(definitionResolved.maxTokens, 11);
		assert.equal(definitionResolved.maxCost, 5);
		assert.equal(definitionResolved.warnAtPercent, 13.5);
	});

	test("budget later zero disables a field", () => {
		const resolved = resolve_budget({
			config: { maxDurationMs: 10, maxTokens: 20, maxCost: 30, warnAtPercent: 80 },
			definition: { maxDurationMs: 0, maxTokens: 0 },
			run: { maxCost: 0, warnAtPercent: 0 },
		});

		assert.equal(resolved.maxDurationMs, 0);
		assert.equal(resolved.maxTokens, 0);
		assert.equal(resolved.maxCost, 0);
		assert.equal(resolved.warnAtPercent, 0);
	});
});

describe("duration budget enforcement", () => {
	test("uses the default warning threshold and reports duration readings", () => {
		const budget = resolve_budget({ run: { maxDurationMs: 100 } });
		assert.equal(budget.warnAtPercent, 80);
		assert.deepEqual(enforceDurationBudget(80, budget), {
			kind: "continue",
			report: { dimension: "duration", reading: 80, ceiling: 100, percent: 80 },
			warning: true,
		});
		assert.deepEqual(enforceDurationBudget(80, budget, { warned: true }), {
			kind: "continue",
			report: { dimension: "duration", reading: 80, ceiling: 100, percent: 80 },
			warning: false,
		});
	});

	test("exhausts at the duration ceiling and leaves unbudgeted runs untouched", () => {
		const budget = resolve_budget({ run: { maxDurationMs: 1 } });
		assert.deepEqual(enforceDurationBudget(1, budget), {
			kind: "exhausted",
			report: { dimension: "duration", reading: 1, ceiling: 1, percent: 100 },
		});
		const unbudgeted = resolve_budget({});
		assert.deepEqual(enforceDurationBudget(10_000, unbudgeted), {
			kind: "continue",
			report: { dimension: "duration", reading: 10_000, ceiling: 0, percent: 0 },
			warning: false,
		});
	});
});

describe("budget duration controller", () => {
	test("warns once and excludes paused time from the meter", () => {
		vi.useFakeTimers();
		vi.setSystemTime(10_000);
		const run = budgetRun({ pausedAt: 9_000, pausedDurationMs: 4_000 });
		const warnings: number[] = [];
		const controller = createRunBudgetController({
			run,
			budget: resolve_budget({ run: { maxDurationMs: 6_000 } }),
			onWarning: (report) => warnings.push(report.reading),
		});
		assert.equal(controller.checkpoint("work").kind, "warn");
		assert.equal(controller.checkpoint("work").kind, "continue");
		assert.deepEqual(warnings, [5_000]);
		run.pausedAt = undefined;
		vi.setSystemTime(11_000);
		assert.equal(controller.checkpoint("work").kind, "wrap_up");
		assert.equal(run.budgetState?.duration?.reading, 7_000);
	});

	test("soft landing records exact report fields and usage", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(11);
		const run = budgetRun();
		const controller = createRunBudgetController({ run, budget: resolve_budget({ run: { maxDurationMs: 10 } }) });
		assert.equal(controller.checkpoint("frontier").kind, "wrap_up");
		controller.registerWrapUp("frontier", async () => {
			throw controller.finishWrapUp("frontier", "progress", { output: 3 });
		});
		await assert.rejects(controller.deliverWrapUp("frontier"), (error: unknown) => {
			assert.ok(error instanceof WorkflowBudgetExceededError);
			assert.equal(error.report.dimension, "duration");
			assert.equal(error.report.reading, 11);
			assert.equal(error.report.ceiling, 10);
			assert.ok(Math.abs(error.report.percent - 110) < 1e-9);
			assert.equal(error.report.frontierStage, "frontier");
			assert.equal(error.report.wrapUpSummary, "progress");
			assert.deepEqual(error.report.wrapUpUsage, { output: 3 });
			return true;
		});
		assert.equal(controller.checkpoint("frontier").kind, "exhausted");
	});

	test("no budget leaves the run untouched and performs no meter work", () => {
		vi.useFakeTimers();
		vi.setSystemTime(99_999);
		const run = budgetRun();
		const controller = createRunBudgetController({ run, budget: resolve_budget({}) });
		assert.deepEqual(controller.checkpoint("work"), { kind: "continue" });
		assert.equal(run.budgetState, undefined);
		assert.equal(controller.enabled, false);
	});

	test("same-budget resume is exhausted immediately while a raised ceiling continues", () => {
		vi.useFakeTimers();
		vi.setSystemTime(10);
		const prior = budgetRun({
			accumulatedDurationMs: 10,
			budget: { maxDurationMs: 10, warnAtPercent: 80 },
			budgetState: {
				duration: { dimension: "duration", reading: 10, ceiling: 10, percent: 100 },
				wrapUpDelivered: true,
				wrapUpCompleted: true,
				wrapUpSummary: "progress",
			},
		});
		const same = createRunBudgetController({ run: prior, budget: resolve_budget({ run: { maxDurationMs: 10 } }) });
		assert.equal(same.checkpoint("work").kind, "exhausted");
		const raised = budgetRun({ accumulatedDurationMs: 8 });
		const raisedController = createRunBudgetController({
			run: raised,
			budget: resolve_budget({ run: { maxDurationMs: 20 } }),
		});
		assert.notEqual(raisedController.checkpoint("work").kind, "exhausted");
	});
});

describe("workflow budget validation", () => {
	test("budget rejects negative, non-finite, and non-integer integer dimensions", () => {
		const invalid: readonly WorkflowBudget[] = [
			{ maxDurationMs: -1 },
			{ maxTokens: -1 },
			{ maxDurationMs: Number.NaN },
			{ maxTokens: Number.POSITIVE_INFINITY },
			{ maxDurationMs: 1.5 },
			{ maxTokens: 1.5 },
			{ maxCost: -0.01 },
			{ warnAtPercent: Number.NEGATIVE_INFINITY },
		];
		for (const budget of invalid) {
			assert.notEqual(validateWorkflowBudget(budget), null, JSON.stringify(budget));
		}
	});

	test("budget accepts zero and finite fractional cost and warning values", () => {
		const budget = { maxDurationMs: 0, maxTokens: 0, maxCost: 1.25, warnAtPercent: 80.5 };

		assert.equal(validateWorkflowBudget(budget), null);
		assert.throws(() => resolve_budget({ run: { maxTokens: 1.5 } }), TypeError);
	});

	test("budget config validation rejects an invalid declaration", async () => {
		const directory = makeTempDirectory("atomic-workflow-budget-");
		try {
			const filePath = join(directory, "config.json");
			await writeFileEnsuringDir(filePath, JSON.stringify({ budget: { maxTokens: -1 } }));
			const outcome = await loadConfigFile(filePath);

			assert.deepEqual(outcome.kind, "error");
			if (outcome.kind === "error") assert.match(outcome.diagnostic.message, /budget\.maxTokens/);
		} finally {
			removeTempDirectory(directory);
		}
	});
});

describe("workflow budget plumbing", () => {
	test("budget config defaults and authored declarations resolve without enforcement", () => {
		const effective = withWorkflowDefaults({ budget: { maxDurationMs: 100, maxCost: 2.5 } });
		assert.equal(effective.budget.maxDurationMs, 100);
		assert.equal(effective.budget.maxCost, 2.5);
		assert.equal(effective.budget.maxTokens, 0);

		const definition = workflow({
			name: "budget-child",
			description: "budget declaration test",
			budget: { maxTokens: 25 },
			outputs: { result: Type.String() },
			run: () => ({ result: "done" }),
		});
		assert.equal(definition.budget?.maxTokens, 25);
		assert.ok(Object.isFrozen(definition.budget));
		assert.throws(
			() =>
				workflow({
					name: "invalid-budget-child",
					description: "budget declaration test",
					budget: { maxDurationMs: -1 },
					outputs: {},
					run: () => ({}),
				}),
			TypeError,
		);
	});

	test("budget tool schema mirrors declared budget validation", () => {
		assert.equal(
			Value.Check(WorkflowParametersSchema, {
				action: "run",
				workflow: "budget-child",
				budget: { maxDurationMs: 0, maxTokens: 1, maxCost: 1.25, warnAtPercent: 80.5 },
			}),
			true,
		);
		assert.equal(
			Value.Check(WorkflowParametersSchema, { action: "run", workflow: "budget-child", budget: { maxTokens: 1.5 } }),
			false,
		);
		assert.equal(
			Value.Check(WorkflowParametersSchema, { action: "run", workflow: "budget-child", budget: { maxCost: -1 } }),
			false,
		);
	});
});
describe("budget executor boundaries", () => {
	test("child budget soft-lands its subtree while the parent continues", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const child = workflow({
			name: "budget-child-soft-land",
			description: "",
			inputs: {},
			outputs: { value: Type.String() },
			budget: { maxDurationMs: 1 },
			run: async (ctx) => ({ value: await ctx.stage("child-frontier").complete("child work") }),
		});
		let parentContinued = false;
		const parent = workflow({
			name: "budget-parent-soft-land",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				const childResult = await ctx.workflow(child, { stageName: "child-boundary" });
				assert.equal(childResult.exited, true);
				assert.equal(childResult.status, "blocked");
				parentContinued = true;
				await ctx.stage("parent-after-child").complete("parent continued");
				return { result: childResult.status };
			},
		});
		const store = createStore();
		const childPrompts: string[] = [];
		const result = await run(
			parent,
			{},
			{
				store,
				budget: { maxDurationMs: 100 },
				adapters: {
					complete: {
						complete: async (text) => {
							if (text === "child work") vi.advanceTimersByTime(2);
							return text;
						},
					},
					prompt: {
						prompt: async (text) => {
							childPrompts.push(text);
							return "child wrap-up";
						},
					},
				},
			},
		);
		assert.equal(result.status, "completed");
		assert.equal(result.result?.result, "blocked");
		assert.equal(parentContinued, true);
		assert.equal(childPrompts.length, 1);
		const childRun = store.runs().find((candidate) => candidate.name === child.name);
		assert.equal(childRun?.result?.status, "budget_exceeded");
		assert.equal(childRun?.budgetState?.wrapUpCompleted, true);
	});

	test("root budget wins simultaneous child exhaustion and prevents parent continuation", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const child = workflow({
			name: "budget-simultaneous-child",
			description: "",
			inputs: {},
			outputs: { value: Type.String() },
			budget: { maxDurationMs: 1 },
			run: async (ctx) => ({ value: await ctx.stage("child-frontier").complete("child work") }),
		});
		let parentContinued = false;
		const parent = workflow({
			name: "budget-simultaneous-root",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				await ctx.workflow(child, { stageName: "child-boundary" });
				parentContinued = true;
				await ctx.stage("must-not-run").complete("must not run");
				return { result: "continued" };
			},
		});
		const store = createStore();
		const result = await run(
			parent,
			{},
			{
				store,
				budget: { maxDurationMs: 1 },
				adapters: {
					complete: {
						complete: async (text) => {
							vi.advanceTimersByTime(2);
							return text;
						},
					},
					prompt: { prompt: async () => "root wrap-up" },
				},
			},
		);
		const outcome = budgetOutcome(result.result);
		assert.equal(outcome?.status, "budget_exceeded");
		assert.equal(outcome?.dimension, "duration");
		assert.equal(parentContinued, false);
		assert.equal(store.runs().find((candidate) => candidate.name === parent.name)?.result?.status, "budget_exceeded");
		const rootRun = store.runs().find((candidate) => candidate.name === parent.name);
		assert.equal(rootRun?.budgetState?.wrapUpDelivered, undefined);
		assert.equal(rootRun?.budgetState?.wrapUpCompleted, undefined);
		assert.equal(
			rootRun?.stages.some((stage) => stage.name === "must-not-run"),
			false,
		);
	});

	test("budget executor exhaustion wraps up the current turn without launching a new stage", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const prompts: string[] = [];
		const completed: string[] = [];
		const definition = workflow({
			name: "budget-executor-exhaustion",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				const progress = await ctx.stage("frontier").complete("progress");
				await ctx.stage("after-frontier").complete("must not run");
				return { result: progress };
			},
		});
		const store = createStore();
		const result = await run(
			definition,
			{},
			{
				store,
				budget: { maxDurationMs: 1 },
				adapters: {
					complete: {
						complete: async (text) => {
							completed.push(text);
							vi.advanceTimersByTime(2);
							return text;
						},
					},
					prompt: {
						prompt: async (text) => {
							prompts.push(text);
							return "wrap-up summary";
						},
					},
				},
			},
		);
		assert.equal(result.status, "running");
		const outcome = budgetOutcome(result.result);
		assert.equal(outcome?.status, "budget_exceeded");
		assert.equal(outcome?.dimension, "duration");
		assert.equal(outcome?.ceiling, 1);
		assert.equal(outcome?.frontierStage, "frontier");
		assert.equal(outcome?.wrapUpSummary, "wrap-up summary");
		assert.equal(completed.length, 1);
		assert.equal(prompts.length, 1);
		assert.match(prompts[0] ?? "", /budget is exhausted/i);
		const snapshot = store.runs().find((candidate) => candidate.id === result.runId);
		assert.equal(snapshot?.result?.status, "budget_exceeded");
		assert.equal(snapshot?.budgetState?.wrapUpCompleted, true);
		assert.ok(snapshot);
		assert.equal(effectiveRunStatus(snapshot), "blocked");
		assert.equal(
			snapshot?.stages.some((stage) => stage.name === "after-frontier"),
			false,
		);
	});

	test("budget-free executor runs byte-identically without budget state or notices", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const definition = workflow({
			name: "budget-free-executor",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => ({ result: await ctx.stage("ordinary").complete("ordinary") }),
		});
		const store = createStore();
		const result = await run(
			definition,
			{},
			{
				store,
				adapters: { complete: { complete: async (text) => text } },
			},
		);
		assert.equal(result.status, "completed");
		assert.equal(result.result?.result, "ordinary");
		const snapshot = store.runs().find((candidate) => candidate.id === result.runId);
		assert.equal(snapshot?.budget, undefined);
		assert.equal(snapshot?.budgetState, undefined);
		assert.deepEqual(store.notices(), []);
	});

	test("budget warning notice reaches the store once across repeated stage boundaries", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const definition = workflow({
			name: "budget-warning-notice",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				let last = "";
				for (let index = 0; index < 6; index++) last = await ctx.stage(`step-${index}`).complete(`work ${index}`);
				return { result: last };
			},
		});
		const store = createStore();
		const result = await run(
			definition,
			{},
			{
				store,
				config: withWorkflowDefaults({}),
				budget: { maxDurationMs: 200 },
				adapters: {
					complete: {
						complete: async (text) => {
							vi.advanceTimersByTime(30);
							return text;
						},
					},
					prompt: { prompt: async () => "wrap-up summary" },
				},
			},
		);

		// Six boundaries cross the 80% line repeatedly, but the shipped
		// store.recordNotice wiring must emit exactly one warning per dimension.
		const notices = store.notices();
		assert.equal(notices.length, 1);
		assert.equal(notices[0]?.level, "warning");
		assert.equal(notices[0]?.id, `workflow-budget-warning:${result.runId}:duration`);
		assert.match(notices[0]?.message ?? "", /90\.0% of its duration budget \(180 \/ 200\)/);
		const snapshot = store.runs().find((candidate) => candidate.id === result.runId);
		assert.equal(snapshot?.budgetState?.warned, true);
		// A warning must not stop the run: 180ms of 200ms never reaches the ceiling.
		assert.equal(result.status, "completed");
		assert.equal(result.result?.result, "work 5");
		assert.equal(snapshot?.budgetState?.wrapUpDelivered, undefined);
	});

	test("budget tool boundary does not consume an undeliverable wrap-up", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const prompts: string[] = [];
		const definition = workflow({
			name: "budget-tool-boundary",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				await ctx.tool("burn-budget", {}, async () => {
					vi.advanceTimersByTime(20);
					return "burned";
				});
				return { result: "must not complete" };
			},
		});
		const store = createStore();
		const result = await run(
			definition,
			{},
			{
				store,
				budget: { maxDurationMs: 10 },
				adapters: {
					prompt: {
						prompt: async (text) => {
							prompts.push(text);
							return "must not prompt";
						},
					},
				},
			},
		);
		const snapshot = store.runs().find((candidate) => candidate.id === result.runId);
		const outcome = budgetOutcome(result.result);
		assert.equal(outcome?.status, "budget_exceeded");
		assert.equal(outcome?.wrapUpSummary, undefined);
		assert.equal(prompts.length, 0);
		assert.equal(snapshot?.budgetState?.wrapUpDelivered, undefined);
		assert.equal(snapshot?.budgetState?.wrapUpCompleted, undefined);
		assertBudgetBlockedSnapshot(snapshot);
	});

	test("budget child-workflow boundary does not consume an undeliverable wrap-up", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const child = workflow({
			name: "budget-tool-child",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				await ctx.tool("child-burn", {}, async () => {
					vi.advanceTimersByTime(20);
					return "burned";
				});
				return { result: "child done" };
			},
		});
		const prompts: string[] = [];
		const parent = workflow({
			name: "budget-child-boundary",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				await ctx.workflow(child, { stageName: "child-frontier", budget: { maxDurationMs: 0 } });
				return { result: "must not complete" };
			},
		});
		const store = createStore();
		const result = await run(
			parent,
			{},
			{
				store,
				budget: { maxDurationMs: 10 },
				adapters: {
					prompt: {
						prompt: async (text) => {
							prompts.push(text);
							return "must not prompt";
						},
					},
				},
			},
		);
		const snapshot = store.runs().find((candidate) => candidate.id === result.runId);
		assert.equal(budgetOutcome(result.result)?.status, "budget_exceeded");
		assert.equal(budgetOutcome(result.result)?.wrapUpSummary, undefined);
		assert.equal(prompts.length, 0);
		assert.equal(snapshot?.budgetState?.wrapUpDelivered, undefined);
		assert.equal(snapshot?.budgetState?.wrapUpCompleted, undefined);
		assertBudgetBlockedSnapshot(snapshot);
	});

	test("budget before dispatch creates no new stage when no turn is live", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const definition = workflow({
			name: "budget-before-dispatch",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				vi.advanceTimersByTime(20);
				return { result: await ctx.stage("must-not-exist").complete("must not run") };
			},
		});
		const store = createStore();
		const result = await run(definition, {}, { store, budget: { maxDurationMs: 10 } });
		const snapshot = store.runs().find((candidate) => candidate.id === result.runId);
		assert.equal(budgetOutcome(result.result)?.status, "budget_exceeded");
		assert.deepEqual(snapshot?.stages, []);
		assert.equal(snapshot?.budgetState?.wrapUpDelivered, undefined);
		assert.equal(snapshot?.budgetState?.wrapUpCompleted, undefined);
		assertBudgetBlockedSnapshot(snapshot);
	});

	test("budget caught stage error still stops on the system-owned blocked rail", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const definition = workflow({
			name: "budget-caught-stage-error",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				try {
					await ctx.stage("caught-frontier").complete("progress");
				} catch {
					return { result: "swallowed" };
				}
				return { result: "completed" };
			},
		});
		const store = createStore();
		const result = await run(
			definition,
			{},
			{
				store,
				budget: { maxDurationMs: 1 },
				adapters: {
					complete: {
						complete: async (text) => {
							vi.advanceTimersByTime(2);
							return text;
						},
					},
					prompt: { prompt: async () => "caught-stage wrap-up" },
				},
			},
		);
		const snapshot = store.runs().find((candidate) => candidate.id === result.runId);
		assert.equal(budgetOutcome(result.result)?.status, "budget_exceeded");
		assert.equal(effectiveRunStatus(snapshot!), "blocked");
		assert.equal(snapshot?.result?.status, "budget_exceeded");
	});

	test("budget resume carries elapsed time, repeats no wrap-up at the same ceiling, and continues when raised", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const backend = new InMemoryDurableBackend();
		const definition = workflow({
			name: "budget-resume",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => ({ result: await ctx.stage("resume-frontier").complete("progress") }),
		});
		const firstStore = createStore();
		const prompts: string[] = [];
		const first = await run(
			definition,
			{},
			{
				runId: "budget-resume-source",
				store: firstStore,
				durableBackend: backend,
				budget: { maxDurationMs: 1 },
				adapters: {
					complete: {
						complete: async (text) => {
							vi.advanceTimersByTime(2);
							return text;
						},
					},
					prompt: {
						prompt: async (text) => {
							prompts.push(text);
							return "first wrap-up";
						},
					},
				},
			},
		);
		const source = firstStore.runs().find((candidate) => candidate.id === first.runId)!;
		assert.equal(budgetOutcome(first.result)?.status, "budget_exceeded");
		assert.equal(source.failedStageId !== undefined, true);
		const sourceElapsed = source.budgetState?.duration?.reading ?? 0;
		const sameStore = createStore();
		const same = await run(
			definition,
			{},
			{
				store: sameStore,
				durableBackend: backend,
				continuation: { source, resumeFromStageId: source.failedStageId! },
				adapters: {
					complete: { complete: async (text) => text },
					prompt: { prompt: async () => "must not wrap again" },
				},
			},
		);
		assert.equal(budgetOutcome(same.result)?.status, "budget_exceeded");
		assert.equal(prompts.length, 1);
		const sameSnapshot = sameStore.runs().find((candidate) => candidate.id === same.runId);
		assert.equal(sameSnapshot?.accumulatedDurationMs, sourceElapsed);
		assert.equal(budgetOutcome(same.result)?.frontierStage, "resume-frontier");
		const raisedStore = createStore();
		const raised = await run(
			definition,
			{},
			{
				store: raisedStore,
				durableBackend: backend,
				budget: { maxDurationMs: 10 },
				continuation: { source, resumeFromStageId: source.failedStageId! },
				adapters: { complete: { complete: async (text) => text } },
			},
		);
		assert.equal(raised.status, "completed");
		const raisedSnapshot = raisedStore.runs().find((candidate) => candidate.id === raised.runId);
		assert.equal(raisedSnapshot?.accumulatedDurationMs, sourceElapsed);
		assert.ok((raisedSnapshot?.durationMs ?? 0) >= sourceElapsed);
	});

	test("budget successful body preserves outputs after non-stage work past the ceiling", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const definition = workflow({
			name: "budget-success-after-body-work",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				const result = await ctx.stage("only-stage").complete("real work product");
				vi.advanceTimersByTime(300);
				return { result };
			},
		});
		const store = createStore();
		const result = await run(definition, {}, {
			store,
			budget: { maxDurationMs: 200 },
			adapters: { complete: { complete: async (text) => text } },
		});
		assert.equal(result.status, "completed");
		assert.deepEqual(result.result, { result: "real work product" });
		assert.equal(store.runs()[0]?.budgetState?.systemOwnedStop, undefined);
	});

	test("budget resumed startup exhaustion lands on the blocked rail with no stage", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const backend = new InMemoryDurableBackend();
		const definition = workflow({
			name: "budget-resumed-startup-boundary",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => ({ result: await ctx.stage("resume-frontier").complete("progress") }),
		});
		const sourceStore = createStore();
		const first = await run(
			definition,
			{},
			{
				store: sourceStore,
				durableBackend: backend,
				budget: { maxDurationMs: 1 },
				adapters: {
					complete: {
						complete: async (text) => {
							vi.advanceTimersByTime(2);
							return text;
						},
					},
					prompt: { prompt: async () => "startup-boundary wrap-up" },
				},
			},
		);
		const source = sourceStore.runs().find((candidate) => candidate.id === first.runId)!;
		assert.ok(source.failedStageId);

		const resumedStore = createStore();
		const resumed = await run(
			definition,
			{},
			{
				store: resumedStore,
				durableBackend: backend,
				continuation: { source, resumeFromStageId: source.failedStageId },
				adapters: {
					complete: { complete: async (text) => text },
					prompt: { prompt: async () => "must not wrap again" },
				},
			},
		);
		const snapshot = resumedStore.runs().find((candidate) => candidate.id === resumed.runId);
		assert.equal(budgetOutcome(resumed.result)?.status, "budget_exceeded");
		assert.deepEqual(snapshot?.stages, []);
		assertBudgetBlockedSnapshot(snapshot);
		assert.equal(snapshot.failedStageId, undefined);
	});

	test("budget exhausted generation can resume again from its boundary with a raised ceiling", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const backend = new InMemoryDurableBackend();
		const definition = workflow({
			name: "budget-resume-boundary-chain",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => ({ result: await ctx.stage("frontier").complete("progress") }),
		});
		const firstStore = createStore();
		const first = await run(
			definition,
			{},
			{
				store: firstStore,
				durableBackend: backend,
				budget: { maxDurationMs: 1 },
				adapters: {
					complete: {
						complete: async (text) => {
							vi.advanceTimersByTime(2);
							return text;
						},
					},
					prompt: { prompt: async () => "first chain wrap-up" },
				},
			},
		);
		const source = firstStore.runs().find((candidate) => candidate.id === first.runId)!;
		assert.ok(source.failedStageId);

		const secondStore = createStore();
		const second = await run(
			definition,
			{},
			{
				store: secondStore,
				durableBackend: backend,
				continuation: { source, resumeFromStageId: source.failedStageId },
				adapters: { complete: { complete: async (text) => text } },
			},
		);
		const secondSnapshot = secondStore.runs().find((candidate) => candidate.id === second.runId);
		assert.equal(budgetOutcome(second.result)?.status, "budget_exceeded");
		assertBudgetBlockedSnapshot(secondSnapshot);
		assert.deepEqual(secondSnapshot.stages, []);

		const raisedStore = createStore();
		// The boundary-only generation has no stage id; resume must still be legal.
		const raised = await run(
			definition,
			{},
			{
				store: raisedStore,
				durableBackend: backend,
				budget: { maxDurationMs: 10 },
				continuation: { source: secondSnapshot, resumeFromStageId: secondSnapshot.failedStageId! },
				adapters: { complete: { complete: async (text) => text } },
			},
		);
		assert.equal(raised.status, "completed");
		assert.deepEqual(raised.result, { result: "progress" });
	});

	test("budget failedStageId is a real stage id or absent, never a display name", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const backend = new InMemoryDurableBackend();
		const definition = workflow({
			name: "budget-failed-stage-id-shape",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => ({ result: await ctx.stage("named-frontier").complete("progress") }),
		});
		const firstStore = createStore();
		const first = await run(
			definition,
			{},
			{
				store: firstStore,
				durableBackend: backend,
				budget: { maxDurationMs: 1 },
				adapters: {
					complete: {
						complete: async (text) => {
							vi.advanceTimersByTime(2);
							return text;
						},
					},
					prompt: { prompt: async () => "id-shape wrap-up" },
				},
			},
		);
		const source = firstStore.runs().find((candidate) => candidate.id === first.runId)!;
		assert.ok(source.failedStageId);
		assert.ok(source.stages.some((stage) => stage.id === source.failedStageId));
		assert.notEqual(source.failedStageId, "named-frontier");

		const secondStore = createStore();
		const second = await run(
			definition,
			{},
			{
				store: secondStore,
				durableBackend: backend,
				continuation: { source, resumeFromStageId: source.failedStageId },
				adapters: { complete: { complete: async (text) => text } },
			},
		);
		const resumed = secondStore.runs().find((candidate) => candidate.id === second.runId);
		assert.deepEqual(resumed?.stages, []);
		assert.equal(resumed?.failedStageId, undefined);
	});
	test("budget_exceeded returned by stage output cannot forge a system exhaustion", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const definition = workflow({
			name: "budget-forged-status",
			description: "",
			inputs: {},
			outputs: { status: Type.String() },
			run: async (ctx) => {
				await ctx.stage("forged-stage").complete("model output");
				return { status: "budget_exceeded" };
			},
		});
		const store = createStore();
		const result = await run(definition, {}, { store, adapters: { complete: { complete: async (text) => text } } });
		assert.equal(result.status, "completed");
		assert.equal(budgetOutcome(result.result)?.status, "budget_exceeded");
		const snapshot = store.runs().find((candidate) => candidate.id === result.runId);
		assert.equal(snapshot?.budgetState, undefined);
		assert.equal(snapshot?.failureDisposition, undefined);
	});

	test("budget status output includes duration reading, ceiling, and percent", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const definition = workflow({
			name: "budget-status-surface",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => ({ result: await ctx.stage("status-stage").complete("status") }),
		});
		const store = createStore();
		const result = await run(
			definition,
			{},
			{
				store,
				budget: { maxDurationMs: 10 },
				adapters: {
					complete: {
						complete: async (text) => {
							vi.advanceTimersByTime(5);
							return text;
						},
					},
				},
			},
		);
		assert.equal(result.status, "completed");
		const snapshot = store.runs().find((candidate) => candidate.id === result.runId)!;
		const summary = summarizeRunSnapshot(snapshot, 5);
		assert.equal(summary.budget?.maxDurationMs, 10);
		assert.equal(summary.budgetState?.duration?.reading, 5);
		assert.equal(summary.budgetState?.duration?.ceiling, 10);
		assert.equal(summary.budgetState?.duration?.percent, 50);
	});
});
test("budget_exceeded is a resumable returned blocked status", () => {
	assert.equal(isReturnedBlockedWorkflowStatus("budget_exceeded"), true);
	assert.equal(isReturnedResumableBlockedWorkflowStatus("budget_exceeded"), true);

	assert.equal(effectiveBudgetRejectsUnresolvedDeclarations, true);
});
