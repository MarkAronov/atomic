import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterEach, describe, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { isLiveRunningWorkflow } from "../../packages/workflows/src/durable/resume-eligibility.js";
import type { DurableCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { createRunBudgetController } from "../../packages/workflows/src/engine/run-budget.js";
import {
	IMPOSSIBLE_ROOT_LIVENESS_MESSAGE,
	isImpossibleRootLiveness,
} from "../../packages/workflows/src/engine/run-liveness.js";
import { summarizeRunSnapshot } from "../../packages/workflows/src/extension/workflow-status-summary.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { resolve_budget } from "../../packages/workflows/src/shared/budget.js";
import { effectiveRunStatus } from "../../packages/workflows/src/shared/returned-run-status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";

afterEach(() => vi.useRealTimers());

function budgetOutcome(value: object | undefined): { readonly status?: string } | undefined {
	return value as { readonly status?: string } | undefined;
}

class Gate {
	release!: () => void;
	readonly barrier = new Promise<void>((resolve) => {
		this.release = resolve;
	});
}

class DelayedTaskCheckpointBackend extends InMemoryDurableBackend {
	readonly gate = new Gate();
	failTaskCheckpoint = false;
	taskCheckpoints = 0;
	override async recordCheckpointAsync(checkpoint: DurableCheckpoint): Promise<void> {
		if (checkpoint.kind === "stage" && checkpoint.checkpointId.startsWith("task:")) {
			this.taskCheckpoints += 1;
			await this.gate.barrier;
			if (this.failTaskCheckpoint) throw new Error("task-result checkpoint failed");
		}
		await super.recordCheckpointAsync(checkpoint);
	}
}

const taskThenTool = workflow({
	name: "task-then-tool",
	description: "",
	inputs: {},
	outputs: { result: Type.String() },
	run: async (ctx) => {
		const review = await ctx.task("review", { prompt: "review the change" });
		const verified = await ctx.tool("verify", { from: review.text }, async () => "verified");
		return { result: verified };
	},
});

describe("ctx.task tail liveness", () => {
	test("delayed task-result checkpoint past the duration ceiling becomes budget_exceeded", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const backend = new DelayedTaskCheckpointBackend();
		const store = createStore();
		const pending = run(
			taskThenTool,
			{},
			{
				store,
				durableBackend: backend,
				budget: { maxDurationMs: 10 },
				adapters: { prompt: { prompt: async () => "review done" } },
			},
		);
		await vi.advanceTimersByTimeAsync(0);
		const snapshotAfterTask = store.runs().find((candidate) => candidate.name === taskThenTool.name);
		assert.equal(
			snapshotAfterTask?.stages.some((stage) => stage.name === "review" && stage.status === "completed"),
			true,
		);
		assert.equal(snapshotAfterTask?.status, "running");
		assert.equal((snapshotAfterTask?.toolNodes ?? []).length, 0);

		await vi.advanceTimersByTimeAsync(20);
		backend.gate.release();
		const result = await pending;
		const snapshot = store.runs().find((candidate) => candidate.id === result.runId);
		assert.equal(budgetOutcome(result.result)?.status, "budget_exceeded");
		assert.equal(effectiveRunStatus(snapshot!), "blocked");
		assert.equal(isImpossibleRootLiveness(snapshot!), false);
		assert.equal(
			(snapshot?.toolNodes ?? []).some((tool) => tool.name === "verify"),
			false,
		);
	});

	test("task-result checkpoint failure rejects the root instead of leaving it pending", async () => {
		const backend = new DelayedTaskCheckpointBackend();
		backend.failTaskCheckpoint = true;
		const store = createStore();
		const pending = run(
			taskThenTool,
			{},
			{
				store,
				durableBackend: backend,
				adapters: { prompt: { prompt: async () => "review done" } },
			},
		);
		await Promise.resolve();
		backend.gate.release();
		const result = await pending;
		const snapshot = store.runs().find((candidate) => candidate.id === result.runId);
		assert.equal(result.status, "failed");
		assert.equal(snapshot?.status, "failed");
		assert.match(result.error ?? "", /task-result checkpoint failed/);
		assert.equal(snapshot?.endedAt !== undefined, true);
	});

	test("resumed replay reuses the completed task checkpoint without rerunning it", async () => {
		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({
			workflowId: "wf-task-tail-replay",
			name: "task-replay-only",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: "wf-task-tail-replay",
			checkpointId: "task:stage:task:review:1",
			name: "review",
			replayKey: "stage:task:review:1",
			output: { name: "review", stageName: "review", text: "cached review" },
			completedAt: 2,
		});
		let prompts = 0;
		const replayOnly = workflow({
			name: "task-replay-only",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => ({ result: (await ctx.task("review", { prompt: "ignored" })).text }),
		});
		const replayed = await run(
			replayOnly,
			{},
			{
				runId: "wf-task-tail-replay",
				store: createStore(),
				durableBackend: backend,
				adapters: {
					prompt: {
						prompt: async () => {
							prompts += 1;
							return "must not rerun";
						},
					},
				},
			},
		);
		assert.equal(replayed.status, "completed");
		assert.equal(replayed.result?.result, "cached review");
		assert.equal(prompts, 0);
	});

	test("status reports a stranded completed frontier that is still raw-running over budget", () => {
		const runSnapshot: RunSnapshot = {
			id: "stranded",
			name: "stranded",
			inputs: {},
			status: "running",
			stages: [
				{
					id: "review",
					name: "review",
					status: "completed",
					parentIds: [],
					toolEvents: [],
				},
			],
			toolNodes: [],
			startedAt: 0,
			budget: { maxDurationMs: 10, warnAtPercent: 80 },
		};
		assert.equal(isImpossibleRootLiveness(runSnapshot, 20), true);
		const summary = summarizeRunSnapshot(runSnapshot, 20);
		assert.equal(summary.strandedRoot, true);
		assert.equal(summary.error, IMPOSSIBLE_ROOT_LIVENESS_MESSAGE);
		assert.equal(summary.status, "running");
	});

	test("stale DBOS hydration cannot treat a completed-frontier running handle as live", () => {
		assert.equal(isLiveRunningWorkflow({ status: "running", updatedAt: 1 }, 200_000), false);
	});

	test("stopAtBoundaryAsync does not await a stale wrap-up after the stage control is gone", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const runSnapshot: RunSnapshot = {
			id: "stale-wrap",
			name: "stale-wrap",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: 0,
		};
		const controller = createRunBudgetController({
			run: runSnapshot,
			budget: resolve_budget({ run: { maxDurationMs: 1 } }),
		});
		const hung = controller.registerWrapUp("review", () => new Promise<never>(() => {}));
		void controller.deliverWrapUp("review").catch(() => undefined);
		hung();
		vi.setSystemTime(10);
		await assert.rejects(() => controller.stopAtBoundaryAsync("review"), /budget exceeded/);
	});
});
