import assert from "node:assert/strict";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import {
	createRunBudgetController,
	WorkflowBudgetExceededError,
} from "../../packages/workflows/src/engine/run-budget.js";
import { loadConfigFile } from "../../packages/workflows/src/extension/config-file-loader.js";
import { withWorkflowDefaults } from "../../packages/workflows/src/extension/config-loader.js";
import { WorkflowParametersSchema } from "../../packages/workflows/src/extension/workflow-schema.js";
import {
	type EffectiveBudget,
	enforceDurationBudget,
import { createRunBudgetController, WorkflowBudgetExceededError } from "../../packages/workflows/src/engine/run-budget.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
 import {
 	isReturnedBlockedWorkflowStatus,
 	isReturnedResumableBlockedWorkflowStatus,
 } from "../../packages/workflows/src/shared/returned-run-status.js";
	isReturnedBlockedWorkflowStatus,
	isReturnedResumableBlockedWorkflowStatus,
} from "../../packages/workflows/src/shared/returned-run-status.js";
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

test("budget_exceeded is a resumable returned blocked status", () => {
	assert.equal(isReturnedBlockedWorkflowStatus("budget_exceeded"), true);
	assert.equal(isReturnedResumableBlockedWorkflowStatus("budget_exceeded"), true);

	assert.equal(effectiveBudgetRejectsUnresolvedDeclarations, true);
});
