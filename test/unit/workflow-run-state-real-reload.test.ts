/**
 * Real second evaluation of the workflows module graph over one shared host
 * scope. `/reload` re-evaluates that graph through jiti (`tryNative: false`,
 * `atomicExtensionCache` bust, `moduleCache: false`) while the session event
 * bus stays put; this file drives that same host loader, not a stub of it.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentSession } from "@bastani/atomic";
import { createJiti } from "jiti/static";
import { beforeEach, test } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.ts";
import { loadExtensionFromFactory } from "../../packages/coding-agent/src/core/extensions/loader-core.ts";
import { createExtensionRuntime } from "../../packages/coding-agent/src/core/extensions/loader-runtime.ts";
import { extensionLoaderTestHooks } from "../../packages/coding-agent/src/core/extensions/loader-virtual-modules.ts";
import type { Extension, ExtensionFactory } from "../../packages/coding-agent/src/core/extensions/types.ts";
import type { ToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.ts";
import type { CancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.ts";
import type { JobTracker } from "../../packages/workflows/src/runs/background/job-tracker.ts";
import type {
	StageControlHandle,
	StageControlRegistry,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.ts";
import { resetSessionScopedSingletonPreAdoptionForTests } from "../../packages/workflows/src/shared/session-scoped-singleton.ts";
import { buildStagePromptAdapter } from "../../packages/workflows/src/shared/stage-prompt.ts";
import type { StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.ts";
import type { Store } from "../../packages/workflows/src/shared/store.ts";
import { readText } from "../helpers/runtime.ts";

beforeEach(() => {
	resetSessionScopedSingletonPreAdoptionForTests();
});

/** Full transformed re-evaluation of the workflows graph, twice, through the host loader. */
const WORKFLOW_MODULE_GRAPH_RELOAD_TIMEOUT_MS = 120_000;

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const workflowsSrc = join(repoRoot, "packages/workflows/src");
const graphEntry = join(repoRoot, "test/helpers/workflow-graph-generation.ts");

const SINGLETON_SOURCES = {
	store: join(workflowsSrc, "shared/store-factory.ts"),
	stageControl: join(workflowsSrc, "runs/foreground/stage-control-registry.ts"),
	cancellation: join(workflowsSrc, "runs/background/cancellation-registry.ts"),
	toolControl: join(workflowsSrc, "engine/run-tool-control-registry.ts"),
	jobTracker: join(workflowsSrc, "runs/background/job-tracker.ts"),
	stageUi: join(workflowsSrc, "shared/stage-ui-broker.ts"),
} as const;

interface WorkflowGeneration {
	readonly store: Store;
	readonly stageControlRegistry: StageControlRegistry;
	readonly cancellationRegistry: CancellationRegistry;
	readonly toolControlRegistry: ToolControlRegistry;
	readonly jobTracker: JobTracker;
	readonly stageUiBroker: StageUiBroker;
	readonly factory: ExtensionFactory;
	readonly adoptWorkflowSessionRunState?: (scope: object | undefined) => void;
}

type SessionHandler = (event: unknown, context?: unknown) => Promise<unknown> | unknown;

async function emitSessionEvent(
	extension: Extension,
	event: string,
	payload: unknown,
	context?: unknown,
): Promise<void> {
	for (const handler of extension.handlers.get(event) ?? []) {
		await (handler as SessionHandler)(payload, context);
	}
}

interface WidgetCall {
	readonly key: string;
	readonly factory?: (tui: unknown, theme: unknown) => { render(width: number): string[] };
	readonly placement?: string;
}

function createWidgetUi(): { readonly ui: object; readonly calls: WidgetCall[]; readonly renders: { count: number } } {
	const calls: WidgetCall[] = [];
	const renders = { count: 0 };
	return {
		calls,
		renders,
		ui: {
			setWidget(key: string, factory: WidgetCall["factory"], options?: { readonly placement?: string }): void {
				calls.push({ key, factory, placement: options?.placement });
			},
			requestRender(): void {
				renders.count += 1;
			},
			notify(): void {},
		},
	};
}

let graphGeneration = 0;

function hostAliases(): Record<string, string> {
	const aliases = { ...extensionLoaderTestHooks.getAliases() };
	delete aliases["@bastani/atomic"];
	return aliases;
}

function cacheBustedHref(file: string, cacheKey: string): string {
	const url = pathToFileURL(file);
	url.searchParams.set("atomicExtensionCache", cacheKey);
	return url.href;
}

async function evaluateWorkflowGraph(): Promise<WorkflowGeneration> {
	// Live host module: both generations must share the layer-1 WeakMap. The
	// binary loader injects the same object via virtualModules; /reload must
	// not re-evaluate `@bastani/atomic` into a second primitive.
	const atomic = await import("@bastani/atomic");
	graphGeneration += 1;
	const cacheKey = `${graphGeneration}:${Date.now()}:${Math.random()}`;
	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		tryNative: false,
		fsCache: extensionLoaderTestHooks.getTranspileCacheDir(),
		alias: hostAliases(),
		virtualModules: { "@bastani/atomic": atomic },
	});

	const loaded = (await jiti.import(cacheBustedHref(graphEntry, cacheKey))) as WorkflowGeneration;
	return loaded;
}

/**
 * The installed Node package uses the loader's on-disk alias for
 * `@bastani/atomic`, so jiti evaluates a host-module copy alongside the native
 * loader that created `pi.events`. This is the release-0.9.15 path; using a
 * virtual module here would conceal the split that lost canonical bus identity.
 */
async function evaluateInstalledWorkflowGraph(): Promise<WorkflowGeneration> {
	graphGeneration += 1;
	const cacheKey = `installed:${graphGeneration}:${Date.now()}:${Math.random()}`;
	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		tryNative: false,
		fsCache: extensionLoaderTestHooks.getTranspileCacheDir(),
		alias: extensionLoaderTestHooks.getAliases(),
	});
	return (await jiti.import(cacheBustedHref(graphEntry, cacheKey))) as WorkflowGeneration;
}

function stageHandle(runId: string, stageId: string): StageControlHandle {
	return {
		runId,
		stageId,
		stageName: stageId,
		status: "running",
		sessionId: undefined,
		sessionFile: undefined,
		isStreaming: false,
		messages: [] as AgentSession["messages"],
		async ensureAttached() {},
		async prompt() {},
		async steer() {},
		async followUp() {},
		async pause() {},
		async resume() {
			return undefined;
		},
		subscribe: () => () => {},
	};
}

function recordGenerationState(
	generation: WorkflowGeneration,
	ids: {
		readonly runId: string;
		readonly stageId: string;
		readonly nodeId: string;
		readonly controller: AbortController;
		readonly toolController: AbortController;
	},
	settled: Promise<void> = Promise.resolve(),
): void {
	generation.store.recordRunStart({
		id: ids.runId,
		name: "reload-survive",
		inputs: {},
		status: "running",
		stages: [],
		startedAt: 1,
	});
	generation.store.recordToolNodeStart(ids.runId, {
		kind: "tool",
		id: ids.nodeId,
		name: "reload-tool",
		argsHash: "reload-tool-hash",
		ordinal: 0,
		parentIds: [],
		status: "pending",
		attachable: false,
	});
	generation.store.recordToolNodeRunning(ids.runId, ids.nodeId, 2);
	generation.stageControlRegistry.register(stageHandle(ids.runId, ids.stageId));
	generation.cancellationRegistry.register(ids.runId, ids.controller);
	generation.toolControlRegistry.register({
		runId: ids.runId,
		nodeId: ids.nodeId,
		name: "reload-tool",
		controller: ids.toolController,
		settled,
	});
	generation.jobTracker.register({
		runId: ids.runId,
		controller: ids.controller,
		promise: settled,
	});
	const adapter = buildStagePromptAdapter(
		"prompt-reload",
		"ask_user_question",
		{ questions: [{ question: "Keep going?", options: [{ label: "Yes" }, { label: "No" }] }] },
		1,
	);
	assert.ok(adapter);
	generation.stageUiBroker.provideStagePrompt(ids.runId, ids.stageId, adapter);
	void generation.stageUiBroker.requestCustomUi(ids.runId, ids.stageId, () => ({
		render: () => [],
		invalidate: () => {},
	}));
}

function assertGenerationSeesRun(
	generation: WorkflowGeneration,
	ids: {
		readonly runId: string;
		readonly stageId: string;
		readonly nodeId: string;
		readonly controller: AbortController;
		readonly toolController: AbortController;
	},
	label: string,
): void {
	assert.equal(generation.store.runs()[0]?.id, ids.runId, `${label}: store`);
	assert.equal(generation.stageControlRegistry.get(ids.runId, ids.stageId)?.stageId, ids.stageId, `${label}: stage`);
	assert.equal(generation.cancellationRegistry.isAborted(ids.runId), false, `${label}: cancellation`);
	assert.equal(generation.toolControlRegistry.get(ids.runId, ids.nodeId)?.name, "reload-tool", `${label}: tool`);
	assert.equal(
		generation.store.runs()[0]?.toolNodes?.find((node) => node.id === ids.nodeId)?.status,
		"running",
		`${label}: live tool node`,
	);
	assert.equal(generation.jobTracker.has(ids.runId), true, `${label}: job`);
	assert.equal(generation.stageUiBroker.peekStagePrompt(ids.runId, ids.stageId)?.id, "prompt-reload", `${label}: ui`);
	assert.equal("abort" in generation.cancellationRegistry, true, `${label}: has`);
}

test(
	"a second evaluation of the workflows module graph over one host scope sees and controls the first generation's run state",
	async () => {
		const bus = createEventBus();
		const widget = createWidgetUi();
		let resolveCallback: (() => void) | undefined;
		let callbackSettlements = 0;
		const callbackSettled = new Promise<void>((resolve) => {
			resolveCallback = resolve;
		}).then(() => {
			callbackSettlements += 1;
		});
		const first = await evaluateWorkflowGraph();
		const firstExtension = await loadExtensionFromFactory(first.factory, repoRoot, bus, createExtensionRuntime());
		await emitSessionEvent(firstExtension, "session_start", { reason: "startup" }, { hasUI: true, ui: widget.ui });
		const ids = {
			runId: "reload-run",
			stageId: "reload-stage",
			nodeId: "reload-node",
			controller: new AbortController(),
			toolController: new AbortController(),
		};
		recordGenerationState(first, ids, callbackSettled);
		const firstFactory = widget.calls.findLast((call) => call.factory !== undefined);
		assert.ok(firstFactory?.factory, "the initial active tool-only run must mount the widget");
		assert.equal(firstFactory.placement, "belowEditor");
		assert.match(firstFactory.factory(undefined, undefined).render(120).join("\n"), /reload-tool · running/);

		await emitSessionEvent(firstExtension, "session_shutdown", { reason: "reload" });
		const second = await evaluateWorkflowGraph();
		assert.notEqual(second.store, first.store, "each evaluation holds its own facade");
		const secondExtension = await loadExtensionFromFactory(second.factory, repoRoot, bus, createExtensionRuntime());
		await emitSessionEvent(secondExtension, "session_start", { reason: "reload" }, { hasUI: true, ui: widget.ui });
		const secondFactory = widget.calls.findLast((call) => call.factory !== undefined);
		assert.ok(secondFactory?.factory, "the replacement generation must remount the active run");
		assert.notEqual(secondFactory, firstFactory);
		assert.match(secondFactory.factory(undefined, undefined).render(120).join("\n"), /reload-tool · running/);
		assert.deepEqual(secondFactory.factory(undefined, undefined).render(60), [" ▾  1 background · 1 ● · 1 tool"]);

		// TEMPORARY WINDOWS DIAGNOSTIC - remove before merge.
		//
		// Three fixes have failed identically on this assertion while linux and
		// macOS stay green, so this prints the facts this machine cannot produce.
		// `store` is the control: it shares correctly, so whatever differs between
		// it and the stage registry is the real fault line.
		{
			const reg1 = first.stageControlRegistry as unknown as Record<string, (...a: unknown[]) => unknown>;
			const reg2 = second.stageControlRegistry as unknown as Record<string, (...a: unknown[]) => unknown>;
			const probe = {
				gen1_still_sees_own_stage: first.stageControlRegistry.get(ids.runId, ids.stageId)?.stageId ?? null,
				gen2_sees_stage: second.stageControlRegistry.get(ids.runId, ids.stageId)?.stageId ?? null,
				gen1_forRun_count: first.stageControlRegistry.forRun(ids.runId).length,
				gen2_forRun_count: second.stageControlRegistry.forRun(ids.runId).length,
				gen1_has_run: typeof reg1.has === "function" ? reg1.has(ids.runId) : "no-has",
				gen2_has_run: typeof reg2.has === "function" ? reg2.has(ids.runId) : "no-has",
				gen1_store_runs: first.store.runs().length,
				gen2_store_runs: second.store.runs().length,
				facades_distinct_store: first.store !== second.store,
				facades_distinct_stagereg: first.stageControlRegistry !== second.stageControlRegistry,
				globalthis_slot_present:
					Reflect.get(globalThis, Symbol.for("atomic-coding-agent/extension-session-state@1")) !== undefined,
				platform: process.platform,
			};
			console.error(`P0-2462-WINDOWS-PROBE ${JSON.stringify(probe)}`);
		}

		assertGenerationSeesRun(second, ids, "second generation");
		assert.ok(resolveCallback);
		resolveCallback();
		await callbackSettled;
		assert.equal(callbackSettlements, 1, "the adopted in-flight callback settles exactly once");
		assert.equal(
			first.store.recordToolNodeEnd(ids.runId, ids.nodeId, {
				status: "completed",
				endedAt: 3,
				resultSummary: '"published"',
			}),
			true,
		);
		assert.equal(second.store.runs()[0]?.toolNodes?.[0]?.status, "completed");
		assert.doesNotMatch(secondFactory.factory(undefined, undefined).render(120).join("\n"), /reload-tool · running/);
		assert.equal(second.cancellationRegistry.abort(ids.runId), true);
		assert.equal(ids.controller.signal.aborted, true);
		assert.equal(second.toolControlRegistry.get(ids.runId, ids.nodeId)?.abort("node").scope, "node");
		assert.equal(ids.toolController.signal.aborted, true);
		assert.equal(second.stageControlRegistry.get(ids.runId, ids.stageId)?.status, "running");
		assert.equal(second.jobTracker.get(ids.runId)?.controller, ids.controller);
		assert.equal(second.stageUiBroker.answerStagePrompt(ids.runId, ids.stageId, { text: "Yes" }), true);
	},
	WORKFLOW_MODULE_GRAPH_RELOAD_TIMEOUT_MS,
);

test(
	"the installed loader path preserves the literal publish watcher across full reload",
	async () => {
		const bus = createEventBus();
		const widget = createWidgetUi();
		const first = await evaluateInstalledWorkflowGraph();
		const firstExtension = await loadExtensionFromFactory(first.factory, repoRoot, bus, createExtensionRuntime());
		await emitSessionEvent(firstExtension, "session_start", { reason: "startup" }, { hasUI: true, ui: widget.ui });

		let resolveWatcher: (() => void) | undefined;
		let callbackSettlements = 0;
		const watcherSettled = new Promise<void>((resolve) => {
			resolveWatcher = resolve;
		}).then(() => {
			callbackSettlements += 1;
		});
		const runId = "publish-release-incident";
		const completedId = "tool:cut-or-reuse-exact-release-tag";
		const watcherId = "tool:watch-exact-publish-action";
		first.store.recordRunStart({
			id: runId,
			name: "resume-publish-release-0-9-15",
			inputs: {},
			status: "running",
			stages: [],
			toolNodes: [],
			startedAt: 1,
		});
		first.store.recordToolNodeStart(runId, {
			kind: "tool",
			id: completedId,
			name: "cut-or-reuse-exact-release-tag",
			argsHash: "release-tag-hash",
			ordinal: 2,
			parentIds: [],
			status: "pending",
			attachable: false,
		});
		first.store.recordToolNodeRunning(runId, completedId, 2);
		first.store.recordToolNodeEnd(runId, completedId, {
			status: "completed",
			endedAt: 3,
			resultSummary: '"6c4024fe88"',
		});
		first.store.recordToolNodeStart(runId, {
			kind: "tool",
			id: watcherId,
			name: "watch-exact-publish-action",
			argsHash: "publish-watcher-hash",
			ordinal: 3,
			parentIds: [],
			status: "pending",
			attachable: false,
		});
		first.store.recordToolNodeRunning(runId, watcherId, 4);
		const runController = new AbortController();
		const toolController = new AbortController();
		first.cancellationRegistry.register(runId, runController);
		first.toolControlRegistry.register({
			runId,
			nodeId: watcherId,
			name: "watch-exact-publish-action",
			controller: toolController,
			settled: watcherSettled,
		});
		first.jobTracker.register({ runId, controller: runController, promise: watcherSettled });
		const initialWidget = widget.calls.findLast((call) => call.factory !== undefined);
		assert.ok(initialWidget?.factory, "the zero-stage run must mount before reload");
		assert.match(initialWidget.factory(undefined, undefined).render(120).join("\n"), /BACKGROUND/);
		const reloadWidgetCallStart = widget.calls.length;

		await emitSessionEvent(firstExtension, "session_shutdown", { reason: "reload" });
		const second = await evaluateInstalledWorkflowGraph();
		const secondExtension = await loadExtensionFromFactory(second.factory, repoRoot, bus, createExtensionRuntime());
		await emitSessionEvent(secondExtension, "session_start", { reason: "reload" }, { hasUI: true, ui: widget.ui });

		const replacementWidget = widget.calls
			.slice(reloadWidgetCallStart)
			.findLast((call) => call.factory !== undefined);
		assert.ok(replacementWidget?.factory, "the adopted active run must remount below the editor");
		assert.notEqual(replacementWidget, initialWidget);
		assert.match(replacementWidget.factory(undefined, undefined).render(120).join("\n"), /BACKGROUND/);

		const adopted = second.store.runs().find((run) => run.id === runId);
		assert.ok(adopted, "the replacement installed generation must adopt the active run store");
		assert.equal(adopted.status, "running");
		assert.equal(adopted.stages.length, 0);
		assert.deepEqual(
			adopted.toolNodes?.map((node) => [node.name, node.status]),
			[
				["cut-or-reuse-exact-release-tag", "completed"],
				["watch-exact-publish-action", "running"],
			],
		);
		assert.equal(second.toolControlRegistry.get(runId, watcherId)?.name, "watch-exact-publish-action");
		assert.equal(second.jobTracker.get(runId)?.promise, watcherSettled);

		assert.ok(resolveWatcher);
		resolveWatcher();
		await watcherSettled;
		assert.equal(callbackSettlements, 1);
		assert.equal(
			first.store.recordToolNodeEnd(runId, watcherId, {
				status: "completed",
				endedAt: 5,
				resultSummary: '"published"',
			}),
			true,
		);
		assert.equal(second.store.runs()[0]?.toolNodes?.[1]?.status, "completed");
	},
	WORKFLOW_MODULE_GRAPH_RELOAD_TIMEOUT_MS,
);

test(
	"without a host scope every singleton stays module-local",
	async () => {
		const first = await evaluateWorkflowGraph();
		const second = await evaluateWorkflowGraph();
		first.adoptWorkflowSessionRunState?.(undefined);
		second.adoptWorkflowSessionRunState?.(undefined);
		const controller = new AbortController();
		recordGenerationState(first, {
			runId: "local-run",
			stageId: "local-stage",
			nodeId: "local-node",
			controller,
			toolController: new AbortController(),
		});
		assert.equal(second.store.runs().length, 0);
		assert.equal(second.stageControlRegistry.get("local-run", "local-stage"), undefined);
		assert.equal(second.cancellationRegistry.abort("local-run"), false);
		assert.equal(second.toolControlRegistry.get("local-run", "local-node"), undefined);
		assert.equal(second.jobTracker.has("local-run"), false);
		assert.equal(second.stageUiBroker.peekStagePrompt("local-run", "local-stage"), undefined);
		assert.equal(controller.signal.aborted, false);
	},
	WORKFLOW_MODULE_GRAPH_RELOAD_TIMEOUT_MS,
);

test(
	"two distinct host scopes stay isolated from each other",
	async () => {
		const scopeA = createEventBus();
		const scopeB = createEventBus();
		const first = await evaluateWorkflowGraph();
		await loadExtensionFromFactory(first.factory, repoRoot, scopeA, createExtensionRuntime());
		recordGenerationState(first, {
			runId: "scope-a",
			stageId: "stage-a",
			nodeId: "node-a",
			controller: new AbortController(),
			toolController: new AbortController(),
		});

		const second = await evaluateWorkflowGraph();
		await loadExtensionFromFactory(second.factory, repoRoot, scopeB, createExtensionRuntime());
		assert.equal(second.store.runs().length, 0, "scope B must not see scope A's run");
		assert.equal(second.jobTracker.has("scope-a"), false);

		const rebound = await evaluateWorkflowGraph();
		await loadExtensionFromFactory(rebound.factory, repoRoot, scopeA, createExtensionRuntime());
		assert.equal(rebound.store.runs()[0]?.id, "scope-a");
		assert.equal(rebound.jobTracker.has("scope-a"), true);
	},
	WORKFLOW_MODULE_GRAPH_RELOAD_TIMEOUT_MS,
);

test(
	"facade-forwarded methods keep their class receiver",
	async () => {
		const bus = createEventBus();
		const first = await evaluateWorkflowGraph();
		await loadExtensionFromFactory(first.factory, repoRoot, bus, createExtensionRuntime());
		const controller = new AbortController();
		first.cancellationRegistry.register("receiver-run", controller);
		first.jobTracker.register({
			runId: "receiver-run",
			controller,
			promise: Promise.resolve(),
		});
		const second = await evaluateWorkflowGraph();
		await loadExtensionFromFactory(second.factory, repoRoot, bus, createExtensionRuntime());
		const { register, isAborted, abort } = second.cancellationRegistry;
		const { has, get } = second.jobTracker;
		assert.equal(isAborted("receiver-run"), false);
		assert.equal(has("receiver-run"), true);
		assert.equal(get("receiver-run")?.controller, controller);
		assert.equal(abort("receiver-run"), true);
		assert.equal(controller.signal.aborted, true);
		assert.doesNotThrow(() => register("receiver-run-2", new AbortController()));
	},
	WORKFLOW_MODULE_GRAPH_RELOAD_TIMEOUT_MS,
);

test("every run-scoped singleton key carries an explicit version suffix", async () => {
	const keyPattern = /["']workflows:[a-z0-9-]+:v\d+["']/;
	for (const [name, path] of Object.entries(SINGLETON_SOURCES)) {
		assert.match(await readText(path), keyPattern, `${name} must declare a versioned session key`);
	}
	const factorySource = await readText(join(workflowsSrc, "extension/extension-factory.ts"));
	assert.match(
		factorySource,
		/function factory\(pi: ExtensionAPI\): void \{\n\tadoptWorkflowSessionRunState\(pi\.events\);/,
		"factory must adopt session run state before building adapters",
	);
});
