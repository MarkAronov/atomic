import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { Message } from "../../packages/intercom/types.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { encodeMetadata, parseCurrentMetadataRecord } from "../../packages/workflows/src/durable/dbos-metadata.js";
import type { DurableWorkflowMetadata } from "../../packages/workflows/src/durable/types.js";
import {
	markPendingStageMessageDelivered,
	PENDING_STAGE_MESSAGE_LIMIT,
	type PendingStageMessage,
	type PendingStageMessageInput,
	pendingStageMessagesFor,
	queuedPendingStageMessageCount,
	queueStageMessage,
} from "../../packages/workflows/src/shared/pending-stage-delivery.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

const RUN_ID = "run-1";
const STAGE_KEY = " Reviewer Stage ";
const RUN_GROUP = "workflow:run-1";

function message(id: string, text = `message ${id}`): Message {
	return {
		id,
		timestamp: 1_725_000_000_000 + Number(id.replace(/\D/g, "") || 0),
		content: {
			text,
			attachments: [{ type: "snippet", name: "contract.md", content: "literal amendment", language: "md" }],
		},
	};
}
function pendingMessage(id: string, overrides: Partial<PendingStageMessageInput> = {}): PendingStageMessageInput {
	return {
		runId: RUN_ID,
		stageKey: STAGE_KEY,
		from: { id: "sender-1", name: "planner", group: RUN_GROUP },
		message: message(id),
		queuedAt: `2026-08-26T00:00:${id.padStart(2, "0")}.000Z`,
		...overrides,
	};
}

describe("workflow stage messages store", () => {
	test("preserves FIFO order and verbatim message provenance", () => {
		const first = pendingMessage("1", { message: message("1", "scope changed") });
		const second = pendingMessage("2");
		const firstResult = queueStageMessage([], first, RUN_GROUP, RUN_GROUP);
		assert.equal(firstResult.ok, true);
		if (!firstResult.ok) return;
		const secondResult = queueStageMessage(firstResult.messages, second, RUN_GROUP, RUN_GROUP);
		assert.equal(secondResult.ok, true);
		if (!secondResult.ok) return;

		const queued = pendingStageMessagesFor(secondResult.messages, RUN_ID, STAGE_KEY);
		assert.deepEqual(
			queued.map((entry) => entry.id),
			["1", "2"],
		);
		assert.strictEqual(queued[0]?.message, first.message);
		assert.strictEqual(queued[0]?.from, first.from);
		assert.equal(queued[0]?.stageKey, STAGE_KEY);
		assert.equal(queued[0]?.queuedAt, first.queuedAt);
		assert.deepEqual(queued[0]?.message.content.attachments, first.message.content.attachments);
	});

	test("deduplicates a logical message id as a no-op success", () => {
		const first = queueStageMessage([], pendingMessage("same"), RUN_GROUP, RUN_GROUP);
		assert.equal(first.ok, true);
		if (!first.ok) return;
		const duplicate = queueStageMessage(
			first.messages,
			pendingMessage("same", { queuedAt: "later" }),
			RUN_GROUP,
			RUN_GROUP,
		);
		assert.equal(duplicate.ok, true);
		if (!duplicate.ok) return;
		assert.equal(duplicate.deduplicated, true);
		assert.strictEqual(duplicate.messages, first.messages);
		assert.strictEqual(duplicate.entry, first.entry);
		assert.equal(duplicate.entry.queuedAt, first.entry.queuedAt);
	});

	test("enforces the exact queued cap and delivered entries free capacity", () => {
		let messages: readonly PendingStageMessage[] = [];
		for (let index = 1; index <= PENDING_STAGE_MESSAGE_LIMIT; index++) {
			const result = queueStageMessage(messages, pendingMessage(String(index)), RUN_GROUP, RUN_GROUP);
			assert.equal(result.ok, true, `queue ${index}`);
			if (!result.ok) return;
			messages = result.messages;
		}
		assert.equal(queuedPendingStageMessageCount(messages, RUN_ID, STAGE_KEY), 50);
		const refused = queueStageMessage(messages, pendingMessage("51"), RUN_GROUP, RUN_GROUP);
		assert.deepEqual(refused, {
			ok: false,
			reason: "capacity",
			limit: PENDING_STAGE_MESSAGE_LIMIT,
			runId: RUN_ID,
			stageKey: STAGE_KEY,
		});

		messages = markPendingStageMessageDelivered(messages, RUN_ID, STAGE_KEY, "1", "2026-08-26T01:00:00.000Z");
		assert.equal(queuedPendingStageMessageCount(messages, RUN_ID, STAGE_KEY), 49);
		const afterDelivery = queueStageMessage(messages, pendingMessage("51"), RUN_GROUP, RUN_GROUP);
		assert.equal(afterDelivery.ok, true);
		if (!afterDelivery.ok) return;
		assert.equal(queuedPendingStageMessageCount(afterDelivery.messages, RUN_ID, STAGE_KEY), 50);
	});

	test("rejects a sending session outside the run group", () => {
		const result = queueStageMessage([], pendingMessage("isolated"), "other", RUN_GROUP);
		assert.deepEqual(result, {
			ok: false,
			reason: "group_mismatch",
			runId: RUN_ID,
			stageKey: STAGE_KEY,
		});
	});

	test("live store methods publish only persisted message transitions", async () => {
		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({ workflowId: RUN_ID, name: "flow", inputs: {}, status: "running", createdAt: 1 });
		const store = createStore();
		store.recordRunStart({ id: RUN_ID, name: "flow", inputs: {}, status: "running", stages: [], startedAt: 1 });
		const result = await store.queueStageMessage(pendingMessage("live"), RUN_GROUP, RUN_GROUP, backend);
		assert.equal(result?.ok, true);
		assert.deepEqual(
			store.pendingStageMessagesFor(RUN_ID, STAGE_KEY).map((entry) => entry.id),
			["live"],
		);
		assert.equal(await store.markPendingStageMessageDelivered(RUN_ID, STAGE_KEY, "live", "done", backend), true);
		assert.equal(store.pendingStageMessagesFor(RUN_ID, STAGE_KEY).length, 0);
		assert.equal(store.runs()[0]?.pendingStageMessages?.[0]?.status, "delivered");
	});
});

describe("durable workflow stage messages metadata", () => {
	function metadata(pendingStageMessages?: readonly PendingStageMessage[]): DurableWorkflowMetadata {
		return {
			workflowId: RUN_ID,
			name: "flow",
			inputs: {},
			status: "running",
			completedCheckpoints: 0,
			pendingPrompts: 0,
			promptReservationEpoch: "epoch",
			createdAt: 1,
			updatedAt: 2,
			...(pendingStageMessages !== undefined ? { pendingStageMessages } : {}),
		};
	}

	test("encode and parse restore messages verbatim", () => {
		const accepted = queueStageMessage([], pendingMessage("durable"), RUN_GROUP, RUN_GROUP);
		assert.equal(accepted.ok, true);
		if (!accepted.ok) return;
		const parsed = parseCurrentMetadataRecord(
			{ stepName: "__atomic_metadata:2:test", output: encodeMetadata(metadata(accepted.messages)) },
			RUN_ID,
		);
		assert.deepEqual(parsed?.pendingStageMessages, accepted.messages);
	});

	test("metadata without pending messages hydrates an empty collection", () => {
		const parsed = parseCurrentMetadataRecord(
			{ stepName: "__atomic_metadata:2:test", output: encodeMetadata(metadata()) },
			RUN_ID,
		);
		assert.deepEqual(parsed?.pendingStageMessages, []);
	});

	test("in-memory metadata preserves updates and defaults absent pending message collections", () => {
		const accepted = queueStageMessage([], pendingMessage("memory"), RUN_GROUP, RUN_GROUP);
		assert.equal(accepted.ok, true);
		if (!accepted.ok) return;
		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({
			workflowId: RUN_ID,
			name: "flow",
			inputs: {},
			status: "running",
			createdAt: 1,
			pendingStageMessages: accepted.messages,
		});
		assert.deepEqual(backend.toMetadata(RUN_ID)?.pendingStageMessages, accepted.messages);
		backend.registerWorkflow({ workflowId: "empty", name: "empty", inputs: {}, status: "running", createdAt: 1 });
		assert.deepEqual(backend.getWorkflow("empty")?.pendingStageMessages, []);
	});

	test("store lifecycle transitions survive DBOS metadata reload", async () => {
		const sdk = createMockSdk();
		const backend = new DbosDurableBackend(sdk, { executorId: "pending-stage-writer" });
		backend.registerWorkflow({
			workflowId: RUN_ID,
			name: "flow",
			inputs: {},
			status: "running",
			createdAt: 1,
		});
		await backend.flush();
		const store = createStore();
		store.recordRunStart({ id: RUN_ID, name: "flow", inputs: {}, status: "running", stages: [], startedAt: 1 });

		const queued = await store.queueStageMessage(pendingMessage("queued"), RUN_GROUP, RUN_GROUP, backend);
		assert.equal(queued?.ok, true);
		let reloaded = new DbosDurableBackend(sdk, { executorId: "pending-stage-reader-add" });
		await reloaded.hydrateWorkflow(RUN_ID);
		assert.deepEqual(
			reloaded.getWorkflow(RUN_ID)?.pendingStageMessages?.map(({ id, status }) => ({ id, status })),
			[{ id: "queued", status: "queued" }],
		);

		assert.equal(
			await store.markPendingStageMessageDelivered(RUN_ID, STAGE_KEY, "queued", "2026-08-27T12:00:00.000Z", backend),
			true,
		);
		reloaded = new DbosDurableBackend(sdk, { executorId: "pending-stage-reader-delivered" });
		await reloaded.hydrateWorkflow(RUN_ID);
		assert.deepEqual(
			reloaded.getWorkflow(RUN_ID)?.pendingStageMessages?.map(({ id, status }) => ({ id, status })),
			[{ id: "queued", status: "delivered" }],
		);

		const refused = await store.queueStageMessage(pendingMessage("refused"), RUN_GROUP, RUN_GROUP, backend);
		assert.equal(refused?.ok, true);
		assert.equal(
			await store.markPendingStageMessageUndeliverable(RUN_ID, STAGE_KEY, "refused", "stage ended", backend),
			true,
		);
		reloaded = new DbosDurableBackend(sdk, { executorId: "pending-stage-reader-undeliverable" });
		await reloaded.hydrateWorkflow(RUN_ID);
		assert.deepEqual(
			reloaded.getWorkflow(RUN_ID)?.pendingStageMessages?.map(({ id, status }) => ({ id, status })),
			[
				{ id: "queued", status: "delivered" },
				{ id: "refused", status: "undeliverable" },
			],
		);
	});

	test("concurrent queue transitions retain FIFO in live and reloaded metadata", async () => {
		const sdk = createMockSdk();
		const backend = new DbosDurableBackend(sdk, { executorId: "pending-stage-concurrent-writer" });
		backend.registerWorkflow({ workflowId: RUN_ID, name: "flow", inputs: {}, status: "running", createdAt: 1 });
		await backend.flush();
		const store = createStore();
		store.recordRunStart({ id: RUN_ID, name: "flow", inputs: {}, status: "running", stages: [], startedAt: 1 });

		const [first, second] = await Promise.all([
			store.queueStageMessage(pendingMessage("1"), RUN_GROUP, RUN_GROUP, backend),
			store.queueStageMessage(pendingMessage("2"), RUN_GROUP, RUN_GROUP, backend),
		]);
		assert.equal(first?.ok && first.position, 1);
		assert.equal(second?.ok && second.position, 2);
		assert.deepEqual(
			store.pendingStageMessagesFor(RUN_ID, STAGE_KEY).map(({ id }) => id),
			["1", "2"],
		);

		const reloaded = new DbosDurableBackend(sdk, { executorId: "pending-stage-concurrent-reader" });
		await reloaded.hydrateWorkflow(RUN_ID);
		assert.deepEqual(
			reloaded.getWorkflow(RUN_ID)?.pendingStageMessages?.map(({ id }) => id),
			["1", "2"],
		);
	});

	test("DBOS rejection leaves the transition invisible and propagates the error", async () => {
		const sdk = createMockSdk();
		let rejectWrites = false;
		const backend = new DbosDurableBackend(
			{
				...sdk,
				async recordStepOutput(workflowId, stepName, output) {
					if (rejectWrites) throw new Error("pending stage DBOS write rejected");
					await sdk.recordStepOutput(workflowId, stepName, output);
				},
			},
			{ executorId: "pending-stage-rejection-writer" },
		);
		backend.registerWorkflow({ workflowId: RUN_ID, name: "flow", inputs: {}, status: "running", createdAt: 1 });
		await backend.flush();
		const store = createStore();
		store.recordRunStart({ id: RUN_ID, name: "flow", inputs: {}, status: "running", stages: [], startedAt: 1 });
		let notifications = 0;
		store.subscribeInvalidation(() => notifications++);
		rejectWrites = true;

		await assert.rejects(
			store.queueStageMessage(pendingMessage("rejected"), RUN_GROUP, RUN_GROUP, backend),
			/pending stage DBOS write rejected/,
		);
		assert.equal(notifications, 0);
		assert.deepEqual(store.pendingStageMessagesFor(RUN_ID, STAGE_KEY), []);
		const reloaded = new DbosDurableBackend(sdk, { executorId: "pending-stage-rejection-reader" });
		await reloaded.hydrateWorkflow(RUN_ID);
		assert.deepEqual(reloaded.getWorkflow(RUN_ID)?.pendingStageMessages, []);
	});
});
