import type { DurableWorkflowBackend } from "../durable/backend.js";
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
	const transitions = new Map<string, Promise<void>>();
	const serialize = async <T>(runId: string, transition: () => Promise<T>): Promise<T> => {
		const previous = transitions.get(runId) ?? Promise.resolve();
		const result = previous.catch(() => undefined).then(transition);
		const settled = result.then(
			() => undefined,
			() => undefined,
		);
		transitions.set(runId, settled);
		settled.finally(() => {
			if (transitions.get(runId) === settled) transitions.delete(runId);
		});
		return await result;
	};

	return {
		async queueStageMessage(
			input: PendingStageMessageInput,
			senderGroup: string | undefined,
			runGroup: string | undefined,
			backend: DurableWorkflowBackend,
		): Promise<PendingStageQueueResult | undefined> {
			return await serialize(input.runId, async () => {
				const run = context.findRun(input.runId);
				if (run === undefined) return undefined;
				const result = queueStageMessage(run.pendingStageMessages ?? [], input, senderGroup, runGroup);
				if (result.ok && !result.deduplicated) {
					await persistTransition(backend, input.runId, result.messages);
					run.pendingStageMessages = [...result.messages];
					context.bumpAndNotify();
				}
				return result;
			});
		},

		pendingStageMessagesFor(runId: string, stageKey: string): readonly PendingStageMessage[] {
			const run = context.findRun(runId);
			return pendingStageMessagesFor(run?.pendingStageMessages ?? [], runId, stageKey);
		},

		async markPendingStageMessageDelivered(
			runId: string,
			stageKey: string,
			messageId: string,
			deliveredAt: string,
			backend: DurableWorkflowBackend,
		): Promise<boolean> {
			return await serialize(runId, async () => {
				const run = context.findRun(runId);
				if (run === undefined) return false;
				const current = run.pendingStageMessages ?? [];
				const next = markPendingStageMessageDelivered(current, runId, stageKey, messageId, deliveredAt);
				if (next === current) return false;
				await persistTransition(backend, runId, next);
				run.pendingStageMessages = [...next];
				context.bumpAndNotify();
				return true;
			});
		},

		async markPendingStageMessageUndeliverable(
			runId: string,
			stageKey: string,
			messageId: string,
			reason: string,
			backend: DurableWorkflowBackend,
		): Promise<boolean> {
			return await serialize(runId, async () => {
				const run = context.findRun(runId);
				if (run === undefined) return false;
				const current = run.pendingStageMessages ?? [];
				const next = markPendingStageMessageUndeliverable(current, runId, stageKey, messageId, reason);
				if (next === current) return false;
				await persistTransition(backend, runId, next);
				run.pendingStageMessages = [...next];
				context.bumpAndNotify();
				return true;
			});
		},
	};
}

async function persistTransition(
	backend: DurableWorkflowBackend,
	runId: string,
	messages: readonly PendingStageMessage[],
): Promise<void> {
	if (!(await backend.persistPendingStageMessages(runId, messages))) {
		throw new Error(`atomic-workflows: durable workflow ${runId} is unavailable for pending-stage persistence`);
	}
}
