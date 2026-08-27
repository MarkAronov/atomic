import type { CreateAgentSessionOptions } from "@bastani/atomic";

type WorkflowPendingStageDelivery = NonNullable<
	NonNullable<CreateAgentSessionOptions["orchestrationContext"]>["pendingStageDelivery"]
>;
type WorkflowPendingStageDeliver = Parameters<WorkflowPendingStageDelivery["deliverPending"]>[0];
type WorkflowPendingStageSender = Parameters<WorkflowPendingStageDeliver>[0];
type WorkflowPendingStageMessage = Parameters<WorkflowPendingStageDeliver>[1];

import { getDurableBackend } from "../../durable/factory.js";
import type { Store } from "../../shared/store.js";
import type { PendingStageMessage } from "../../shared/store-types.js";

const pendingDeliveryClaims = new WeakMap<Store, Set<string>>();

export function createWorkflowPendingStageDelivery(
	activeStore: Store,
	runId: string,
	stageId: string,
	stageName: string,
): WorkflowPendingStageDelivery {
	let resolveReady!: () => void;
	let rejectReady!: (error: Error) => void;
	const readyPromise = new Promise<void>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	let drainPromise: Promise<void> | undefined;
	return {
		deliverPending(deliver) {
			drainPromise ??= deliverPendingStageMessages(activeStore, runId, stageId, stageName, deliver).then(
				() => resolveReady(),
				(error: Error) => {
					rejectReady(error);
					throw error;
				},
			);
			return drainPromise;
		},
		ready() {
			if (
				activeStore.pendingStageMessagesFor(runId, stageId).length === 0 &&
				(stageId === stageName || activeStore.pendingStageMessagesFor(runId, stageName).length === 0)
			) {
				return undefined;
			}
			return readyPromise;
		},
	};
}

async function deliverPendingStageMessages(
	activeStore: Store,
	runId: string,
	stageId: string,
	stageName: string,
	deliver: (from: WorkflowPendingStageSender, message: WorkflowPendingStageMessage) => void | Promise<void>,
): Promise<void> {
	const stageKeys = stageId === stageName ? [stageId] : [stageId, stageName];
	const order = new Map<string, number>();
	const entries = stageKeys
		.flatMap((stageKey) => activeStore.pendingStageMessagesFor(runId, stageKey))
		.filter((entry, index, all) => all.findIndex((candidate) => candidate.id === entry.id) === index)
		.map((entry, index) => {
			order.set(entry.id, index);
			return entry;
		})
		.sort(
			(left, right) =>
				left.queuedAt.localeCompare(right.queuedAt) || (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0),
		);
	const backend = getDurableBackend();
	for (const entry of entries) {
		const releaseClaim = claimPendingDelivery(activeStore, runId, entry.stageKey, entry.id);
		if (releaseClaim === undefined) continue;
		try {
			await deliver(toPendingStageSender(entry), entry.message);
			if (
				!(await activeStore.markPendingStageMessageDelivered(
					runId,
					entry.stageKey,
					entry.id,
					new Date().toISOString(),
					backend,
				))
			) {
				throw new Error(`atomic-workflows: pending-stage message ${entry.id} changed during delivery`);
			}
		} finally {
			releaseClaim();
		}
	}
}

function claimPendingDelivery(
	store: Store,
	runId: string,
	stageKey: string,
	messageId: string,
): (() => void) | undefined {
	let claims = pendingDeliveryClaims.get(store);
	if (claims === undefined) {
		claims = new Set();
		pendingDeliveryClaims.set(store, claims);
	}
	const key = JSON.stringify([runId, stageKey, messageId]);
	if (claims.has(key)) return undefined;
	claims.add(key);
	return () => {
		claims?.delete(key);
		if (claims?.size === 0) pendingDeliveryClaims.delete(store);
	};
}

function toPendingStageSender(entry: PendingStageMessage): WorkflowPendingStageSender {
	return {
		...entry.from,
		cwd: entry.from.cwd ?? "",
		model: entry.from.model ?? "unknown",
		pid: entry.from.pid ?? 0,
		startedAt: entry.from.startedAt ?? entry.message.timestamp,
		lastActivity: entry.from.lastActivity ?? entry.message.timestamp,
	};
}
