import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterEach, describe, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { isLiveRunningWorkflow } from "../../packages/workflows/src/durable/resume-eligibility.js";
import {
	createDurableTaskPrimitive,
	TASK_RESULT_CHECKPOINT_CONTROL_PREFIX,
} from "../../packages/workflows/src/durable/stage-primitive.js";
import type { DurableCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { createRunBudgetController } from "../../packages/workflows/src/engine/run-budget.js";
import {
	IMPOSSIBLE_ROOT_LIVENESS_MESSAGE,
	isImpossibleRootLiveness,
} from "../../packages/workflows/src/engine/run-liveness.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { summarizeRunSnapshot } from "../../packages/workflows/src/extension/workflow-status-summary.js";
import { interruptAllRuns, interruptRun } from "../../packages/workflows/src/runs/background/status.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { resolve_budget } from "../../packages/workflows/src/shared/budget.js";
import { effectiveRunStatus } from "../../packages/workflows/src/shared/returned-run-status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";

afterEach(() => {
	vi.useRealTimers();
	setDurableBackend(undefined);
});

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

	test("terminal-only stage checkpoint replays a completed task without rerunning it", async () => {
		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({
			workflowId: "wf-task-terminal-only",
			name: "task-terminal-only",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: "wf-task-terminal-only",
			checkpointId: "stage:stage:task:review:1",
			name: "review",
			replayKey: "stage:task:review:1",
			output: "terminal review text",
			completedAt: 2,
			sessionId: "sess-review",
			sessionFile: "/tmp/review.jsonl",
			model: "openai/gpt-test",
			structured: { approved: true, score: 4 },
			artifacts: [{ kind: "diff", path: "/tmp/review.diff", taskName: "review" }],
			warnings: ["used fallback model"],
		});
		let prompts = 0;
		const replayOnly = workflow({
			name: "task-terminal-only",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				const review = await ctx.task("review", { prompt: "ignored" });
				return {
					result: JSON.stringify({
						text: review.text,
						structured: review.structured,
						artifacts: review.artifacts,
						warnings: review.warnings,
						sessionId: review.sessionId,
						sessionFile: review.sessionFile,
						model: review.model,
					}),
				};
			},
		});
		const replayed = await run(
			replayOnly,
			{},
			{
				runId: "wf-task-terminal-only",
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
		assert.deepEqual(JSON.parse(replayed.result?.result ?? ""), {
			text: "terminal review text",
			structured: { approved: true, score: 4 },
			artifacts: [{ kind: "diff", path: "/tmp/review.diff", taskName: "review" }],
			warnings: ["used fallback model"],
			sessionId: "sess-review",
			sessionFile: "/tmp/review.jsonl",
			model: "openai/gpt-test",
		});
		assert.equal(prompts, 0);
	});

	test("terminal-only replay returns structured artifacts and warnings without rerunning", async () => {
		const backend = new InMemoryDurableBackend();
		const replayKey = "stage:task:review:1";
		backend.registerWorkflow({
			workflowId: "wf-task-terminal-fields",
			name: "task-terminal-fields",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: "wf-task-terminal-fields",
			checkpointId: `stage:${replayKey}`,
			name: "review",
			replayKey,
			output: "terminal review text",
			completedAt: 2,
			sessionFile: "/tmp/review.jsonl",
			structured: { approved: false },
			artifacts: [{ kind: "patch", path: "/tmp/review.patch" }],
			warnings: ["rate limited once"],
		});
		const task = createDurableTaskPrimitive({
			workflowId: "wf-task-terminal-fields",
			backend,
			nextReplayKey: () => replayKey,
			task: async () => {
				throw new Error("live task should not run");
			},
		});
		assert.deepEqual(await task("review", { prompt: "ignored" }), {
			name: "review",
			stageName: "review",
			text: "terminal review text",
			structured: { approved: false },
			sessionFile: "/tmp/review.jsonl",
			artifacts: [{ kind: "patch", path: "/tmp/review.patch" }],
			warnings: ["rate limited once"],
		});
	});

	test("quit and interrupt terminate a root awaiting a never-settling task-result checkpoint", async () => {
		const backend = new DelayedTaskCheckpointBackend();
		setDurableBackend(backend);
		const store = createStore();
		const registry = createStageControlRegistry();
		const toolControls = createToolControlRegistry();
		const pending = run(
			taskThenTool,
			{},
			{
				store,
				durableBackend: backend,
				stageControlRegistry: registry,
				toolControlRegistry: toolControls,
				adapters: { prompt: { prompt: async () => "review done" } },
			},
		);
		const deadline = Date.now() + 2_000;
		let runId = "";
		while (Date.now() < deadline) {
			runId = store.runs().find((candidate) => candidate.name === taskThenTool.name)?.id ?? "";
			if (runId !== "" && toolControls.active(runId).some((handle) => handle.nodeId.startsWith("task-checkpoint:")))
				break;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.ok(runId.length > 0);
		assert.equal(registry.run(runId).stages().length, 0);
		const interrupted = await interruptRun(runId, {
			store,
			stageControlRegistry: registry,
			toolControlRegistry: toolControls,
		});
		assert.equal(interrupted.ok, true);
		const finished = await pending;
		assert.equal(finished.status, "paused");
		assert.equal(store.runs().find((candidate) => candidate.id === runId)?.status, "paused");
		assert.equal(store.runs().find((candidate) => candidate.id === runId)?.exitReason, "quit");
		assert.equal(backend.getWorkflow(runId)?.status, "paused");
	});

	test("a checkpoint created after its signal is already aborted does not become an unhandled rejection", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const backend = new InMemoryDurableBackend();
			const controller = new AbortController();
			const reason = new Error("cancelled before checkpoint");
			const task = createDurableTaskPrimitive({
				workflowId: "wf-preabort-checkpoint",
				backend,
				nextReplayKey: () => "stage:task:review:1",
				signal: controller.signal,
				task: async () => {
					controller.abort(reason);
					return { name: "review", stageName: "review", text: "done" };
				},
			});
			await assert.rejects(
				() => task("review", { prompt: "review the change" }),
				(error) => error === reason,
			);
			await Promise.resolve();
			await new Promise((resolve) => setTimeout(resolve, 15));
			assert.deepEqual(unhandled, []);
			assert.equal(backend.getStageOutput("wf-preabort-checkpoint", "stage:task:review:1"), undefined);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	test("an active task-checkpoint control is not diagnosed as a stranded root", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const backend = new DelayedTaskCheckpointBackend();
		const store = createStore();
		const toolControls = createToolControlRegistry();
		const pending = run(
			taskThenTool,
			{},
			{
				store,
				durableBackend: backend,
				toolControlRegistry: toolControls,
				budget: { maxDurationMs: 10 },
				adapters: { prompt: { prompt: async () => "review done" } },
			},
		);
		await vi.advanceTimersByTimeAsync(0);
		const snapshotAfterTask = store.runs().find((candidate) => candidate.name === taskThenTool.name);
		assert.ok(snapshotAfterTask);
		assert.equal(
			toolControls
				.active(snapshotAfterTask.id)
				.some((handle) => handle.nodeId.startsWith(TASK_RESULT_CHECKPOINT_CONTROL_PREFIX)),
			true,
		);
		await vi.advanceTimersByTimeAsync(20);
		const live = store.runs().find((candidate) => candidate.id === snapshotAfterTask.id);
		assert.ok(live);
		assert.equal(live.status, "running");
		assert.equal(isImpossibleRootLiveness(live, 20), true);
		assert.equal(isImpossibleRootLiveness(live, 20, { hasActiveControlNode: true }), false);
		assert.equal(summarizeRunSnapshot(live, 20, { toolControlRegistry: toolControls }).strandedRoot, undefined);
		assert.equal(summarizeRunSnapshot(live, 20, { toolControlRegistry: toolControls }).error, undefined);
		backend.gate.release();
		const result = await pending;
		assert.equal(budgetOutcome(result.result)?.status, "budget_exceeded");
	});

	test("an expanded child task-checkpoint control is not diagnosed as a stranded root", () => {
		const toolControls = createToolControlRegistry();
		toolControls.register({
			runId: "child",
			nodeId: `${TASK_RESULT_CHECKPOINT_CONTROL_PREFIX}stage:task:review:1`,
			name: "review",
			controller: new AbortController(),
			settled: new Promise(() => {}),
		});
		const parent: RunSnapshot = {
			id: "parent",
			name: "parent",
			inputs: {},
			status: "running",
			stages: [
				{
					id: "review",
					name: "review",
					status: "completed",
					parentIds: [],
					toolEvents: [],
					workflowGraphTarget: { runId: "child", stageId: "review", runName: "child-wf", depth: 1 },
				} as RunSnapshot["stages"][number],
			],
			toolNodes: [],
			startedAt: 0,
			budget: { maxDurationMs: 10, warnAtPercent: 80 },
		};
		assert.equal(isImpossibleRootLiveness(parent, 20), true);
		assert.equal(summarizeRunSnapshot(parent, 20, { toolControlRegistry: toolControls }).strandedRoot, undefined);
		assert.equal(summarizeRunSnapshot(parent, 20, { toolControlRegistry: toolControls }).error, undefined);
	});

	test("interruptAllRuns forwards an injected tool-control registry to a task tail", async () => {
		const backend = new DelayedTaskCheckpointBackend();
		setDurableBackend(backend);
		const store = createStore();
		const registry = createStageControlRegistry();
		const toolControls = createToolControlRegistry();
		const pending = run(
			taskThenTool,
			{},
			{
				store,
				durableBackend: backend,
				stageControlRegistry: registry,
				toolControlRegistry: toolControls,
				adapters: { prompt: { prompt: async () => "review done" } },
			},
		);
		const deadline = Date.now() + 2_000;
		let runId = "";
		while (Date.now() < deadline) {
			runId = store.runs().find((candidate) => candidate.name === taskThenTool.name)?.id ?? "";
			if (runId !== "" && toolControls.active(runId).some((handle) => handle.nodeId.startsWith("task-checkpoint:")))
				break;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.ok(runId.length > 0);
		const interrupted = await interruptAllRuns({
			store,
			stageControlRegistry: registry,
			toolControlRegistry: toolControls,
		});
		assert.equal(interrupted.length, 1);
		assert.equal(interrupted[0]?.ok, true);
		const finished = await pending;
		assert.equal(finished.status, "paused");
		assert.equal(store.runs().find((candidate) => candidate.id === runId)?.exitReason, "quit");
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

	test("stale running handles remain crashed rather than live", () => {
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
