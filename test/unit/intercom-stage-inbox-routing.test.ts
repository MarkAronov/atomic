import assert from "node:assert/strict";
import type net from "node:net";
import { afterEach, describe, test } from "vitest";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import {
	type BrokerConnectedSession,
	handleBrokerSend,
	STAGE_INBOX_ASK_REFUSAL,
	stageInboxAskRefusal,
} from "../../packages/intercom/broker/send-handler.js";
import type { BrokerMessage, Message, SessionInfo } from "../../packages/intercom/types.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { registerStageInboxIntercomBridge } from "../../packages/workflows/src/extension/stage-inbox-intercom.js";
import { createWorkflowStageInboxDelivery } from "../../packages/workflows/src/runs/foreground/stage-inbox-delivery.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

const RUN_ID = "4ac72924-c452-4e5f-9e63-2435722109f7";
const GROUP = `workflow:${RUN_ID}`;
const TARGET = `${RUN_ID}:reviewer`;

function sender(socket: net.Socket): BrokerConnectedSession {
	return {
		socket,
		info: {
			id: "sender-id",
			name: "planner",
			cwd: "/repo",
			model: "test-model",
			pid: 10,
			startedAt: 11,
			lastActivity: 12,
			group: GROUP,
		},
	};
}

function message(id: string, timestamp = 100): Message {
	return { id, timestamp, content: { text: `scope ${id}` } };
}

afterEach(() => setDurableBackend(undefined));

test("inbox fallback runs only for a valid composite unknown target and preserves ordinary unknown failures", () => {
	const socket = {} as net.Socket;
	const sessions = new Map([["sender-id", sender(socket)]]);
	const writes: BrokerMessage[] = [];
	const routed: string[] = [];
	const route = (input: { readonly runId: string; readonly stageKey: string }): boolean => {
		routed.push(`${input.runId}:${input.stageKey}`);
		return true;
	};
	handleBrokerSend(
		socket,
		{ type: "send", to: TARGET, message: message("queued") },
		"sender-id",
		sessions,
		new DeliveredMessageCache(),
		(_target, value) => writes.push(value),
		undefined,
		undefined,
		route,
	);
	assert.deepEqual(routed, [TARGET]);
	assert.equal(writes.length, 0);

	handleBrokerSend(
		socket,
		{ type: "send", to: "ordinary-missing", message: message("missing") },
		"sender-id",
		sessions,
		new DeliveredMessageCache(),
		(_target, value) => writes.push(value),
		undefined,
		undefined,
		route,
	);
	assert.deepEqual(routed, [TARGET]);
	assert.deepEqual(writes.at(-1), {
		type: "delivery_failed",
		messageId: "missing",
		attemptId: undefined,
		reason: "Session not found",
	});
});

test("inbox asks are refused with a send recommendation before deposit routing", () => {
	assert.equal(stageInboxAskRefusal({ ...message("ask"), expectsReply: true }), STAGE_INBOX_ASK_REFUSAL);
	assert.equal(stageInboxAskRefusal(message("send")), undefined);
	assert.equal(STAGE_INBOX_ASK_REFUSAL.includes("Use send"), true);
});

describe("workflows-owned inbox event bridge", () => {
	function harness() {
		const store = createStore();
		store.recordRunStart({ id: RUN_ID, name: "flow", inputs: {}, status: "running", stages: [], startedAt: 1 });
		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({ workflowId: RUN_ID, name: "flow", inputs: {}, status: "running", createdAt: 1 });
		setDurableBackend(backend);
		const listeners = new Map<string, (payload: unknown) => void>();
		const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
		const pi = {
			events: {
				emit(event: string, payload: Record<string, unknown>) {
					emitted.push({ event, payload });
					listeners.get(event)?.(payload);
				},
				on(event: string, listener: (payload: unknown) => void) {
					listeners.set(event, listener);
					return () => listeners.delete(event);
				},
			},
		};
		const dispose = registerStageInboxIntercomBridge(pi, store);
		const deposit = async (id: string, group = GROUP) => {
			const payload: {
				handled: boolean;
				completion?: Promise<
					| { readonly outcome: "queued"; readonly position: number }
					| { readonly outcome: "refused"; readonly reason: string }
				>;
				depositId: string;
				from: SessionInfo;
				runId: string;
				stageKey: string;
				message: Message;
			} = {
				handled: false,
				depositId: `deposit-${id}`,
				from: { ...sender({} as net.Socket).info, group },
				runId: RUN_ID,
				stageKey: "reviewer",
				message: message(id, 1_725_000_000_000 + Number(id)),
			};
			listeners.get("atomic:workflow-stage-inbox-deposit")?.(payload);
			return { payload, result: await payload.completion };
		};
		return { store, backend, emitted, deposit, dispose };
	}

	test("announces ownership and enforces group isolation without depositing", async () => {
		const { store, emitted, deposit, dispose } = harness();
		assert.equal(
			emitted.some(({ event }) => event === "atomic:workflow-stage-inbox-owner"),
			true,
		);
		const { payload, result } = await deposit("1", "other-group");
		assert.equal(payload.handled, true);
		assert.deepEqual(result, {
			outcome: "refused",
			reason: "Target workflow run is in a different intercom group",
		});
		assert.equal(store.peekStageInbox(RUN_ID, "reviewer").length, 0);
		dispose();
	});

	test("surfaces the exact 50-message cap boundary through the deposit event", async () => {
		const { store, backend, deposit, dispose } = harness();
		for (let index = 1; index <= 50; index += 1) {
			assert.deepEqual((await deposit(String(index))).result, { outcome: "queued", position: index });
		}
		assert.deepEqual((await deposit("51")).result, {
			outcome: "refused",
			reason: `Workflow stage inbox is full (limit 50) for ${RUN_ID}:reviewer`,
		});
		assert.equal(store.peekStageInbox(RUN_ID, "reviewer").length, 50);
		assert.equal(backend.getWorkflow(RUN_ID)?.stageInbox?.length, 50);
		dispose();
	});
});

test("drains stage id and name buckets FIFO once across stage attempt restarts with provenance", async () => {
	const store = createStore();
	store.recordRunStart({ id: RUN_ID, name: "flow", inputs: {}, status: "running", stages: [], startedAt: 1 });
	const backend = new InMemoryDurableBackend();
	backend.registerWorkflow({ workflowId: RUN_ID, name: "flow", inputs: {}, status: "running", createdAt: 1 });
	setDurableBackend(backend);
	const from = sender({} as net.Socket).info;
	store.depositStageInboxEntry(
		{ runId: RUN_ID, stageKey: "reviewer", from, message: message("later", 200), depositedAt: "2026-01-02" },
		GROUP,
		GROUP,
	);
	store.depositStageInboxEntry(
		{ runId: RUN_ID, stageKey: "stage-id", from, message: message("earlier", 100), depositedAt: "2026-01-01" },
		GROUP,
		GROUP,
	);
	const delivered: Array<{ id: string; name?: string; cwd: string; timestamp: number }> = [];
	const firstAttempt = createWorkflowStageInboxDelivery(store, RUN_ID, "stage-id", "reviewer");
	await firstAttempt.drain((entryFrom, entryMessage) => {
		delivered.push({
			id: entryMessage.id,
			name: entryFrom.name,
			cwd: entryFrom.cwd,
			timestamp: entryMessage.timestamp,
		});
	});
	await firstAttempt.ready();
	assert.deepEqual(
		delivered.map((entry) => entry.id),
		["earlier", "later"],
	);
	assert.equal(delivered[0]?.name, "planner");
	assert.equal(delivered[0]?.cwd, "/repo");
	assert.equal(delivered[0]?.timestamp, 100);

	const restartedAttempt = createWorkflowStageInboxDelivery(store, RUN_ID, "stage-id", "reviewer");
	await restartedAttempt.drain((entryFrom, entryMessage) => {
		delivered.push({
			id: entryMessage.id,
			name: entryFrom.name,
			cwd: entryFrom.cwd,
			timestamp: entryMessage.timestamp,
		});
	});
	assert.equal(delivered.length, 2);
	assert.deepEqual(
		backend.getWorkflow(RUN_ID)?.stageInbox?.map(({ status }) => status),
		["delivered", "delivered"],
	);
});
