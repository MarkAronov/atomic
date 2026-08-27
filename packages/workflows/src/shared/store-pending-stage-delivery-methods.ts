import {
	markPendingStageMessageDelivered,
	markPendingStageMessageUndeliverable,
	type PendingStageMessage,
	type PendingStageMessageInput,
	type PendingStageQueueResult,
	pendingStageMessagesFor,
	queueStageMessage,
} from "./pending-stage-delivery.js";
import type { StoreContext } from "./store-internal.js";
import type { Store } from "./store-public-types.js";

type PendingStageDeliveryStoreMethods = Pick<
	Store,
	| "queueStageMessage"
	| "pendingStageMessagesFor"
	| "markPendingStageMessageDelivered"
	| "markPendingStageMessageUndeliverable"
>;

export function createPendingStageDeliveryStoreMethods(context: StoreContext): PendingStageDeliveryStoreMethods {
	return {
		queueStageMessage(
			input: PendingStageMessageInput,
			senderGroup: string | undefined,
			runGroup: string | undefined,
		): PendingStageQueueResult | undefined {
			const run = context.findRun(input.runId);
			if (run === undefined) return undefined;
			const result = queueStageMessage(run.pendingStageMessages ?? [], input, senderGroup, runGroup);
			if (result.ok && !result.deduplicated) {
				run.pendingStageMessages = [...result.messages];
				context.bumpAndNotify();
			}
			return result;
		},

		pendingStageMessagesFor(runId: string, stageKey: string): readonly PendingStageMessage[] {
			const run = context.findRun(runId);
			return pendingStageMessagesFor(run?.pendingStageMessages ?? [], runId, stageKey);
		},

		markPendingStageMessageDelivered(
			runId: string,
			stageKey: string,
			messageId: string,
			deliveredAt: string,
		): boolean {
			const run = context.findRun(runId);
			if (run === undefined) return false;
			const current = run.pendingStageMessages ?? [];
			const next = markPendingStageMessageDelivered(current, runId, stageKey, messageId, deliveredAt);
			if (next === current) return false;
			run.pendingStageMessages = [...next];
			context.bumpAndNotify();
			return true;
		},

		markPendingStageMessageUndeliverable(
			runId: string,
			stageKey: string,
			messageId: string,
			reason: string,
		): boolean {
			const run = context.findRun(runId);
			if (run === undefined) return false;
			const current = run.pendingStageMessages ?? [];
			const next = markPendingStageMessageUndeliverable(current, runId, stageKey, messageId, reason);
			if (next === current) return false;
			run.pendingStageMessages = [...next];
			context.bumpAndNotify();
			return true;
		},
	};
}
