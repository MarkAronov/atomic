import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { test } from "vitest";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type {
	ExecutorDeps,
	SubagentExecutorRuntimeDeps,
} from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import {
	PARENT_ASK_HANDOFF_REQUEST_EVENT,
	type ParentAskHandoffRequest,
} from "../../packages/subagents/src/shared/types.js";
import { sleep } from "../helpers/runtime.js";

class TestEvents {
	private readonly handlers = new Map<string, Set<(payload: unknown) => void>>();
	readonly listenerReady = Promise.withResolvers<void>();

	on(channel: string, handler: (payload: unknown) => void): () => void {
		let listeners = this.handlers.get(channel);
		if (!listeners) {
			listeners = new Set();
			this.handlers.set(channel, listeners);
		}
		listeners.add(handler);
		if (channel === PARENT_ASK_HANDOFF_REQUEST_EVENT) this.listenerReady.resolve();
		return () => listeners?.delete(handler);
	}

	emit(channel: string, payload: unknown): void {
		for (const handler of this.handlers.get(channel) ?? []) handler(payload);
	}
}

function worker(): AgentConfig {
	return {
		name: "worker",
		description: "parent ask integration worker",
		systemPrompt: "Use parent coordination when instructed.",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "project",
		filePath: "/tmp/parent-ask-worker.md",
	};
}

function state(): ExecutorDeps["state"] {
	return {
		baseCwd: "",
		currentSessionId: "parent",
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		lastUiContext: null,
	};
}

function context(root: string): ExtensionContext {
	return {
		cwd: root,
		mode: "tui",
		hasUI: false,
		model: undefined,
		scopedModels: [],
		modelRegistry: { getAvailable: () => [] },
		sessionManager: {
			getSessionFile: () => join(root, "parent.jsonl"),
			getSessionId: () => "parent-session-id",
			getLeafId: () => null,
		},
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	} as never as ExtensionContext;
}

function text(result: Awaited<ReturnType<ReturnType<typeof createSubagentExecutor>["execute"]>>): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

function executor(
	root: string,
	events: TestEvents,
	childState: ExecutorDeps["state"],
	runtime: SubagentExecutorRuntimeDeps,
) {
	return createSubagentExecutor({
		pi: { events, getSessionName: () => "parent-session" } as never,
		state: childState,
		config: { parallel: { concurrency: 2, maxTasks: 10 } },
		tempArtifactsDir: join(root, "artifacts"),
		getSubagentSessionRoot: () => join(root, "sessions"),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [worker()] }),
		runtime,
	});
}

test("SINGLE parent ask ends the old child and returns an ordered fresh-start handoff", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-single-parent-handoff-"));
	const events = new TestEvents();
	const childState = state();
	const gate = Promise.withResolvers<void>();
	let firstOptions: Parameters<SubagentExecutorRuntimeDeps["runSync"]>[4] | undefined;
	let runCalls = 0;
	const runtime: SubagentExecutorRuntimeDeps = {
		runSync: async (cwd, agents, agentName, task, options) => {
			runCalls += 1;
			firstOptions ??= options;
			return runSync(cwd, agents, agentName, task, {
				...options,
				testSession:
					runCalls === 1
						? { output: "must not complete", promptGate: gate.promise, abortResolvesPrompt: true }
						: { output: `fresh follow-up: ${task}` },
			});
		},
	};
	const run = executor(root, events, childState, runtime);
	clearSubagentControls();
	try {
		const initial = run.execute(
			"initial",
			{ agent: "worker", task: "Original  objective\nwith exact spacing", artifacts: false },
			new AbortController().signal,
			undefined,
			context(root),
		);
		await events.listenerReady.promise;
		for (let attempt = 0; attempt < 100 && !firstOptions; attempt++) await sleep(1);
		assert.ok(firstOptions?.intercomSessionName && firstOptions.orchestratorIntercomTarget);
		const attachments = [
			{ type: "snippet" as const, name: "same.ts", content: "first  attachment", language: "ts" },
			{ type: "context" as const, name: "same.ts", content: "second\nattachment" },
		];
		const request: ParentAskHandoffRequest = {
			runId: firstOptions.runId,
			index: 0,
			agent: "worker",
			childIntercomTarget: firstOptions.intercomSessionName,
			orchestratorTarget: firstOptions.orchestratorIntercomTarget,
			kind: "decision",
			question: "Keep  this question\nverbatim?",
			attachments,
			claimed: false,
		};
		events.emit(PARENT_ASK_HANDOFF_REQUEST_EVENT, request);
		const yielded = await initial;
		assert.equal(request.claimed, true);
		assert.equal(request.taskContext, "Original  objective\nwith exact spacing");
		assert.equal(yielded.details.parentAskYielded, true);
		assert.equal(yielded.details.results[0]?.status, "interrupted");
		assert.match(text(yielded), /Subagent yielded for parent input \(worker, child 1\)\./);
		assert.match(text(yielded), /Keep {2}this question\nverbatim\?/);
		assert.match(text(yielded), /📎 same\.ts\n~~~ts\nfirst {2}attachment\n~~~/);
		assert.match(text(yielded), /📎 same\.ts\nsecond\nattachment/);
		assert.match(text(yielded), /\[TASK_CONTEXT\]/);
		assert.match(text(yielded), /Start a fresh subagent with a new run identity/);
		assert.match(text(yielded), /Continue with this supervisor answer: <SUPERVISOR_ANSWER>/);
		assert.doesNotMatch(text(yielded), /action.*resume|Resume with:/i);
		assert.equal(Object.hasOwn(childState, "foregroundRuns"), false);

		gate.resolve();
		const followUp = await run.execute(
			"fresh-follow-up",
			{ agent: "worker", task: "[TASK_CONTEXT] Supervisor answer: choose B", artifacts: false },
			new AbortController().signal,
			undefined,
			context(root),
		);
		assert.notEqual(followUp.details.runId, yielded.details.runId);
		assert.equal(runCalls, 2);
		assert.match(text(followUp), /fresh follow-up/);
	} finally {
		gate.resolve();
		clearSubagentControls();
		rmSync(root, { recursive: true, force: true });
	}
});

test("PARALLEL parent ask terminates the active set and never launches queued siblings", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-parallel-parent-handoff-"));
	const events = new TestEvents();
	const childState = state();
	const gate = Promise.withResolvers<void>();
	const options = new Map<number, Parameters<SubagentExecutorRuntimeDeps["runSync"]>[4]>();
	const calls: Array<{ index: number; task: string }> = [];
	const runtime: SubagentExecutorRuntimeDeps = {
		runSync: async (cwd, agents, agentName, task, runOptions) => {
			const index = runOptions.index ?? -1;
			calls.push({ index, task });
			options.set(index, runOptions);
			return runSync(cwd, agents, agentName, task, {
				...runOptions,
				testSession: { output: `must not complete ${index}`, promptGate: gate.promise, abortResolvesPrompt: true },
			});
		},
	};
	const run = executor(root, events, childState, runtime);
	clearSubagentControls();
	try {
		const initial = run.execute(
			"parallel",
			{
				tasks: [
					{ agent: "worker", task: "asking child" },
					{ agent: "worker", task: "active sibling" },
					{ agent: "worker", task: "queued sibling" },
				],
				concurrency: 2,
				artifacts: false,
			},
			new AbortController().signal,
			undefined,
			context(root),
		);
		await events.listenerReady.promise;
		for (let attempt = 0; attempt < 200 && options.size < 2; attempt++) await sleep(1);
		const asker = options.get(0);
		assert.ok(asker?.intercomSessionName && asker.orchestratorIntercomTarget);
		const request: ParentAskHandoffRequest = {
			runId: asker.runId,
			index: 0,
			agent: "worker",
			childIntercomTarget: asker.intercomSessionName,
			orchestratorTarget: asker.orchestratorIntercomTarget,
			kind: "intercom",
			question: "Parallel choice?",
			claimed: false,
		};
		events.emit(PARENT_ASK_HANDOFF_REQUEST_EVENT, request);
		const yielded = await initial;
		assert.equal(request.taskContext, "asking child");
		assert.equal(yielded.details.parentAskYielded, true);
		assert.ok(yielded.details.results.slice(0, 2).every((result) => result.interrupted));
		assert.equal(yielded.details.results[2]?.status, "skipped");
		assert.deepEqual(
			calls.map(({ index }) => index),
			[0, 1],
		);
		assert.equal(Object.hasOwn(childState, "foregroundRuns"), false);
		assert.match(text(yielded), /Parallel choice\?/);
		assert.doesNotMatch(text(yielded), /active sibling|queued sibling|resume/i);
	} finally {
		gate.resolve();
		clearSubagentControls();
		rmSync(root, { recursive: true, force: true });
	}
});
