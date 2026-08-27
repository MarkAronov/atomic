import { getDurableBackend } from "../durable/factory.js";
import { workflowInvocationIntercomGroup } from "../shared/intercom-group.js";
import { workflowPendingStageRouteCapability } from "../shared/pending-stage-route-capability.js";
import type { Store } from "../shared/store.js";
import type { PendingStageMessageInput, PendingStageQueueResult, PendingStageSender } from "../shared/store-types.js";

const PENDING_STAGE_ROUTE_EVENT = "atomic:workflow-pending-stage-route";
const PENDING_STAGE_MESSAGE_EVENT = "atomic:workflow-pending-stage-message";

interface WorkflowEventSurface {
	readonly events?: {
		emit?(event: string, payload: Record<string, unknown>): void;
		on?(event: string, listener: (payload: unknown) => void): unknown;
	};
	on?(event: "session_shutdown", listener: () => void): void;
}

interface PendingStageMessageEvent {
	handled: boolean;
	completion?: Promise<
		| { readonly outcome: "queued"; readonly position: number }
		| { readonly outcome: "refused"; readonly reason: string }
	>;
	readonly requestId?: string;
	readonly from?: PendingStageSender;
	readonly runId?: string;
	readonly stageKey?: string;
	readonly message?: PendingStageMessageInput["message"];
}

export function registerPendingStageIntercomBridge(pi: WorkflowEventSurface, activeStore: Store): () => void {
	let disposed = false;
	const announceOwners = (): void => {
		if (disposed) return;
		for (const run of activeStore.runs()) {
			const rootRunId = run.rootRunId ?? run.id;
			pi.events?.emit?.(PENDING_STAGE_ROUTE_EVENT, {
				runId: run.id,
				group: workflowInvocationIntercomGroup(rootRunId),
				capability: workflowPendingStageRouteCapability(activeStore, run.id),
			});
		}
	};
	const unsubscribeStore = activeStore.subscribeInvalidation(announceOwners);
	announceOwners();
	const subscription = pi.events?.on?.(PENDING_STAGE_MESSAGE_EVENT, (payload) => {
		if (disposed || !isPendingStageMessageEvent(payload) || payload.handled) return;
		const run = activeStore.runs().find((candidate) => candidate.id === payload.runId);
		if (run === undefined || !isKnownUninitializedStage(run, payload.stageKey)) return;
		payload.handled = true;
		payload.completion = queueAndPersist(
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

function isPendingStageMessageEvent(
	value: unknown,
): value is PendingStageMessageEvent &
	Required<Pick<PendingStageMessageEvent, "from" | "runId" | "stageKey" | "message">> {
	if (typeof value !== "object" || value === null) return false;
	const event = value as PendingStageMessageEvent;
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

async function queueAndPersist(
	activeStore: Store,
	event: PendingStageMessageEvent &
		Required<Pick<PendingStageMessageEvent, "from" | "runId" | "stageKey" | "message">>,
	runGroup: string,
): Promise<
	{ readonly outcome: "queued"; readonly position: number } | { readonly outcome: "refused"; readonly reason: string }
> {
	const request: PendingStageMessageInput = {
		runId: event.runId,
		stageKey: event.stageKey,
		from: event.from,
		message: event.message,
		queuedAt: new Date(event.message.timestamp).toISOString(),
	};
	const backend = getDurableBackend();
	const result: PendingStageQueueResult | undefined = await activeStore.queueStageMessage(
		request,
		event.from.group,
		runGroup,
		backend,
	);
	if (result === undefined) return { outcome: "refused", reason: "Session not found" };
	if (!result.ok) {
		return result.reason === "capacity"
			? {
					outcome: "refused",
					reason: `Pending stage message queue is full (limit ${result.limit}) for ${result.runId}:${result.stageKey}`,
				}
			: { outcome: "refused", reason: "Target workflow run is in a different intercom group" };
	}
	return { outcome: "queued", position: result.position };
}

function isKnownUninitializedStage(run: ReturnType<Store["runs"]>[number], stageKey: string): boolean {
	const exactIds = run.stages.filter((stage) => stage.id === stageKey);
	const candidates = exactIds.length > 0 ? exactIds : run.stages.filter((stage) => stage.name === stageKey);
	if (candidates.length !== 1) return false;
	const stage = candidates[0]!;
	return (
		(stage.status === "pending" || stage.status === "running") &&
		stage.sessionId === undefined &&
		stage.sessionFile === undefined
	);
}
