import { getDurableBackend } from "../durable/factory.js";
import { workflowInvocationIntercomGroup } from "../shared/intercom-group.js";
import type { Store } from "../shared/store.js";
import type { StageInboxDeposit, StageInboxDepositResult, StageInboxSender } from "../shared/store-types.js";

const STAGE_INBOX_OWNER_EVENT = "atomic:workflow-stage-inbox-owner";
const STAGE_INBOX_DEPOSIT_EVENT = "atomic:workflow-stage-inbox-deposit";

interface WorkflowEventSurface {
	readonly events?: {
		emit?(event: string, payload: Record<string, unknown>): void;
		on?(event: string, listener: (payload: unknown) => void): unknown;
	};
	on?(event: "session_shutdown", listener: () => void): void;
}

interface StageInboxDepositEvent {
	handled: boolean;
	completion?: Promise<
		| { readonly outcome: "queued"; readonly position: number }
		| { readonly outcome: "refused"; readonly reason: string }
	>;
	readonly depositId?: string;
	readonly from?: StageInboxSender;
	readonly runId?: string;
	readonly stageKey?: string;
	readonly message?: StageInboxDeposit["message"];
}

export function registerStageInboxIntercomBridge(pi: WorkflowEventSurface, activeStore: Store): () => void {
	let disposed = false;
	const announceOwners = (): void => {
		if (disposed) return;
		for (const run of activeStore.runs()) {
			const rootRunId = run.rootRunId ?? run.id;
			pi.events?.emit?.(STAGE_INBOX_OWNER_EVENT, {
				runId: run.id,
				group: workflowInvocationIntercomGroup(rootRunId),
			});
		}
	};
	const unsubscribeStore = activeStore.subscribeInvalidation(announceOwners);
	announceOwners();
	const subscription = pi.events?.on?.(STAGE_INBOX_DEPOSIT_EVENT, (payload) => {
		if (disposed || !isStageInboxDepositEvent(payload) || payload.handled) return;
		const run = activeStore.runs().find((candidate) => candidate.id === payload.runId);
		if (run === undefined) return;
		payload.handled = true;
		payload.completion = depositAndPersist(
			activeStore,
			payload,
			workflowInvocationIntercomGroup(run.rootRunId ?? run.id),
		);
	});
	const dispose = (): void => {
		disposed = true;
		unsubscribeStore();
		if (typeof subscription === "function") subscription();
	};
	pi.on?.("session_shutdown", dispose);
	return dispose;
}

function isStageInboxDepositEvent(
	value: unknown,
): value is StageInboxDepositEvent & Required<Pick<StageInboxDepositEvent, "from" | "runId" | "stageKey" | "message">> {
	if (typeof value !== "object" || value === null) return false;
	const event = value as StageInboxDepositEvent;
	return (
		typeof event.handled === "boolean" &&
		typeof event.runId === "string" &&
		typeof event.stageKey === "string" &&
		typeof event.from?.id === "string" &&
		(event.from.name === undefined || typeof event.from.name === "string") &&
		typeof event.message?.id === "string" &&
		typeof event.message.timestamp === "number" &&
		typeof event.message.content?.text === "string"
	);
}

async function depositAndPersist(
	activeStore: Store,
	event: StageInboxDepositEvent & Required<Pick<StageInboxDepositEvent, "from" | "runId" | "stageKey" | "message">>,
	runGroup: string,
): Promise<
	{ readonly outcome: "queued"; readonly position: number } | { readonly outcome: "refused"; readonly reason: string }
> {
	const deposit: StageInboxDeposit = {
		runId: event.runId,
		stageKey: event.stageKey,
		from: event.from,
		message: event.message,
		depositedAt: new Date(event.message.timestamp).toISOString(),
	};
	const result: StageInboxDepositResult | undefined = activeStore.depositStageInboxEntry(
		deposit,
		event.from.group,
		runGroup,
	);
	if (result === undefined) return { outcome: "refused", reason: `Workflow run not found: ${event.runId}` };
	if (!result.ok) {
		return result.reason === "capacity"
			? {
					outcome: "refused",
					reason: `Workflow stage inbox is full (limit ${result.limit}) for ${result.runId}:${result.stageKey}`,
				}
			: { outcome: "refused", reason: "Target workflow run is in a different intercom group" };
	}
	const backend = getDurableBackend();
	const handle = backend.getWorkflow(event.runId);
	const run = activeStore.runs().find((candidate) => candidate.id === event.runId);
	if (handle !== undefined && run !== undefined) {
		backend.registerWorkflow({ ...handle, stageInbox: run.stageInbox ?? [] });
		await backend.flush();
	}
	return { outcome: "queued", position: result.position };
}
