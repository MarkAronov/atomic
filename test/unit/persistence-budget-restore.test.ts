import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterEach, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { isWorkflowRunResumable } from "../../packages/workflows/src/durable/resume-eligibility.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { restoreOnSessionStart, type SessionEntry } from "../../packages/workflows/src/shared/persistence-restore.js";
import { effectiveRunStatus } from "../../packages/workflows/src/shared/returned-run-status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";

afterEach(() => vi.useRealTimers());

test("budget boundary-only exhaustion survives durable session restore without a failed stage id", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
	const entries: Array<{ readonly id: string; readonly type: string; readonly payload: Record<string, unknown> }> = [];
	const persistence = {
		appendEntry(type: string, payload: Record<string, unknown>): string {
			const id = `budget-entry-${entries.length + 1}`;
			entries.push({ id, type, payload });
			return id;
		},
	};
	const definition = workflow({
		name: "budget-restore-boundary",
		description: "",
		inputs: {},
		outputs: { result: Type.String() },
		budget: { maxDurationMs: 1 },
		run: async (ctx) => {
			vi.advanceTimersByTime(2);
			await ctx.stage("never-dispatched").complete("must not run");
			return { result: "completed" };
		},
	});
	const sourceStore = createStore();
	const source = await run(
		definition,
		{},
		{
			store: sourceStore,
			persistence,
			durableBackend: new InMemoryDurableBackend(),
			adapters: {
				complete: { complete: async (text) => text },
				prompt: { prompt: async () => "must not wrap without a live turn" },
			},
		},
	);
	const sourceSnapshot = sourceStore.runs().find((candidate) => candidate.id === source.runId);
	assert.equal((source.result as { readonly status?: string } | undefined)?.status, "budget_exceeded");
	assert.deepEqual(sourceSnapshot?.stages, []);
	assert.equal(sourceSnapshot?.failedStageId, undefined);
	const blockedEntry = entries.find((entry) => entry.type === "workflow.run.blocked");
	assert.notEqual(blockedEntry, undefined);
	assert.equal(blockedEntry?.payload.failedStageId, undefined);

	const restoredStore = createStore();
	restoreOnSessionStart(
		{ getEntries: () => entries as unknown as SessionEntry[] },
		{ resumeInFlight: "never", persistRuns: true },
		restoredStore,
	);
	const restored = restoredStore.runs().find((candidate) => candidate.id === source.runId);
	assert.notEqual(restored, undefined);
	assert.deepEqual(restored?.stages, []);
	assert.deepEqual(restored?.budget, { maxDurationMs: 1, warnAtPercent: 80 });
	assert.deepEqual(blockedEntry?.payload.budgetState, sourceSnapshot?.budgetState);
	assert.deepEqual(restored?.budgetState, sourceSnapshot?.budgetState);
	assert.deepEqual(restored?.result, source.result);
	assert.equal(restored?.endedAt, sourceSnapshot?.endedAt);
	assert.equal(effectiveRunStatus(restored as RunSnapshot), "blocked");
	assert.equal(
		isWorkflowRunResumable({
			...(restored as RunSnapshot),
			budgetSystemOwnedStop: true,
		}),
		true,
	);
});

test("budget resume eligibility admits ended system stops but rejects ended non-budget stops", () => {
	const endedBudgetStop = {
		status: "running" as const,
		endedAt: 10,
		resumable: true,
		failureRecoverability: "recoverable" as const,
		budgetSystemOwnedStop: true,
	};
	assert.equal(isWorkflowRunResumable(endedBudgetStop), true);
	assert.equal(isWorkflowRunResumable({ ...endedBudgetStop, budgetSystemOwnedStop: false }), false);
});
