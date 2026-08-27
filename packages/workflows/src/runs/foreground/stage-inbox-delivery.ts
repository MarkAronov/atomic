import type { CreateAgentSessionOptions } from "@bastani/atomic";

type WorkflowStageInboxDelivery = NonNullable<
	NonNullable<CreateAgentSessionOptions["orchestrationContext"]>["stageInbox"]
>;
type WorkflowStageInboxDeliver = Parameters<WorkflowStageInboxDelivery["drain"]>[0];
type WorkflowStageInboxSender = Parameters<WorkflowStageInboxDeliver>[0];
type WorkflowStageInboxMessage = Parameters<WorkflowStageInboxDeliver>[1];

import { getDurableBackend } from "../../durable/factory.js";
import type { Store } from "../../shared/store.js";
import type { StageInboxEntry } from "../../shared/store-types.js";

export function createWorkflowStageInboxDelivery(
	activeStore: Store,
	runId: string,
	stageId: string,
	stageName: string,
): WorkflowStageInboxDelivery {
	let resolveReady!: () => void;
	let rejectReady!: (error: Error) => void;
	const readyPromise = new Promise<void>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	let drainPromise: Promise<void> | undefined;
	return {
		drain(deliver) {
			drainPromise ??= drainWorkflowStageInbox(activeStore, runId, stageId, stageName, deliver).then(
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
				activeStore.peekStageInbox(runId, stageId).length === 0 &&
				(stageId === stageName || activeStore.peekStageInbox(runId, stageName).length === 0)
			) {
				return undefined;
			}
			return readyPromise;
		},
	};
}

async function drainWorkflowStageInbox(
	activeStore: Store,
	runId: string,
	stageId: string,
	stageName: string,
	deliver: (from: WorkflowStageInboxSender, message: WorkflowStageInboxMessage) => void | Promise<void>,
): Promise<void> {
	const stageKeys = stageId === stageName ? [stageId] : [stageId, stageName];
	const order = new Map<string, number>();
	const entries = stageKeys
		.flatMap((stageKey) => activeStore.peekStageInbox(runId, stageKey))
		.filter((entry, index, all) => all.findIndex((candidate) => candidate.id === entry.id) === index)
		.map((entry, index) => {
			order.set(entry.id, index);
			return entry;
		})
		.sort(
			(left, right) =>
				left.depositedAt.localeCompare(right.depositedAt) || (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0),
		);
	for (const entry of entries) {
		if (!activeStore.markStageInboxEntryDelivered(runId, entry.stageKey, entry.id, new Date().toISOString()))
			continue;
		await persistStageInbox(activeStore, runId);
		await deliver(toInboxSender(entry), entry.message);
	}
}

async function persistStageInbox(activeStore: Store, runId: string): Promise<void> {
	const backend = getDurableBackend();
	const handle = backend.getWorkflow(runId);
	const run = activeStore.runs().find((candidate) => candidate.id === runId);
	if (handle === undefined || run === undefined) return;
	backend.registerWorkflow({ ...handle, stageInbox: run.stageInbox ?? [] });
	await backend.flush();
}

function toInboxSender(entry: StageInboxEntry): WorkflowStageInboxSender {
	return {
		...entry.from,
		cwd: entry.from.cwd ?? "",
		model: entry.from.model ?? "unknown",
		pid: entry.from.pid ?? 0,
		startedAt: entry.from.startedAt ?? entry.message.timestamp,
		lastActivity: entry.from.lastActivity ?? entry.message.timestamp,
	};
}
