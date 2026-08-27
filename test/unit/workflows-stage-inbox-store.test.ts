import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { Message } from "../../packages/intercom/types.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { encodeMetadata, parseCurrentMetadataRecord } from "../../packages/workflows/src/durable/dbos-metadata.js";
import type { DurableWorkflowMetadata } from "../../packages/workflows/src/durable/types.js";
import {
	depositStageInboxEntry,
	markStageInboxEntryDelivered,
	peekStageInbox,
	queuedStageInboxCount,
	STAGE_INBOX_MAX_ENTRIES,
	type StageInboxDeposit,
	type StageInboxEntry,
} from "../../packages/workflows/src/shared/stage-inbox.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

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

function deposit(id: string, overrides: Partial<StageInboxDeposit> = {}): StageInboxDeposit {
	return {
		runId: RUN_ID,
		stageKey: STAGE_KEY,
		from: { id: "sender-1", name: "planner", group: RUN_GROUP },
		message: message(id),
		depositedAt: `2026-08-26T00:00:${id.padStart(2, "0")}.000Z`,
		...overrides,
	};
}

describe("workflow stage inbox store", () => {
	test("preserves FIFO order and verbatim message provenance", () => {
		const first = deposit("1", { message: message("1", "scope changed") });
		const second = deposit("2");
		const firstResult = depositStageInboxEntry([], first, RUN_GROUP, RUN_GROUP);
		assert.equal(firstResult.ok, true);
		if (!firstResult.ok) return;
		const secondResult = depositStageInboxEntry(firstResult.inbox, second, RUN_GROUP, RUN_GROUP);
		assert.equal(secondResult.ok, true);
		if (!secondResult.ok) return;

		const queued = peekStageInbox(secondResult.inbox, RUN_ID, STAGE_KEY);
		assert.deepEqual(
			queued.map((entry) => entry.id),
			["1", "2"],
		);
		assert.strictEqual(queued[0]?.message, first.message);
		assert.strictEqual(queued[0]?.from, first.from);
		assert.equal(queued[0]?.stageKey, STAGE_KEY);
		assert.equal(queued[0]?.depositedAt, first.depositedAt);
		assert.deepEqual(queued[0]?.message.content.attachments, first.message.content.attachments);
	});

	test("deduplicates a logical message id as a no-op success", () => {
		const first = depositStageInboxEntry([], deposit("same"), RUN_GROUP, RUN_GROUP);
		assert.equal(first.ok, true);
		if (!first.ok) return;
		const duplicate = depositStageInboxEntry(
			first.inbox,
			deposit("same", { depositedAt: "later" }),
			RUN_GROUP,
			RUN_GROUP,
		);
		assert.equal(duplicate.ok, true);
		if (!duplicate.ok) return;
		assert.equal(duplicate.deduplicated, true);
		assert.strictEqual(duplicate.inbox, first.inbox);
		assert.strictEqual(duplicate.entry, first.entry);
		assert.equal(duplicate.entry.depositedAt, first.entry.depositedAt);
	});

	test("enforces the exact queued cap and delivered entries free capacity", () => {
		let inbox: readonly StageInboxEntry[] = [];
		for (let index = 1; index <= STAGE_INBOX_MAX_ENTRIES; index++) {
			const result = depositStageInboxEntry(inbox, deposit(String(index)), RUN_GROUP, RUN_GROUP);
			assert.equal(result.ok, true, `deposit ${index}`);
			if (!result.ok) return;
			inbox = result.inbox;
		}
		assert.equal(queuedStageInboxCount(inbox, RUN_ID, STAGE_KEY), 50);
		const refused = depositStageInboxEntry(inbox, deposit("51"), RUN_GROUP, RUN_GROUP);
		assert.deepEqual(refused, {
			ok: false,
			reason: "capacity",
			limit: STAGE_INBOX_MAX_ENTRIES,
			runId: RUN_ID,
			stageKey: STAGE_KEY,
		});

		inbox = markStageInboxEntryDelivered(inbox, RUN_ID, STAGE_KEY, "1", "2026-08-26T01:00:00.000Z");
		assert.equal(queuedStageInboxCount(inbox, RUN_ID, STAGE_KEY), 49);
		const afterDelivery = depositStageInboxEntry(inbox, deposit("51"), RUN_GROUP, RUN_GROUP);
		assert.equal(afterDelivery.ok, true);
		if (!afterDelivery.ok) return;
		assert.equal(queuedStageInboxCount(afterDelivery.inbox, RUN_ID, STAGE_KEY), 50);
	});

	test("rejects a depositing session outside the run group", () => {
		const result = depositStageInboxEntry([], deposit("isolated"), "other", RUN_GROUP);
		assert.deepEqual(result, {
			ok: false,
			reason: "group_mismatch",
			runId: RUN_ID,
			stageKey: STAGE_KEY,
		});
	});

	test("live store methods mutate the optional run inbox collection", () => {
		const store = createStore();
		store.recordRunStart({ id: RUN_ID, name: "flow", inputs: {}, status: "running", stages: [], startedAt: 1 });
		const result = store.depositStageInboxEntry(deposit("live"), RUN_GROUP, RUN_GROUP);
		assert.equal(result?.ok, true);
		assert.deepEqual(
			store.peekStageInbox(RUN_ID, STAGE_KEY).map((entry) => entry.id),
			["live"],
		);
		assert.equal(store.markStageInboxEntryDelivered(RUN_ID, STAGE_KEY, "live", "done"), true);
		assert.equal(store.peekStageInbox(RUN_ID, STAGE_KEY).length, 0);
		assert.equal(store.runs()[0]?.stageInbox?.[0]?.status, "delivered");
	});
});

describe("durable workflow stage inbox metadata", () => {
	function metadata(stageInbox?: readonly StageInboxEntry[]): DurableWorkflowMetadata {
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
			...(stageInbox !== undefined ? { stageInbox } : {}),
		};
	}

	test("encode and parse restore inbox messages verbatim", () => {
		const accepted = depositStageInboxEntry([], deposit("durable"), RUN_GROUP, RUN_GROUP);
		assert.equal(accepted.ok, true);
		if (!accepted.ok) return;
		const parsed = parseCurrentMetadataRecord(
			{ stepName: "__atomic_metadata:2:test", output: encodeMetadata(metadata(accepted.inbox)) },
			RUN_ID,
		);
		assert.deepEqual(parsed?.stageInbox, accepted.inbox);
	});

	test("metadata without an inbox hydrates an empty collection", () => {
		const parsed = parseCurrentMetadataRecord(
			{ stepName: "__atomic_metadata:2:test", output: encodeMetadata(metadata()) },
			RUN_ID,
		);
		assert.deepEqual(parsed?.stageInbox, []);
	});

	test("in-memory metadata preserves inbox updates and defaults absent inboxes", () => {
		const accepted = depositStageInboxEntry([], deposit("memory"), RUN_GROUP, RUN_GROUP);
		assert.equal(accepted.ok, true);
		if (!accepted.ok) return;
		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({
			workflowId: RUN_ID,
			name: "flow",
			inputs: {},
			status: "running",
			createdAt: 1,
			stageInbox: accepted.inbox,
		});
		assert.deepEqual(backend.toMetadata(RUN_ID)?.stageInbox, accepted.inbox);
		backend.registerWorkflow({ workflowId: "empty", name: "empty", inputs: {}, status: "running", createdAt: 1 });
		assert.deepEqual(backend.getWorkflow("empty")?.stageInbox, []);
	});
});
