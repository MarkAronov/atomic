import type { StageInboxDeposit, StageInboxDepositResult, StageInboxEntry } from "./store-types.js";

export type {
	StageInboxDeposit,
	StageInboxDepositResult,
	StageInboxEntry,
	StageInboxSender,
} from "./store-types.js";

/** Maximum queued messages retained for one exact workflow run/stage key. */
export const STAGE_INBOX_MAX_ENTRIES = 50;

/**
 * Add one queued entry without mutating the supplied collection.
 *
 * Group comparison deliberately mirrors intercom's `normalizeGroup` semantics
 * locally. The workflows durable-state layer must remain independent of the
 * detached broker package, while undefined/empty/whitespace groups still map
 * to the same implicit `default` group.
 */
export function depositStageInboxEntry(
	inbox: readonly StageInboxEntry[],
	deposit: StageInboxDeposit,
	depositingGroup: string | undefined,
	runGroup: string | undefined,
): StageInboxDepositResult {
	if (normalizeInboxGroup(depositingGroup) !== normalizeInboxGroup(runGroup)) {
		return { ok: false, reason: "group_mismatch", runId: deposit.runId, stageKey: deposit.stageKey };
	}

	const messageId = deposit.message.id;
	const bucket = inbox.filter((entry) => matchesStageInbox(entry, deposit.runId, deposit.stageKey));
	const existing = bucket.find((entry) => entry.id === messageId);
	if (existing !== undefined) {
		return {
			ok: true,
			inbox,
			entry: existing,
			position: bucket.indexOf(existing) + 1,
			deduplicated: true,
		};
	}

	if (bucket.filter((entry) => entry.status === "queued").length >= STAGE_INBOX_MAX_ENTRIES) {
		return {
			ok: false,
			reason: "capacity",
			limit: STAGE_INBOX_MAX_ENTRIES,
			runId: deposit.runId,
			stageKey: deposit.stageKey,
		};
	}

	const entry: StageInboxEntry = { ...deposit, id: messageId, status: "queued" };
	return {
		ok: true,
		inbox: [...inbox, entry],
		entry,
		position: bucket.length + 1,
		deduplicated: false,
	};
}

/** Read queued entries for one exact key in insertion (FIFO) order. */
export function peekStageInbox(
	inbox: readonly StageInboxEntry[],
	runId: string,
	stageKey: string,
): readonly StageInboxEntry[] {
	return inbox.filter((entry) => matchesStageInbox(entry, runId, stageKey) && entry.status === "queued");
}

export function queuedStageInboxCount(inbox: readonly StageInboxEntry[], runId: string, stageKey: string): number {
	return peekStageInbox(inbox, runId, stageKey).length;
}

export function markStageInboxEntryDelivered(
	inbox: readonly StageInboxEntry[],
	runId: string,
	stageKey: string,
	messageId: string,
	deliveredAt: string,
): readonly StageInboxEntry[] {
	return updateQueuedStageInboxEntry(inbox, runId, stageKey, messageId, (entry) => ({
		...entry,
		status: "delivered",
		deliveredAt,
	}));
}

export function markStageInboxEntryUndeliverable(
	inbox: readonly StageInboxEntry[],
	runId: string,
	stageKey: string,
	messageId: string,
	reason: string,
): readonly StageInboxEntry[] {
	return updateQueuedStageInboxEntry(inbox, runId, stageKey, messageId, (entry) => ({
		...entry,
		status: "undeliverable",
		undeliverableReason: reason,
	}));
}

function updateQueuedStageInboxEntry(
	inbox: readonly StageInboxEntry[],
	runId: string,
	stageKey: string,
	messageId: string,
	update: (entry: StageInboxEntry) => StageInboxEntry,
): readonly StageInboxEntry[] {
	const index = inbox.findIndex(
		(entry) => matchesStageInbox(entry, runId, stageKey) && entry.id === messageId && entry.status === "queued",
	);
	if (index < 0) return inbox;
	const next = [...inbox];
	next[index] = update(next[index]!);
	return next;
}

function matchesStageInbox(entry: StageInboxEntry, runId: string, stageKey: string): boolean {
	return entry.runId === runId && entry.stageKey === stageKey;
}

function normalizeInboxGroup(value?: string | null): string {
	if (typeof value !== "string") return "default";
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : "default";
}
