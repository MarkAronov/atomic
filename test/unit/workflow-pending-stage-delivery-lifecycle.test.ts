import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { settleUndeliverablePendingStageMessages } from "../../packages/workflows/src/extension/pending-stage-intercom.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type {
	PendingStageMessageInput,
	RunStatus,
	StageStatus,
} from "../../packages/workflows/src/shared/store-types.js";
import { testRunId } from "../helpers/run-id.js";

function pendingMessage(runId: string, stageKey: string, expectsReply = true): PendingStageMessageInput {
	return {
		runId,
		stageKey,
		from: { id: "planner-session", name: "planner", group: `workflow:${runId}` },
		message: {
			id: `message-${stageKey}`,
			timestamp: 1_725_000_000_000,
			expectsReply,
			content: { text: "scope changed" },
		},
		queuedAt: "2026-08-26T00:00:00.000Z",
	};
}

function lifecycleFixture(runStatus: RunStatus, stageStatus: StageStatus = "pending") {
	const activeStore = createStore();
	const runId = testRunId(`pending-delivery-${runStatus}-${stageStatus}`);
	activeStore.recordRunStart({ id: runId, name: "flow", inputs: {}, status: runStatus, stages: [], startedAt: 1 });
	activeStore.recordStageStart(runId, {
		id: "review-stage",
		name: "reviewer",
		status: stageStatus,
		parentIds: [],
		toolEvents: [],
		...(stageStatus === "skipped" ? { skippedReason: "fail-fast" } : {}),
	});
	const accepted = activeStore.queueStageMessage(
		pendingMessage(runId, "review-stage"),
		`workflow:${runId}`,
		`workflow:${runId}`,
	);
	assert.equal(accepted?.ok, true);
	return { activeStore, runId };
}

describe("pending workflow stage delivery lifecycle", () => {
	test("marks a skipped stage message undeliverable and notifies its sender", async () => {
		const { activeStore } = lifecycleFixture("running", "skipped");
		const notifications: string[] = [];
		assert.equal(
			await settleUndeliverablePendingStageMessages(activeStore, async (entry, reason) => {
				notifications.push(`${entry.from.id}:${entry.message.id}:${reason}`);
				return true;
			}),
			1,
		);
		assert.match(notifications[0] ?? "", /planner-session:message-review-stage:.*skipped.*fail-fast/);
		assert.equal(activeStore.runs()[0]?.pendingStageMessages?.[0]?.status, "undeliverable");
	});

	test("settles a cancelled run separately", async () => {
		const { activeStore } = lifecycleFixture("cancelled", "skipped");
		const reasons: string[] = [];
		await settleUndeliverablePendingStageMessages(activeStore, async (_entry, reason) => {
			reasons.push(reason);
			return true;
		});
		assert.equal(activeStore.runs()[0]?.pendingStageMessages?.[0]?.status, "undeliverable");
		assert.match(reasons[0] ?? "", /terminated with status cancelled/);
	});

	test("settles a known pending stage when its run completes before initialization", async () => {
		const { activeStore } = lifecycleFixture("completed");
		const reasons: string[] = [];
		await settleUndeliverablePendingStageMessages(activeStore, async (_entry, reason) => {
			reasons.push(reason);
			return true;
		});
		assert.equal(activeStore.runs()[0]?.pendingStageMessages?.[0]?.status, "undeliverable");
		assert.match(reasons[0] ?? "", /completed before stage review-stage started/);
	});

	test("leaves blocked and nonterminal stage routing untouched", async () => {
		for (const status of ["blocked", "running", "completed"] as const) {
			const { activeStore } = lifecycleFixture("running", status);
			assert.equal(await settleUndeliverablePendingStageMessages(activeStore, async () => true), 0);
			assert.equal(activeStore.runs()[0]?.pendingStageMessages?.[0]?.status, "queued");
		}
	});
});
