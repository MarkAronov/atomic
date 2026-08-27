import type { PendingStageMessage, PendingStageMessageInput, PendingStageQueueResult } from "./store-types.js";

export type {
	PendingStageMessage,
	PendingStageMessageInput,
	PendingStageQueueResult,
	PendingStageSender,
} from "./store-types.js";

/** Maximum queued messages retained for one canonical workflow stage. */
export const PENDING_STAGE_MESSAGE_LIMIT = 50;

export interface PendingStageIdentity {
	readonly id: string;
	readonly replayKey?: string;
	readonly aliases: readonly string[];
}

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
	stageIdentity?: PendingStageIdentity,
): PendingStageQueueResult {
	if (normalizeDeliveryGroup(senderGroup) !== normalizeDeliveryGroup(runGroup)) {
		return { ok: false, reason: "group_mismatch", runId: input.runId, stageKey: input.stageKey };
	}

	const messageId = input.message.id;
	const bucket = messages.filter((entry) => matchesPendingStage(entry, input.runId, input.stageKey, stageIdentity));
	const existing = bucket.find((entry) => entry.id === messageId);
	if (existing !== undefined) {
		if (
			pendingStageMessageSignature(existing, stageIdentity) !== pendingStageMessageSignature(input, stageIdentity)
		) {
			return {
				ok: false,
				reason: "message_id_conflict",
				runId: input.runId,
				stageKey: input.stageKey,
				messageId,
			};
		}
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

	const entry: PendingStageMessage = {
		...input,
		id: messageId,
		...(stageIdentity !== undefined ? { stageId: stageIdentity.id } : {}),
		...(stageIdentity?.replayKey !== undefined ? { stageReplayKey: stageIdentity.replayKey } : {}),
		admissionOrder: nextAdmissionOrder(messages, input.runId),
		status: "queued",
	};
	return {
		ok: true,
		messages: [...messages, entry],
		entry,
		position: bucket.length + 1,
		deduplicated: false,
	};
}

/** Read one canonical stage's queued entries in durable workflow admission order. */
export function pendingStageMessagesFor(
	messages: readonly PendingStageMessage[],
	runId: string,
	stageKey: string,
	stageIdentity?: PendingStageIdentity,
): readonly PendingStageMessage[] {
	return messages
		.map((entry, index) => ({ entry, index }))
		.filter(({ entry }) => matchesPendingStage(entry, runId, stageKey, stageIdentity) && entry.status === "queued")
		.sort(
			(left, right) =>
				(left.entry.admissionOrder ?? left.index + 1) - (right.entry.admissionOrder ?? right.index + 1) ||
				left.index - right.index,
		)
		.map(({ entry }) => entry);
}

export function queuedPendingStageMessageCount(
	messages: readonly PendingStageMessage[],
	runId: string,
	stageKey: string,
	stageIdentity?: PendingStageIdentity,
): number {
	return pendingStageMessagesFor(messages, runId, stageKey, stageIdentity).length;
}

export function markPendingStageMessageDelivered(
	messages: readonly PendingStageMessage[],
	runId: string,
	stageKey: string,
	messageId: string,
	deliveredAt: string,
	stageIdentity?: PendingStageIdentity,
): readonly PendingStageMessage[] {
	return updateQueuedPendingStageMessage(messages, runId, stageKey, messageId, stageIdentity, (entry) => ({
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
	stageIdentity?: PendingStageIdentity,
): readonly PendingStageMessage[] {
	return updateQueuedPendingStageMessage(messages, runId, stageKey, messageId, stageIdentity, (entry) => ({
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
	stageIdentity: PendingStageIdentity | undefined,
	update: (entry: PendingStageMessage) => PendingStageMessage,
): readonly PendingStageMessage[] {
	const index = messages.findIndex(
		(entry) =>
			matchesPendingStage(entry, runId, stageKey, stageIdentity) &&
			entry.id === messageId &&
			entry.status === "queued",
	);
	if (index < 0) return messages;
	const next = [...messages];
	next[index] = update(next[index]!);
	return next;
}

function matchesPendingStage(
	entry: PendingStageMessage,
	runId: string,
	stageKey: string,
	stageIdentity?: PendingStageIdentity,
): boolean {
	if (entry.runId !== runId) return false;
	if (stageIdentity === undefined) return entry.stageKey === stageKey;
	return (
		entry.stageId === stageIdentity.id ||
		(entry.stageReplayKey !== undefined && entry.stageReplayKey === stageIdentity.replayKey) ||
		(entry.stageId === undefined && stageIdentity.aliases.includes(entry.stageKey))
	);
}

function nextAdmissionOrder(messages: readonly PendingStageMessage[], runId: string): number {
	let greatest = 0;
	let legacyPosition = 0;
	for (const entry of messages) {
		if (entry.runId !== runId) continue;
		legacyPosition += 1;
		greatest = Math.max(greatest, entry.admissionOrder ?? legacyPosition);
	}
	return greatest + 1;
}

function pendingStageMessageSignature(
	entry: PendingStageMessage | PendingStageMessageInput,
	stageIdentity?: PendingStageIdentity,
): string {
	return stableJson({
		target: stageIdentity?.replayKey ?? stageIdentity?.id ?? entry.stageKey,
		from: entry.from,
		message: entry.message,
	});
}

function stableJson(value: unknown): string {
	return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJsonValue);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([, nested]) => nested !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, nested]) => [key, sortJsonValue(nested)]),
	);
}

function normalizeDeliveryGroup(value?: string | null): string {
	if (typeof value !== "string") return "default";
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : "default";
}
