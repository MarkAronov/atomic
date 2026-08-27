import {
	acquirePostMortemStageHandle,
	type PostMortemStageChatDeps,
} from "../runs/foreground/postmortem-stage-chat.js";
import type { DetachedStageHandleLease, StageControlHandle } from "../runs/foreground/stage-control-registry.js";
import { stageControlRegistry } from "../runs/foreground/stage-control-registry.js";
import type { StageUserMessageDeliveryAction } from "../runs/foreground/stage-runner-types.js";
import { store } from "../shared/store.js";
import { isTerminalRunStatus } from "../shared/store-internal.js";
import { subscribeStoreInvalidation } from "../shared/store-observation.js";
import { reciprocalWorkflowRootRunId } from "../shared/workflow-run-ownership.js";
import type { WorkflowToolArgs } from "./public-types.js";
import type { WorkflowToolResult } from "./render-result.js";
import { resolveToolRunTarget, resolveToolStageTarget } from "./workflow-targets.js";
import { workflowAnswerAction } from "./workflow-tool-answer.js";

/**
 * Optional dependencies enabling `workflow send` to revive an eligible
 * completed agent stage while its authoritative root is still nonterminal.
 */
export interface WorkflowSendDeps {
	readonly resolvePostMortemDeps?: (runId: string) => PostMortemStageChatDeps;
}

type WorkflowSendToolResult = Extract<WorkflowToolResult, { action: "send" }>;

function textPayloadFromArgs(args: WorkflowToolArgs): string | undefined {
	if (args.text !== undefined) return args.text;
	if (typeof args.response === "string") return args.response;
	return args.message;
}

function workflowSendResult(
	runId: string,
	stageId: string,
	delivery: WorkflowSendToolResult["delivery"],
	status: "ok" | "noop",
	message: string,
): WorkflowSendToolResult {
	return { action: "send", runId, stageId, delivery, status, message };
}

function answerAsSendResult(result: Extract<WorkflowToolResult, { action: "answer" }>): WorkflowSendToolResult {
	if (result.status === "failed") {
		return { ...result, action: "send", delivery: "rejected" };
	}
	return {
		action: "send",
		runId: result.runId,
		stageId: result.stageId,
		delivery: "answer",
		status: result.status,
		message: result.message,
	};
}

function terminalWorkflowSendResult(
	runId: string,
	stageId: string,
	workflowStatus: Parameters<typeof isTerminalRunStatus>[0],
): WorkflowSendToolResult {
	const message = `Cannot send a message because workflow ${runId} has terminated with status ${workflowStatus}. If work remains, start a new workflow to address it. Complete it inline only when the remaining task is small, deterministic, and low risk.`;
	return {
		action: "send",
		runId,
		stageId,
		delivery: "rejected",
		status: "failed",
		code: "WORKFLOW_TERMINAL",
		workflowStatus,
		error: message,
		message,
	};
}

class WorkflowSendAdmissionError extends Error {
	constructor(readonly result: WorkflowSendToolResult) {
		super(result.message);
	}
}

function terminalWorkflowSendResultForRoot(rootRunId: string, stageId: string): WorkflowSendToolResult | undefined {
	const rootRun = store.runs().find((run) => run.id === rootRunId);
	return rootRun !== undefined && isTerminalRunStatus(rootRun.status)
		? terminalWorkflowSendResult(rootRun.id, stageId, rootRun.status)
		: undefined;
}

async function deliverStageUserMessage(
	handle: StageControlHandle,
	text: string,
	deliverAs: "steer" | "followUp" | undefined,
	beforeDelivery: () => void,
): Promise<StageUserMessageDeliveryAction> {
	if (handle.sendUserMessage === undefined) {
		throw new Error("atomic-workflows: stage handle does not support admission-aware message delivery");
	}
	return handle.sendUserMessage(text, { deliverAs }, beforeDelivery);
}

function deliveryMessage(delivery: StageUserMessageDeliveryAction): string {
	if (delivery === "prompt") return "Prompt started for stage.";
	if (delivery === "steer") return "Steered live stage.";
	if (delivery === "followUp") return "Follow-up queued for stage.";
	return "Message handled by stage extension.";
}

export async function workflowSendAction(
	args: WorkflowToolArgs,
	deps: WorkflowSendDeps = {},
): Promise<WorkflowSendToolResult> {
	const target = resolveToolRunTarget(args, "No active run to message.");
	const requestedDelivery = args.delivery ?? "auto";
	if (target.kind === "all") {
		return workflowSendResult("--all", "", requestedDelivery, "noop", "Send requires a single run.");
	}
	if (target.kind === "malformed" || target.kind === "not_found") {
		return workflowSendResult(target.target, "", requestedDelivery, "noop", target.message);
	}
	const runs = store.runs();
	const runById = new Map(runs.map((run) => [run.id, run]));
	const rootRunId = reciprocalWorkflowRootRunId(runById, target.runId) ?? target.runId;
	const rootRun = runById.get(rootRunId);
	if (rootRun !== undefined && isTerminalRunStatus(rootRun.status)) {
		return terminalWorkflowSendResult(rootRun.id, args.stageId?.trim() ?? "", rootRun.status);
	}
	if (requestedDelivery === "answer" || requestedDelivery === "auto" || args.promptId !== undefined) {
		const answer = await workflowAnswerAction(args, {
			implicit: requestedDelivery === "auto" && args.promptId === undefined,
		});
		if (answer !== undefined) return answerAsSendResult(answer);
	}
	const stage = resolveToolStageTarget(target.runId, args.stageId);
	if (!stage.ok || stage.stageId === undefined) {
		return workflowSendResult(
			target.runId,
			"",
			requestedDelivery,
			"noop",
			stage.ok ? "Stage id or name is required." : stage.message,
		);
	}
	const resolvedStageId = stage.stageId;
	const stageRunId = stage.runId ?? target.runId;
	const run = store.runs().find((candidate) => candidate.id === stageRunId);
	const snapshot = run?.stages.find((candidate) => candidate.id === stage.stageId);
	const text = textPayloadFromArgs(args);
	if (text === undefined) {
		return workflowSendResult(
			stageRunId,
			stage.stageId,
			requestedDelivery,
			"noop",
			"Send requires text, response, or message.",
		);
	}
	let lease: DetachedStageHandleLease | undefined;
	let handle: StageControlHandle | undefined;
	const existingHandle = stageControlRegistry.peek(stageRunId, stage.stageId);
	if (existingHandle !== undefined) {
		lease = stageControlRegistry.acquireDetached(stageRunId, stage.stageId, () => existingHandle);
		handle = lease.handle;
	} else if (deps.resolvePostMortemDeps !== undefined && snapshot !== undefined) {
		const acquired = acquirePostMortemStageHandle(stageRunId, snapshot, deps.resolvePostMortemDeps(stageRunId));
		if (acquired.ok) {
			lease = acquired.lease;
			handle = lease.handle;
		}
	}
	if (handle === undefined) {
		return workflowSendResult(stageRunId, stage.stageId, requestedDelivery, "noop", "No live handle for stage.");
	}
	let admitted = false;
	// Store terminal publication and this final SDK admission check are both
	// synchronous; no await occurs between this callback and SDK mutation.
	const admitDelivery = (): void => {
		const terminal = terminalWorkflowSendResultForRoot(rootRunId, args.stageId?.trim() ?? resolvedStageId);
		if (terminal !== undefined) throw new WorkflowSendAdmissionError(terminal);
		if (lease !== undefined && !lease.commit()) {
			throw new WorkflowSendAdmissionError(
				workflowSendResult(
					stageRunId,
					resolvedStageId,
					requestedDelivery,
					"noop",
					"Stage handle changed before message admission; retry against the current live stage.",
				),
			);
		}
		admitted = true;
	};
	const terminalPending = Promise.withResolvers<never>();
	const unsubscribeTerminal = subscribeStoreInvalidation(store, () => {
		if (admitted) return;
		const terminal = terminalWorkflowSendResultForRoot(rootRunId, args.stageId?.trim() ?? resolvedStageId);
		if (terminal !== undefined) terminalPending.reject(new WorkflowSendAdmissionError(terminal));
	});
	const awaitAdmission = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, terminalPending.promise]);
	try {
		// A completed post-mortem handle is not live execution: its handle-level
		// resume()/pause() reject by contract. Return a structured noop with guidance
		// instead of letting that rejection cross the tool boundary. Failed handles
		// remain eligible for their existing recoverable execution-resume semantics.
		const isTerminalPostMortemStage = handle.status === "completed";
		if (requestedDelivery === "resume" && handle.status !== "paused" && !isTerminalPostMortemStage) {
			return workflowSendResult(
				stageRunId,
				stage.stageId,
				"resume",
				"noop",
				"Stage is not paused; no resume message was delivered.",
			);
		}
		if (handle.status === "paused" && requestedDelivery !== "resume" && requestedDelivery !== "auto") {
			return workflowSendResult(
				stageRunId,
				stage.stageId,
				requestedDelivery,
				"noop",
				"Stage is paused; resume it before sending a new message.",
			);
		}
		const resumesStage =
			requestedDelivery === "resume" || (requestedDelivery === "auto" && handle.status === "paused");
		if (!resumesStage && handle.sendUserMessage === undefined) {
			return workflowSendResult(
				stageRunId,
				stage.stageId,
				requestedDelivery,
				"noop",
				"Stage handle does not support admission-aware message delivery.",
			);
		}
		if (resumesStage) {
			if (isTerminalPostMortemStage) {
				return workflowSendResult(
					stageRunId,
					stage.stageId,
					"resume",
					"noop",
					'Cannot resume a terminal post-mortem stage; use delivery "followUp" or "prompt" to continue its retained conversation.',
				);
			}
			const resumedDelivery = await awaitAdmission(handle.resume(text, admitDelivery));
			if (resumedDelivery !== undefined && resumedDelivery !== "prompt") {
				return workflowSendResult(
					stageRunId,
					stage.stageId,
					resumedDelivery,
					"ok",
					deliveryMessage(resumedDelivery),
				);
			}
			if (resumedDelivery === "prompt") {
				return workflowSendResult(stageRunId, stage.stageId, "prompt", "ok", "Resumed stage and started prompt.");
			}
			const hasResumeMessage = text.trim().length > 0;
			return workflowSendResult(
				stageRunId,
				stage.stageId,
				"resume",
				"ok",
				hasResumeMessage ? "Resumed interrupted stage with message." : "Resumed stage.",
			);
		}
		if (requestedDelivery === "steer") {
			if (isTerminalPostMortemStage) {
				return workflowSendResult(
					stageRunId,
					stage.stageId,
					"steer",
					"noop",
					'Cannot steer a terminal post-mortem stage; use delivery "followUp" or "prompt" to continue its retained conversation.',
				);
			}
			const delivery = await awaitAdmission(deliverStageUserMessage(handle, text, "steer", admitDelivery));
			return workflowSendResult(stageRunId, stage.stageId, delivery, "ok", deliveryMessage(delivery));
		}
		if (requestedDelivery === "auto" && handle.isStreaming && !isTerminalPostMortemStage) {
			const delivery = await awaitAdmission(deliverStageUserMessage(handle, text, "steer", admitDelivery));
			return workflowSendResult(stageRunId, stage.stageId, delivery, "ok", deliveryMessage(delivery));
		}
		if (requestedDelivery === "prompt") {
			const delivery = await awaitAdmission(deliverStageUserMessage(handle, text, undefined, admitDelivery));
			const message = delivery === "prompt" ? "Prompt sent to stage." : deliveryMessage(delivery);
			return workflowSendResult(stageRunId, stage.stageId, delivery, "ok", message);
		}
		const delivery = await awaitAdmission(deliverStageUserMessage(handle, text, "followUp", admitDelivery));
		return workflowSendResult(stageRunId, stage.stageId, delivery, "ok", deliveryMessage(delivery));
	} catch (error) {
		if (error instanceof WorkflowSendAdmissionError) return error.result;
		throw error;
	} finally {
		unsubscribeTerminal();
		if (!admitted) {
			try {
				await lease?.release();
			} catch (error) {
				console.warn("atomic-workflows: provisional workflow-send handle cleanup failed", error);
			}
		}
	}
}
