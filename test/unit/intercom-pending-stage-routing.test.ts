import assert from "node:assert/strict";
import type net from "node:net";
import { afterEach, describe, test } from "vitest";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import {
	type BrokerConnectedSession,
	handleBrokerSend,
	PENDING_STAGE_ASK_REFUSAL,
	pendingStageAskRefusal,
} from "../../packages/intercom/broker/send-handler.js";
import type { BrokerMessage, Message, SessionInfo } from "../../packages/intercom/types.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { registerPendingStageIntercomBridge } from "../../packages/workflows/src/extension/pending-stage-intercom.js";
import { createWorkflowPendingStageDelivery } from "../../packages/workflows/src/runs/foreground/pending-stage-delivery.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

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

test("pending-stage fallback runs only for a valid composite unknown target and preserves ordinary unknown failures", () => {
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

test("live workflow stage targets still deliver immediately before pending-stage fallback", () => {
	const senderSocket = {} as net.Socket;
	const targetSocket = {} as net.Socket;
	const sessions = new Map<string, BrokerConnectedSession>([
		["sender-id", sender(senderSocket)],
		[
			TARGET,
			{
				socket: targetSocket,
				info: { ...sender(targetSocket).info, id: TARGET, name: "reviewer" },
			},
		],
	]);
	const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];
	let deferredRouteCalled = false;
	handleBrokerSend(
		senderSocket,
		{ type: "send", to: TARGET, message: message("live") },
		"sender-id",
		sessions,
		new DeliveredMessageCache(),
		(socket, value) => writes.push({ socket, message: value }),
		undefined,
		undefined,
		() => {
			deferredRouteCalled = true;
			return true;
		},
	);
	assert.equal(deferredRouteCalled, false);
	assert.deepEqual(writes, [
		{ socket: targetSocket, message: { type: "message", from: sender(senderSocket).info, message: message("live") } },
		{ socket: senderSocket, message: { type: "delivered", messageId: "live", attemptId: undefined } },
	]);
});

test("pending-stage asks are refused with a send recommendation before request routing", () => {
	assert.equal(pendingStageAskRefusal({ ...message("ask"), expectsReply: true }), PENDING_STAGE_ASK_REFUSAL);
	assert.equal(pendingStageAskRefusal(message("send")), undefined);
	assert.equal(PENDING_STAGE_ASK_REFUSAL.includes("Use send"), true);
});

describe("workflows-owned pending-stage delivery event bridge", () => {
	function harness() {
		const store = createStore();
		store.recordRunStart({
			id: RUN_ID,
			name: "flow",
			inputs: {},
			status: "running",
			stages: [{ id: "reviewer-id", name: "reviewer", status: "pending", parentIds: [], toolEvents: [] }],
			startedAt: 1,
		});
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
		const dispose = registerPendingStageIntercomBridge(pi, store);
		const request = async (id: string, group = GROUP, stageKey = "reviewer") => {
			const payload: {
				handled: boolean;
				completion?: Promise<
					| { readonly outcome: "queued"; readonly position: number }
					| { readonly outcome: "refused"; readonly reason: string }
				>;
				requestId: string;
				from: SessionInfo;
				runId: string;
				stageKey: string;
				message: Message;
			} = {
				handled: false,
				requestId: `request-${id}`,
				from: { ...sender({} as net.Socket).info, group },
				runId: RUN_ID,
				stageKey,
				message: message(id, 1_725_000_000_000 + Number(id)),
			};
			listeners.get("atomic:workflow-pending-stage-message")?.(payload);
			return { payload, result: payload.completion === undefined ? undefined : await payload.completion };
		};
		return { store, backend, emitted, request, dispose };
	}

	test("announces ownership and enforces group isolation without requesting", async () => {
		const { store, emitted, request, dispose } = harness();
		assert.equal(
			emitted.some(({ event }) => event === "atomic:workflow-pending-stage-route"),
			true,
		);
		const { payload, result } = await request("1", "other-group");
		assert.equal(payload.handled, true);
		assert.deepEqual(result, {
			outcome: "refused",
			reason: "Target workflow run is in a different intercom group",
		});
		assert.equal(store.pendingStageMessagesFor(RUN_ID, "reviewer").length, 0);
		dispose();
	});

	test("surfaces the exact 50-message cap boundary through the request event", async () => {
		const { store, backend, request, dispose } = harness();
		for (let index = 1; index <= 50; index += 1) {
			assert.deepEqual((await request(String(index))).result, { outcome: "queued", position: index });
		}
		assert.deepEqual((await request("51")).result, {
			outcome: "refused",
			reason: `Pending stage message queue is full (limit 50) for ${RUN_ID}:reviewer`,
		});
		assert.equal(store.pendingStageMessagesFor(RUN_ID, "reviewer").length, 50);
		assert.equal(backend.getWorkflow(RUN_ID)?.pendingStageMessages?.length, 50);
		dispose();
	});

	test("refuses an unknown stage key under a known run without queueing", async () => {
		const { store, request, dispose } = harness();
		const { payload, result } = await request("1", GROUP, "unknown-stage");
		assert.equal(payload.handled, false);
		assert.equal(result, undefined);
		assert.deepEqual(store.pendingStageMessagesFor(RUN_ID, "unknown-stage"), []);
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
	await store.queueStageMessage(
		{ runId: RUN_ID, stageKey: "reviewer", from, message: message("later", 200), queuedAt: "2026-01-02" },
		GROUP,
		GROUP,
		backend,
	);
	await store.queueStageMessage(
		{ runId: RUN_ID, stageKey: "stage-id", from, message: message("earlier", 100), queuedAt: "2026-01-01" },
		GROUP,
		GROUP,
		backend,
	);
	const delivered: Array<{ id: string; name?: string; cwd: string; timestamp: number }> = [];
	const firstAttempt = createWorkflowPendingStageDelivery(store, RUN_ID, "stage-id", "reviewer");
	await firstAttempt.deliverPending((entryFrom, entryMessage) => {
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

	const restartedAttempt = createWorkflowPendingStageDelivery(store, RUN_ID, "stage-id", "reviewer");
	await restartedAttempt.deliverPending((entryFrom, entryMessage) => {
		delivered.push({
			id: entryMessage.id,
			name: entryFrom.name,
			cwd: entryFrom.cwd,
			timestamp: entryMessage.timestamp,
		});
	});
	assert.equal(delivered.length, 2);
	assert.deepEqual(
		backend.getWorkflow(RUN_ID)?.pendingStageMessages?.map(({ status }) => status),
		["delivered", "delivered"],
	);
});

test("concurrent stage drains claim one queued message exactly once", async () => {
	const store = createStore();
	const backend = new InMemoryDurableBackend();
	backend.registerWorkflow({ workflowId: RUN_ID, name: "flow", inputs: {}, status: "running", createdAt: 1 });
	setDurableBackend(backend);
	store.recordRunStart({ id: RUN_ID, name: "flow", inputs: {}, status: "running", stages: [], startedAt: 1 });
	await store.queueStageMessage(
		{
			runId: RUN_ID,
			stageKey: "reviewer",
			from: sender({} as net.Socket).info,
			message: message("concurrent-drain"),
			queuedAt: "2026-08-27T12:00:00.000Z",
		},
		GROUP,
		GROUP,
		backend,
	);
	const deliveryStarted = Promise.withResolvers<void>();
	const releaseDelivery = Promise.withResolvers<void>();
	let deliveries = 0;
	const first = createWorkflowPendingStageDelivery(store, RUN_ID, "reviewer-id", "reviewer").deliverPending(
		async () => {
			deliveries++;
			deliveryStarted.resolve();
			await releaseDelivery.promise;
		},
	);
	await deliveryStarted.promise;
	await createWorkflowPendingStageDelivery(store, RUN_ID, "reviewer-id", "reviewer").deliverPending(async () => {
		deliveries++;
	});
	assert.equal(deliveries, 1);
	releaseDelivery.resolve();
	await first;
	assert.equal(backend.getWorkflow(RUN_ID)?.pendingStageMessages?.[0]?.status, "delivered");
});

test("rejected inbound delivery remains queued and retries after durable reload", async () => {
	const sdk = createMockSdk();
	const writer = new DbosDurableBackend(sdk, { executorId: "pending-delivery-writer" });
	writer.registerWorkflow({ workflowId: RUN_ID, name: "flow", inputs: {}, status: "running", createdAt: 1 });
	await writer.flush();
	setDurableBackend(writer);
	const store = createStore();
	store.recordRunStart({ id: RUN_ID, name: "flow", inputs: {}, status: "running", stages: [], startedAt: 1 });
	await store.queueStageMessage(
		{
			runId: RUN_ID,
			stageKey: "reviewer",
			from: sender({} as net.Socket).info,
			message: message("retry-after-rejection"),
			queuedAt: "2026-08-27T12:00:00.000Z",
		},
		GROUP,
		GROUP,
		writer,
	);

	const firstAttempt = createWorkflowPendingStageDelivery(store, RUN_ID, "reviewer-id", "reviewer");
	const ready = firstAttempt.ready();
	assert.ok(ready !== undefined);
	await assert.rejects(
		Promise.all([
			firstAttempt.deliverPending(async () => {
				throw new Error("inbound admission rejected");
			}),
			ready,
		]),
		/inbound admission rejected/,
	);

	const fresh = new DbosDurableBackend(sdk, { executorId: "pending-delivery-reader" });
	await fresh.hydrateWorkflow(RUN_ID);
	assert.equal(fresh.getWorkflow(RUN_ID)?.pendingStageMessages?.[0]?.status, "queued");
	const reloadedStore = createStore();
	reloadedStore.recordRunStart({
		id: RUN_ID,
		name: "flow",
		inputs: {},
		status: "running",
		stages: [],
		startedAt: 1,
		pendingStageMessages: [...(fresh.getWorkflow(RUN_ID)?.pendingStageMessages ?? [])],
	});
	setDurableBackend(fresh);
	let retries = 0;
	await createWorkflowPendingStageDelivery(reloadedStore, RUN_ID, "reviewer-id", "reviewer").deliverPending(
		async () => {
			retries++;
		},
	);
	assert.equal(retries, 1);
	assert.equal(fresh.getWorkflow(RUN_ID)?.pendingStageMessages?.[0]?.status, "delivered");
});
