import assert from "node:assert/strict";
import type net from "node:net";
import { afterEach, describe, test } from "vitest";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import { type BrokerConnectedSession, handleBrokerSend } from "../../packages/intercom/broker/send-handler.js";
import type { BrokerMessage, Message, SessionInfo } from "../../packages/intercom/types.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { settleUndeliverablePendingStageMessages } from "../../packages/workflows/src/extension/pending-stage-intercom.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type {
	PendingStageMessageInput,
	RunStatus,
	StageStatus,
} from "../../packages/workflows/src/shared/store-types.js";
import { testRunId } from "../helpers/run-id.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

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

async function lifecycleFixture(runStatus: RunStatus, stageStatus: StageStatus = "pending") {
	const activeStore = createStore();
	const backend = new InMemoryDurableBackend();
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
	backend.registerWorkflow({ workflowId: runId, name: "flow", inputs: {}, status: "running", createdAt: 1 });
	setDurableBackend(backend);
	const accepted = await activeStore.queueStageMessage(
		pendingMessage(runId, "review-stage"),
		`workflow:${runId}`,
		`workflow:${runId}`,
		backend,
	);
	assert.equal(accepted?.ok, true);
	return { activeStore, backend, runId };
}

afterEach(() => setDurableBackend(undefined));

describe("pending workflow stage delivery lifecycle", () => {
	test("marks a skipped stage message undeliverable and notifies its sender", async () => {
		const { activeStore } = await lifecycleFixture("running", "skipped");
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
		const { activeStore } = await lifecycleFixture("cancelled", "skipped");
		const reasons: string[] = [];
		await settleUndeliverablePendingStageMessages(activeStore, async (_entry, reason) => {
			reasons.push(reason);
			return true;
		});
		assert.equal(activeStore.runs()[0]?.pendingStageMessages?.[0]?.status, "undeliverable");
		assert.match(reasons[0] ?? "", /terminated with status cancelled/);
	});

	test("settles a known pending stage when its run completes before initialization", async () => {
		const { activeStore } = await lifecycleFixture("completed");
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
			const { activeStore } = await lifecycleFixture("running", status);
			assert.equal(await settleUndeliverablePendingStageMessages(activeStore, async () => true), 0);
			assert.equal(activeStore.runs()[0]?.pendingStageMessages?.[0]?.status, "queued");
		}
	});
});

test("a crash after sender-visible failure notification reloads to exactly one notification and terminal state", async () => {
	const runId = testRunId("pending-delivery-notification-crash");
	const group = `workflow:${runId}`;
	const persistedSdk = createMockSdk();
	let failNextMetadataWrite = false;
	const sdk = {
		...persistedSdk,
		async recordStepOutput(...args: Parameters<typeof persistedSdk.recordStepOutput>) {
			if (failNextMetadataWrite) {
				failNextMetadataWrite = false;
				throw new Error("simulated process exit after notification");
			}
			await persistedSdk.recordStepOutput(...args);
		},
	};
	const writer = new DbosDurableBackend(sdk, { executorId: "notification-writer" });
	writer.registerWorkflow({ workflowId: runId, name: "flow", inputs: {}, status: "running", createdAt: 1 });
	await writer.flush();
	setDurableBackend(writer);
	const activeStore = createStore();
	activeStore.recordRunStart({ id: runId, name: "flow", inputs: {}, status: "running", stages: [], startedAt: 1 });
	activeStore.recordStageStart(runId, {
		id: "review-stage",
		name: "reviewer",
		status: "skipped",
		parentIds: [],
		toolEvents: [],
		skippedReason: "fail-fast",
	});
	await activeStore.queueStageMessage(pendingMessage(runId, "review-stage"), group, group, writer);

	const workflowSocket = {} as net.Socket;
	const senderSocket = {} as net.Socket;
	const sessionInfo = (id: string, name: string): SessionInfo => ({
		id,
		name,
		group,
		cwd: "/repo",
		model: "test",
		pid: 1,
		startedAt: 1,
		lastActivity: 1,
	});
	const sessions = new Map<string, BrokerConnectedSession>([
		["workflow-owner", { socket: workflowSocket, info: sessionInfo("workflow-owner", "workflow-owner") }],
		["planner-session", { socket: senderSocket, info: sessionInfo("planner-session", "planner") }],
	]);
	const deliveredMessages = new DeliveredMessageCache();
	const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];
	const notifyThroughBroker = async (
		entry: Parameters<typeof settleUndeliverablePendingStageMessages>[1] extends (
			entry: infer Entry,
			...args: never[]
		) => unknown
			? Entry
			: never,
		reason: string,
		notificationId: string,
	): Promise<boolean> => {
		const actionable = `Pending workflow stage could not receive intercom message: ${reason}`;
		const message: Message = {
			id: notificationId,
			timestamp: Date.now(),
			replyTo: entry.message.id,
			replyError: actionable,
			content: { text: actionable },
		};
		handleBrokerSend(
			workflowSocket,
			{ type: "send", to: entry.from.id, message },
			"workflow-owner",
			sessions,
			deliveredMessages,
			(socket, brokerMessage) => writes.push({ socket, message: brokerMessage }),
		);
		return writes.some(
			(write) =>
				write.socket === workflowSocket &&
				write.message.type === "delivered" &&
				write.message.messageId === notificationId,
		);
	};

	await assert.rejects(
		settleUndeliverablePendingStageMessages(activeStore, async (entry, reason, notificationId) => {
			const delivered = await notifyThroughBroker(entry, reason, notificationId);
			failNextMetadataWrite = true;
			return delivered;
		}),
		/simulated process exit after notification/,
	);
	assert.equal(writes.filter((write) => write.socket === senderSocket && write.message.type === "message").length, 1);

	const reader = new DbosDurableBackend(sdk, { executorId: "notification-reader" });
	await reader.hydrateWorkflow(runId);
	const pendingNotification = reader.getWorkflow(runId)?.pendingStageMessages?.[0];
	assert.equal(pendingNotification?.status, "undeliverable");
	assert.equal(
		typeof (pendingNotification as { undeliverableNotificationId?: string })?.undeliverableNotificationId,
		"string",
	);
	assert.equal((pendingNotification as { undeliverableNotifiedAt?: string })?.undeliverableNotifiedAt, undefined);
	const reloadedStore = createStore();
	reloadedStore.recordRunStart({
		id: runId,
		name: "flow",
		inputs: {},
		status: "running",
		stages: [
			{
				id: "review-stage",
				name: "reviewer",
				status: "skipped",
				parentIds: [],
				toolEvents: [],
				skippedReason: "fail-fast",
			},
		],
		startedAt: 1,
		pendingStageMessages: [...(reader.getWorkflow(runId)?.pendingStageMessages ?? [])],
	});
	setDurableBackend(reader);
	assert.equal(await settleUndeliverablePendingStageMessages(reloadedStore, notifyThroughBroker), 0);
	assert.equal(writes.filter((write) => write.socket === senderSocket && write.message.type === "message").length, 1);
	const terminal = new DbosDurableBackend(sdk, { executorId: "notification-terminal-reader" });
	await terminal.hydrateWorkflow(runId);
	const terminalEntry = terminal.getWorkflow(runId)?.pendingStageMessages?.[0];
	assert.equal(terminalEntry?.status, "undeliverable");
	assert.equal(typeof (terminalEntry as { undeliverableNotifiedAt?: string })?.undeliverableNotifiedAt, "string");
});
