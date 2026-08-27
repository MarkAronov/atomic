import type { PendingStageMessage, PendingStageMessageInput, PendingStageQueueResult } from "./store-types.js";

export type {
	PendingStageMessage,
	PendingStageMessageInput,
	PendingStageQueueResult,
	PendingStageSender,
} from "./store-types.js";

/** Maximum queued messages retained for one exact workflow run/stage key. */
export const PENDING_STAGE_MESSAGE_LIMIT = 50;

/**
 * Add one queued entry without mutating the supplied collection.
 *
 * Group comparison deliberately mirrors intercom's `normalizeGroup` semantics
 * locally. The workflows durable-state layer must remain independent of the
 * detached broker package, while undefined/empty/whitespace groups still map
 * to the same implicit `default` group.
 */
export function queueStageMessage(
	messages: readonly PendingStageMessage[],
	input: PendingStageMessageInput,
	senderGroup: string | undefined,
	runGroup: string | undefined,
): PendingStageQueueResult {
	if (normalizeDeliveryGroup(senderGroup) !== normalizeDeliveryGroup(runGroup)) {
		return { ok: false, reason: "group_mismatch", runId: input.runId, stageKey: input.stageKey };
	}

	const messageId = input.message.id;
	const bucket = messages.filter((entry) => matchesPendingStage(entry, input.runId, input.stageKey));
	const existing = bucket.find((entry) => entry.id === messageId);
	if (existing !== undefined) {
		return {
			ok: true,
			messages,
			entry: existing,
			position: bucket.indexOf(existing) + 1,
			deduplicated: true,
		};
	}

	if (bucket.filter((entry) => entry.status === "queued").length >= PENDING_STAGE_MESSAGE_LIMIT) {
		return {
			ok: false,
			reason: "capacity",
			limit: PENDING_STAGE_MESSAGE_LIMIT,
			runId: input.runId,
			stageKey: input.stageKey,
		};
	}

	const entry: PendingStageMessage = { ...input, id: messageId, status: "queued" };
	return {
		ok: true,
		messages: [...messages, entry],
		entry,
		position: bucket.length + 1,
		deduplicated: false,
	};
}

/** Read queued entries for one exact key in insertion (FIFO) order. */
export function pendingStageMessagesFor(
	messages: readonly PendingStageMessage[],
	runId: string,
	stageKey: string,
): readonly PendingStageMessage[] {
	return messages.filter((entry) => matchesPendingStage(entry, runId, stageKey) && entry.status === "queued");
}

export function queuedPendingStageMessageCount(
	messages: readonly PendingStageMessage[],
	runId: string,
	stageKey: string,
): number {
	return pendingStageMessagesFor(messages, runId, stageKey).length;
}

export function markPendingStageMessageDelivered(
	messages: readonly PendingStageMessage[],
	runId: string,
	stageKey: string,
	messageId: string,
	deliveredAt: string,
): readonly PendingStageMessage[] {
	return updateQueuedPendingStageMessage(messages, runId, stageKey, messageId, (entry) => ({
		...entry,
		status: "delivered",
		deliveredAt,
	}));
}

export function markPendingStageMessageUndeliverable(
	messages: readonly PendingStageMessage[],
	runId: string,
	stageKey: string,
	messageId: string,
	reason: string,
): readonly PendingStageMessage[] {
	return updateQueuedPendingStageMessage(messages, runId, stageKey, messageId, (entry) => ({
		...entry,
		status: "undeliverable",
		undeliverableReason: reason,
	}));
}

function updateQueuedPendingStageMessage(
	messages: readonly PendingStageMessage[],
	runId: string,
	stageKey: string,
	messageId: string,
	update: (entry: PendingStageMessage) => PendingStageMessage,
): readonly PendingStageMessage[] {
	const index = messages.findIndex(
		(entry) => matchesPendingStage(entry, runId, stageKey) && entry.id === messageId && entry.status === "queued",
	);
	if (index < 0) return messages;
	const next = [...messages];
	next[index] = update(next[index]!);
	return next;
}

function matchesPendingStage(entry: PendingStageMessage, runId: string, stageKey: string): boolean {
	return entry.runId === runId && entry.stageKey === stageKey;
}

function normalizeDeliveryGroup(value?: string | null): string {
	if (typeof value !== "string") return "default";
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : "default";
}
