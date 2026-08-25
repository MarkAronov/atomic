import type { DurableWorkflowBackend } from "../durable/backend.js";
import { appendRunEnd } from "../shared/persistence-session-entries.js";
import type { Store } from "../shared/store.js";
import type { RunSnapshot } from "../shared/store-types.js";
import type { WorkflowPersistencePort } from "../shared/types.js";

/**
 * Source ids whose active-block resume is currently in flight in this process.
 * Held until the continuation settles so a concurrent same-session resume
 * cannot double-dispatch. Released after the local source is killed, or after
 * a fail-closed replay-topology mismatch leaves the source resumable.
 * Cross-process concurrent resume is not guarded here — it is the same
 * recoverable, idempotent-replay edge that exists for any durable
 * failed/blocked run.
 */
const inFlightActiveBlockResumes = new Set<string>();

/**
 * Claim the right to resume an active recoverable block in this process. The
 * durable source is intentionally NOT mutated: it stays `blocked`/resumable so
 * it remains discoverable and recoverable — including a zero-checkpoint
 * first-stage block — if the process dies before the continuation settles.
 */
export function claimActiveBlockedResume(_backend: DurableWorkflowBackend, sourceId: string): boolean {
	if (inFlightActiveBlockResumes.has(sourceId)) return false;
	inFlightActiveBlockResumes.add(sourceId);
	return true;
}

/** Release an in-flight claim (dispatch failed, or the source was finalized). */
export function releaseActiveBlockedClaim(sourceId: string): void {
	inFlightActiveBlockResumes.delete(sourceId);
}

/** Remove a continuation that settled before startup admission completed. */
export async function discardFailedActiveBlockedContinuation(
	backend: DurableWorkflowBackend,
	runId: string,
	store: Store,
): Promise<void> {
	store.removeRun(runId);
	const handle = backend.getWorkflow(runId);
	if (handle?.status === "running") {
		backend.setWorkflowStatus(runId, "failed", handle.pendingPrompts, false);
		await backend.flush();
	}
	const deleted = await backend.deleteWorkflowIfInactive(runId);
	if (!deleted.ok && deleted.reason !== "not_found") {
		throw new Error(`continuation ${runId} remained ${deleted.reason}`);
	}
}
/**
 * Mark the resumed source killed locally so the same session will not count it
 * as a second in-flight run. The durable source stays `blocked`/resumable.
 */
export function finalizeResumedActiveBlockedSourceRun(
	source: RunSnapshot,
	continuationRunId: string,
	store: Store,
	persistence?: WorkflowPersistencePort,
): void {
	const error = source.error ?? source.failureMessage ?? `workflow resumed in new run ${continuationRunId}`;
	const metadata = {
		...(source.failureKind !== undefined ? { failureKind: source.failureKind } : {}),
		...(source.failureCode !== undefined ? { failureCode: source.failureCode } : {}),
		failureRecoverability: "non_recoverable" as const,
		failureDisposition: "terminal_killed" as const,
		...(source.failureMessage !== undefined ? { failureMessage: source.failureMessage } : {}),
		...(source.failedStageId !== undefined ? { failedStageId: source.failedStageId } : {}),
		resumable: false,
		...(source.retryAfterMs !== undefined ? { retryAfterMs: source.retryAfterMs } : {}),
	};
	const recorded = store.recordRunEnd(source.id, "killed", undefined, error, metadata);
	if (recorded && persistence !== undefined) {
		try {
			appendRunEnd(persistence, { runId: source.id, status: "killed", error, ...metadata, ts: Date.now() });
		} catch {
			// Local kill already landed. Persistence must not undo it or escape.
		}
	}
}

function restoreActiveBlockedSource(source: RunSnapshot, store: Store): void {
	store.restoreActiveBlockedRun(source, source.error ?? source.failureMessage ?? "workflow is blocked", {
		failureRecoverability: "recoverable",
		failureDisposition: "active_blocked",
		resumable: true,
		...(source.failureKind !== undefined ? { failureKind: source.failureKind } : {}),
		...(source.failureCode !== undefined ? { failureCode: source.failureCode } : {}),
		...(source.failureMessage !== undefined ? { failureMessage: source.failureMessage } : {}),
		...(source.failedStageId !== undefined ? { failedStageId: source.failedStageId } : {}),
		...(source.retryAfterMs !== undefined ? { retryAfterMs: source.retryAfterMs } : {}),
		...(source.blockedAt !== undefined ? { blockedAt: source.blockedAt } : {}),
		...(source.result !== undefined ? { result: source.result } : {}),
		...(source.budgetState !== undefined ? { budgetState: source.budgetState } : {}),
	});
}

export function isReplayTopologyMismatchFailure(
	result: { readonly error?: string } | undefined,
	error: unknown,
): boolean {
	const message =
		result?.error ?? (error instanceof Error ? error.message : error === undefined ? undefined : String(error));
	return (
		typeof message === "string" &&
		(message.includes("insufficient_state: replay topology mismatch") ||
			message.includes("insufficient_state: replay topology ambiguous"))
	);
}

/**
 * After admission the local source is already killed. A fail-closed replay
 * topology failure puts the reserved snapshot back so the same session can
 * retry. Other settlements leave the kill in place. Errors stay inside this
 * callback.
 */
export function finalizeActiveBlockedSourceAfterContinuation(input: {
	readonly source: RunSnapshot;
	readonly continuationRunId: string;
	readonly store: Store;
	readonly persistence?: WorkflowPersistencePort;
	readonly result?: { readonly error?: string };
	readonly error?: unknown;
}): void {
	try {
		if (isReplayTopologyMismatchFailure(input.result, input.error)) {
			restoreActiveBlockedSource(input.source, input.store);
		}
	} catch {
		// Claim release is required even if restore fails.
	} finally {
		releaseActiveBlockedClaim(input.source.id);
	}
}
