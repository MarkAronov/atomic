import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import type {
	ExtensionAPI,
	PiExecuteContext,
	PiToolOpts,
	WorkflowToolArgs,
} from "../../packages/workflows/src/extension/public-types.js";
import type {
	WorkflowRegisteredToolResult,
	WorkflowToolResult,
} from "../../packages/workflows/src/extension/render-result.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import {
	registerWorkflowTool,
	WORKFLOW_TOOL_REQUEST_TIMEOUT_MS,
} from "../../packages/workflows/src/extension/workflow-tool-registration.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

const READ_ONLY_ACTIONS = ["models", "list", "get", "inputs", "status", "stages", "stage", "transcript"] as const;
const MUTATING_ACTIONS = ["reload", "run", "send", "pause", "resume", "interrupt", "quit"] as const;
const ALL_ACTIONS = [...READ_ONLY_ACTIONS, ...MUTATING_ACTIONS] as const;

type WorkflowToolExecutor = (
	args: WorkflowToolArgs,
	ctx: PiExecuteContext,
	signal?: AbortSignal,
) => Promise<WorkflowToolResult>;

function registeredTool(executor: WorkflowToolExecutor): PiToolOpts<WorkflowToolArgs, WorkflowRegisteredToolResult> {
	let registered: PiToolOpts<WorkflowToolArgs, WorkflowRegisteredToolResult> | undefined;
	const pi: ExtensionAPI = {
		registerTool<TArgs, TResult>(tool: PiToolOpts<TArgs, TResult>) {
			registered = tool as unknown as PiToolOpts<WorkflowToolArgs, WorkflowRegisteredToolResult>;
		},
	};
	registerWorkflowTool(pi, executor, async (_policy, run) => run());
	if (registered === undefined) throw new Error("workflow tool was not registered");
	return registered;
}

function expectedTimeoutError(action: (typeof ALL_ACTIONS)[number]): string {
	const base = `Workflow ${action} request timed out after ${WORKFLOW_TOOL_REQUEST_TIMEOUT_MS}ms.`;
	return MUTATING_ACTIONS.includes(action as (typeof MUTATING_ACTIONS)[number])
		? `${base} The outcome is unknown. Inspect workflow status before retrying.`
		: base;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("public workflow tool request deadline", () => {
	test("times out every public action once at 30 seconds, cancels supported work, and ignores late settlement", async () => {
		vi.useFakeTimers();
		let invocationCount = 0;
		let active:
			| {
					readonly action: (typeof ALL_ACTIONS)[number];
					readonly deferred: PromiseWithResolvers<WorkflowToolResult>;
					readonly signal: AbortSignal;
			  }
			| undefined;
		const tool = registeredTool(async (args, _ctx, signal) => {
			invocationCount += 1;
			if (signal === undefined) throw new Error("workflow operation signal is required");
			const action = args.action as (typeof ALL_ACTIONS)[number];
			const deferred = Promise.withResolvers<WorkflowToolResult>();
			active = { action, deferred, signal };
			if (action === "interrupt") {
				signal.addEventListener("abort", () => deferred.reject(new Error("Agent process stopped")), { once: true });
			}
			return deferred.promise;
		});

		for (const [index, action] of ALL_ACTIONS.entries()) {
			let settled = false;
			const pending = tool.execute(`timeout-${action}`, { action }, undefined, undefined, {}).then((result) => {
				settled = true;
				return result;
			});
			await vi.advanceTimersByTimeAsync(0);
			assert.equal(active?.action, action);
			assert.equal(invocationCount, index + 1);

			await vi.advanceTimersByTimeAsync(WORKFLOW_TOOL_REQUEST_TIMEOUT_MS - 1);
			assert.equal(settled, false, `${action} must remain pending at 29,999ms`);
			await vi.advanceTimersByTimeAsync(1);
			const result = await pending;
			assert.equal(settled, true);
			assert.equal(active?.signal.aborted, true, `${action} must abort the delegated operation`);
			assert.deepEqual(result.details, {
				action,
				status: "failed",
				code: "WORKFLOW_TIMEOUT",
				timeoutMs: WORKFLOW_TOOL_REQUEST_TIMEOUT_MS,
				error: expectedTimeoutError(action),
			});
			assert.equal(result.content.length, 1);
			assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /WORKFLOW_TIMEOUT/);
			assert.equal(invocationCount, index + 1, `${action} must not retry`);

			active?.deferred.resolve({ action: "models", models: [] });
			await vi.advanceTimersByTimeAsync(0);
			assert.equal(result.details.status, "failed", `${action} late success must be ignored`);
		}
		assert.equal(vi.getTimerCount(), 0);
	});

	test("keeps the tool usable after timeout and preserves successful acknowledgement results", async () => {
		vi.useFakeTimers();
		let mode: "hang" | "success" = "hang";
		const tool = registeredTool(async (args) => {
			if (mode === "hang") return new Promise<WorkflowToolResult>(() => {});
			if (args.action === "run") {
				return { action: "run", runId: "run-ack", status: "running", message: "started in background" };
			}
			if (args.action === "resume") {
				return { action: "resume", runId: "resume-ack", status: "running", message: "resumed in background" };
			}
			return { action: "models", models: [] };
		});

		const timedOut = tool.execute("hang", { action: "list" }, undefined, undefined, {});
		await vi.advanceTimersByTimeAsync(WORKFLOW_TOOL_REQUEST_TIMEOUT_MS);
		const timeoutDetails = (await timedOut).details;
		assert.equal("code" in timeoutDetails ? timeoutDetails.code : undefined, "WORKFLOW_TIMEOUT");

		mode = "success";
		for (const args of [{ action: "models" }, { action: "run" }, { action: "resume" }] satisfies WorkflowToolArgs[]) {
			const result = await tool.execute("success", args, undefined, undefined, {});
			assert.equal(result.details.action, args.action);
			assert.notEqual("code" in result.details ? result.details.code : undefined, "WORKFLOW_TIMEOUT");
			assert.equal(vi.getTimerCount(), 0);
		}
	});

	test("preserves caller cancellation before and during a request without relabeling it as timeout", async () => {
		vi.useFakeTimers();
		let calls = 0;
		let operationSignal: AbortSignal | undefined;
		const deferred = Promise.withResolvers<WorkflowToolResult>();
		const tool = registeredTool(async (_args, _ctx, signal) => {
			calls += 1;
			operationSignal = signal;
			return deferred.promise;
		});
		const preAborted = new AbortController();
		const preAbortReason = new Error("caller stopped before admission");
		preAborted.abort(preAbortReason);
		await assert.rejects(
			() => tool.execute("pre-aborted", { action: "list" }, preAborted.signal, undefined, {}),
			(error: unknown) => error === preAbortReason,
		);
		assert.equal(calls, 0);

		const midFlight = new AbortController();
		const pending = tool.execute("mid-flight", { action: "interrupt" }, midFlight.signal, undefined, {});
		await vi.advanceTimersByTimeAsync(0);
		const midFlightReason = new Error("caller stopped mid-flight");
		midFlight.abort(midFlightReason);
		await assert.rejects(pending, (error: unknown) => error === midFlightReason);
		assert.equal(operationSignal?.aborted, true);
		assert.equal(calls, 1);
		assert.equal(vi.getTimerCount(), 0);

		deferred.reject(new Error("Agent process stopped"));
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(vi.getTimerCount(), 0);
	});

	test("the production executor releases an aborted resource wait and accepts the next validated command", async () => {
		const blockedLoad = Promise.withResolvers<void>();
		const runtime = createExtensionRuntime({ definitions: [] });
		const execute = makeExecuteWorkflowTool(
			runtime,
			() => undefined,
			() => blockedLoad.promise,
		);
		const controller = new AbortController();
		const pending = execute({ action: "get", workflow: "missing" }, {}, controller.signal);
		const reason = new Error("request deadline");
		controller.abort(reason);
		await assert.rejects(pending, (error: unknown) => error === reason);

		const models = await execute({ action: "models" }, {});
		assert.deepEqual(models, { action: "models", models: [] });
		blockedLoad.resolve();
	});

	test("production background run acknowledgement is independent from detached execution", async () => {
		const bodyEntered = Promise.withResolvers<void>();
		const releaseBody = Promise.withResolvers<void>();
		const store = createStore();
		const definition = workflow({
			name: "public-timeout-background-ack",
			description: "",
			inputs: {},
			outputs: {},
			run: async () => {
				bodyEntered.resolve();
				await releaseBody.promise;
				return {};
			},
		});
		const runtime = createExtensionRuntime({ definitions: [definition], store });
		const execute = makeExecuteWorkflowTool(runtime, () => undefined);
		const controller = new AbortController();
		const acknowledgement = await execute(
			{ action: "run", workflow: "public-timeout-background-ack" },
			{},
			controller.signal,
		);
		assert.equal(acknowledgement.action, "run");
		assert.equal("status" in acknowledgement ? acknowledgement.status : undefined, "running");
		await bodyEntered.promise;
		controller.abort(new Error("request lifetime ended after acknowledgement"));
		assert.equal(store.runs()[0]?.status, "running");
		releaseBody.resolve();
	});
});
