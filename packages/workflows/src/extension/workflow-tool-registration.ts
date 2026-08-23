import type { ExtensionAPI, PiExecuteContext, WorkflowToolArgs } from "./public-types.js";
import { renderCall } from "./render-call.js";
import { dynamicTextRenderComponent } from "./render-component.js";
import type { WorkflowRegisteredToolResult, WorkflowTimeoutResult, WorkflowToolResult } from "./render-result.js";
import { renderResult } from "./render-result.js";
import { workflowPolicyFromContext } from "./workflow-policy.js";
import { DEFAULT_PROMPT_GUIDANCE, WORKFLOW_TOOL_DESCRIPTION } from "./workflow-prompts.js";
import { raceWorkflowRequestAbort } from "./workflow-request-abort.js";
import { WorkflowParametersSchema } from "./workflow-schema.js";
import { renderWorkflowToolContent } from "./workflow-tool-content.js";

interface WorkflowToolRegistrationOptions {
	/** Internal fixture seam; production registrations always use the fixed default. */
	readonly requestTimeoutMs?: number;
}

export const WORKFLOW_TOOL_REQUEST_TIMEOUT_MS = 30_000;

type WorkflowToolExecutor = (
	args: WorkflowToolArgs,
	ctx: PiExecuteContext,
	signal?: AbortSignal,
) => Promise<WorkflowToolResult>;

const MUTATING_WORKFLOW_ACTIONS = new Set<NonNullable<WorkflowToolArgs["action"]>>([
	"reload",
	"run",
	"send",
	"pause",
	"resume",
	"interrupt",
	"quit",
]);

function workflowToolTimeoutResult(args: WorkflowToolArgs, timeoutMs: number): WorkflowTimeoutResult {
	const action = args.action ?? "run";
	const prefix = `Workflow ${action} request timed out after ${timeoutMs}ms.`;
	return {
		action,
		status: "failed",
		code: "WORKFLOW_TIMEOUT",
		timeoutMs,
		error: MUTATING_WORKFLOW_ACTIONS.has(action)
			? `${prefix} The outcome is unknown. Inspect workflow status before retrying.`
			: prefix,
	};
}

async function executeWithWorkflowToolDeadline(
	executeWorkflowTool: WorkflowToolExecutor,
	params: WorkflowToolArgs,
	ctx: PiExecuteContext,
	callerSignal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<WorkflowRegisteredToolResult> {
	callerSignal?.throwIfAborted();
	const deadlineController = new AbortController();
	const operationSignal =
		callerSignal === undefined
			? deadlineController.signal
			: AbortSignal.any([callerSignal, deadlineController.signal]);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<WorkflowRegisteredToolResult>((resolve) => {
		timer = setTimeout(() => {
			const result = workflowToolTimeoutResult(params, timeoutMs);
			resolve(result);
			deadlineController.abort(new Error(result.error));
		}, timeoutMs);
	});
	try {
		return await raceWorkflowRequestAbort(
			Promise.race([executeWorkflowTool(params, ctx, operationSignal), timeout]),
			callerSignal,
		);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

export function registerWorkflowTool(
	pi: ExtensionAPI,
	executeWorkflowTool: WorkflowToolExecutor,
	runWithLifecycleSuppressedForPolicy: <T>(
		policy: ReturnType<typeof workflowPolicyFromContext>,
		fn: () => Promise<T>,
	) => Promise<T>,
	options: WorkflowToolRegistrationOptions = {},
): void {
	if (typeof pi.registerTool !== "function") return;
	pi.registerTool<WorkflowToolArgs, WorkflowRegisteredToolResult>({
		name: "workflow",
		label: "workflow",
		description: WORKFLOW_TOOL_DESCRIPTION,
		parameters: WorkflowParametersSchema,
		promptGuidelines: DEFAULT_PROMPT_GUIDANCE,
		renderShell: "self",
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			const policy = workflowPolicyFromContext(ctx);
			const details = await executeWithWorkflowToolDeadline(
				(actionParams, actionContext, operationSignal) =>
					(actionParams.action ?? "run") === "run"
						? runWithLifecycleSuppressedForPolicy(policy, () =>
								executeWorkflowTool(actionParams, actionContext, operationSignal),
							)
						: executeWorkflowTool(actionParams, actionContext, operationSignal),
				params,
				ctx,
				signal,
				options.requestTimeoutMs ?? WORKFLOW_TOOL_REQUEST_TIMEOUT_MS,
			);
			return {
				content: [{ type: "text", text: renderWorkflowToolContent(details, params) }],
				details,
			};
		},
		renderCall: (args, _theme, _context) => dynamicTextRenderComponent((width) => renderCall(args, { width })),
		renderResult: (result, opts, _theme, context) => {
			const capturedNow = Date.now();
			return dynamicTextRenderComponent((width) =>
				renderResult(result.details, {
					...opts,
					width,
					now: capturedNow,
					runInputs: (context as { args?: WorkflowToolArgs }).args?.inputs,
				}),
			);
		},
	});
}
