/**
 * Regression: a *recoverable* Intercom broker disconnect must not be rendered
 * as a stage-facing failure while lazy re-initialization can still recover.
 *
 * Two boundaries actually reached the workflow-stage UI during Goal run
 * 16a9f7ed-e55a-44b4-b89f-3b63ef9197a2:
 *
 *  1. The host extension-error boundary. `packages/intercom/index.ts` eagerly
 *     awaits `loadHeavy(ctx)` inside its `session_start` handler when the stage
 *     carries a `pendingStageDelivery`. A rejection escaped the handler, so the
 *     host's `runGenericHandlers` caught it and pushed it through
 *     `ExtensionRunner.emitError` to `showExtensionError` (interactive) and
 *     `console.error("Extension error ...")` (print) — painting
 *     "Client disconnected" over a stage that was still running.
 *
 *  2. The lazy event-relay boundary. The `subagent:*` / pending-stage relays
 *     logged `Intercom event relay failed (<event>): Client disconnected`
 *     straight into the stage output for work the user never initiated.
 *
 * `d3910c0818` only silenced Intercom's own "heavy initialization failed" log,
 * which is neither of these channels. These tests drive the real boundaries.
 *
 * The classification is by construction, not by message text: only
 * `IntercomClientDisconnectedError` is treated as recoverable, so protocol,
 * authentication, configuration, non-recoverable initialization, terminal relay
 * failures, and an identically worded plain `Error` all stay actionable.
 */

import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import type { ExtensionAPI, ToolDefinition } from "@bastani/atomic";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, test } from "vitest";
import { runGenericHandlers } from "../../packages/coding-agent/src/core/extensions/runner-events.ts";
import type {
	Extension,
	ExtensionContext,
	ExtensionError,
} from "../../packages/coding-agent/src/core/extensions/types.ts";
import intercom from "../../packages/intercom/index.js";
import { IntercomClientDisconnectedError } from "../../packages/intercom/recoverable-disconnect.js";

const SUBAGENT_RESULT_INTERCOM_EVENT = "subagent:result-intercom";
const SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT = "subagent:result-intercom-delivery";
const PENDING_STAGE_UNDELIVERABLE_EVENT = "atomic:workflow-pending-stage-undeliverable";
const EXTENSION_PATH = "<intercom>";

type HeavyModule = { default: (pi: ExtensionAPI) => void | Promise<void> };
type ImportResult = { error: unknown } | { module: HeavyModule };
type ConsoleErrorCall = [message?: unknown, ...optionalParams: unknown[]];
type ExtensionEventHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
type PiEventListener = (payload: unknown) => void;
type SessionStartEvent = { readonly type: "session_start"; readonly reason: "startup" };

const originalConsoleError = console.error;
let consoleErrorCalls: ConsoleErrorCall[] = [];

beforeEach(() => {
	consoleErrorCalls = [];
	console.error = (...args: ConsoleErrorCall) => {
		consoleErrorCalls.push(args);
	};
});

afterEach(() => {
	console.error = originalConsoleError;
});

/** Console output the workflow stage would have shown for an Intercom relay. */
function relayFailureLogs(): ConsoleErrorCall[] {
	return consoleErrorCalls.filter(
		([message]) => typeof message === "string" && message.startsWith("Intercom event relay failed"),
	);
}

/** A workflow-stage `session_start` context carrying a pending stage delivery. */
function workflowStageContext(): ExtensionContext {
	return {
		cwd: process.cwd(),
		hasUI: true,
		orchestrationContext: {
			kind: "workflow-stage",
			pendingStageDelivery: {
				routeCapability: "test-capability",
				deliverPending: async () => {},
				ready: () => undefined,
			},
		},
	} as never;
}

function successfulHeavyModule(onSessionStart?: (ctx: unknown) => void): HeavyModule {
	return {
		default(heavyPi) {
			if (onSessionStart) heavyPi.on("session_start", (_event, ctx) => onSessionStart(ctx));
			heavyPi.registerTool({
				name: "intercom",
				label: "Intercom",
				description: "test intercom",
				parameters: Type.Object({}),
				async execute() {
					return { content: [{ type: "text", text: "connected" }], details: {} };
				},
			});
		},
	};
}

function fixture(importResults: ImportResult[]) {
	const handlers = new Map<string, ExtensionEventHandler[]>();
	const eventListeners = new Map<string, PiEventListener[]>();
	const tools = new Map<string, ToolDefinition>();
	const emittedPiEvents: Array<{ name: string; payload: unknown }> = [];
	let imports = 0;

	const pi = {
		on(event: string, handler: ExtensionEventHandler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		registerShortcut() {},
		getActiveTools: () => [],
		setActiveTools() {},
		events: {
			on(name: string, listener: PiEventListener) {
				eventListeners.set(name, [...(eventListeners.get(name) ?? []), listener]);
			},
			emit(name: string, payload: unknown) {
				emittedPiEvents.push({ name, payload });
				for (const listener of eventListeners.get(name) ?? []) listener(payload);
			},
		},
	};

	intercom(pi as never, {
		async importHeavy() {
			const result = importResults[imports++];
			assert.ok(result, "each heavy initialization attempt needs a fixture result");
			if ("error" in result) throw result.error;
			return result.module;
		},
	});

	/**
	 * The registered handlers as the host loader stores them, so `session_start`
	 * runs through the real `runGenericHandlers` catch → `emitError` boundary.
	 */
	function hostExtension(): Extension {
		const hostHandlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>();
		for (const [event, registered] of handlers) {
			hostHandlers.set(
				event,
				registered.map((handler) => async (...args: unknown[]) => {
					const [extensionEvent, ctx] = args;
					return await handler(extensionEvent, ctx);
				}),
			);
		}
		return {
			path: EXTENSION_PATH,
			resolvedPath: EXTENSION_PATH,
			sourceInfo: { source: "builtin", scope: "temporary", origin: "top-level" },
			handlers: hostHandlers,
			tools: new Map(),
			messageRenderers: new Map(),
			entryRenderers: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		} as never;
	}

	return {
		get imports() {
			return imports;
		},
		emittedPiEvents,
		/** Drives `session_start` through the host boundary and returns what the UI would show. */
		async emitSessionStart(ctx: ExtensionContext = workflowStageContext()): Promise<ExtensionError[]> {
			const reported: ExtensionError[] = [];
			const event: SessionStartEvent = { type: "session_start", reason: "startup" };
			await runGenericHandlers([hostExtension()], ctx, event as never, (error) => reported.push(error));
			return reported;
		},
		emitPiEvent(name: string, payload: unknown): void {
			for (const listener of eventListeners.get(name) ?? []) listener(payload);
		},
		executeIntercomTool() {
			const tool = tools.get("intercom");
			assert.ok(tool, "intercom tool should be registered");
			return tool.execute("tool-call", { action: "list" }, new AbortController().signal, undefined, {
				hasUI: true,
			} as never);
		},
	};
}

describe("Intercom recoverable disconnect at the workflow-stage UI boundary", () => {
	test("keeps a recoverable stage warm-up disconnect out of the host extension-error channel", async () => {
		const current = fixture([{ error: new IntercomClientDisconnectedError() }]);

		const reported = await current.emitSessionStart();

		assert.deepEqual(reported, []);
		assert.deepEqual(consoleErrorCalls, []);
	});

	test("stays healthy and reconnects on the next call without a restart", async () => {
		const replayedContexts: unknown[] = [];
		const current = fixture([
			{ error: new IntercomClientDisconnectedError() },
			{ module: successfulHeavyModule((ctx) => replayedContexts.push(ctx)) },
		]);

		const reported = await current.emitSessionStart();
		const result = await current.executeIntercomTool();

		assert.deepEqual(reported, []);
		assert.deepEqual(consoleErrorCalls, []);
		assert.equal(current.imports, 2, "the next call retries initialization on its own");
		assert.deepEqual(result, { content: [{ type: "text", text: "connected" }], details: {} });
		assert.equal(
			replayedContexts.length,
			1,
			"the captured session_start is replayed into the recovered heavy module",
		);
	});

	test("still reports a non-recoverable initialization failure to the host", async () => {
		const importError = new Error("Cannot import Intercom heavy module");
		const current = fixture([{ error: importError }]);

		const reported = await current.emitSessionStart();

		assert.equal(reported.length, 1);
		assert.equal(reported[0]?.event, "session_start");
		assert.equal(reported[0]?.extensionPath, EXTENSION_PATH);
		assert.equal(reported[0]?.error, "Cannot import Intercom heavy module");
	});

	test("does not reclassify an identically worded plain error as recoverable", async () => {
		const lookalike = new Error("Client disconnected");
		const current = fixture([{ error: lookalike }]);

		const reported = await current.emitSessionStart();

		assert.equal(reported.length, 1, "classification is by construction, not by message text");
		assert.equal(reported[0]?.error, "Client disconnected");
	});

	test("keeps a user-initiated Intercom call visibly failing on a recoverable disconnect", async () => {
		const disconnect = new IntercomClientDisconnectedError();
		const current = fixture([{ error: disconnect }]);

		await assert.rejects(current.executeIntercomTool(), disconnect);
	});
});

describe("Intercom recoverable disconnect at the lazy event-relay boundary", () => {
	test("keeps 'Intercom event relay failed' out of the stage output while acknowledging the relay", async () => {
		const current = fixture([{ error: new IntercomClientDisconnectedError() }]);

		current.emitPiEvent(SUBAGENT_RESULT_INTERCOM_EVENT, { requestId: "req-1", to: "peer", message: "hi" });
		// One macrotask turn drains the whole relay microtask cascade.
		await tick();

		assert.deepEqual(relayFailureLogs(), []);
		assert.deepEqual(
			current.emittedPiEvents.filter((entry) => entry.name === SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT),
			[
				{
					name: SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT,
					payload: { requestId: "req-1", delivered: false, error: "Client disconnected" },
				},
			],
			"the waiting relay is still acknowledged so nothing hangs on the silenced diagnostic",
		);
	});

	test("classifies a recoverable disconnect wrapped as a cause", async () => {
		// `subagent-relay.ts` and `index-heavy.ts` both rewrap failures with `cause`.
		const wrapped = new Error("Client disconnected", { cause: new IntercomClientDisconnectedError() });
		const current = fixture([{ error: wrapped }]);

		current.emitPiEvent(SUBAGENT_RESULT_INTERCOM_EVENT, { requestId: "req-2" });
		// One macrotask turn drains the whole relay microtask cascade.
		await tick();

		assert.deepEqual(relayFailureLogs(), []);
	});

	test("still reports a terminal relay failure", async () => {
		const terminal = new Error("Intercom protocol error: bad frame");
		const current = fixture([{ error: terminal }]);

		current.emitPiEvent(SUBAGENT_RESULT_INTERCOM_EVENT, { requestId: "req-3" });
		// One macrotask turn drains the whole relay microtask cascade.
		await tick();

		assert.deepEqual(relayFailureLogs(), [
			[`Intercom event relay failed (${SUBAGENT_RESULT_INTERCOM_EVENT}):`, terminal],
		]);
	});

	test("keeps a recoverable pending-stage undeliverable relay silent and unhandled", async () => {
		const current = fixture([{ error: new IntercomClientDisconnectedError() }]);
		const payload: {
			handled?: boolean;
			completion?: Promise<boolean>;
			runId: string;
			senderId: string;
			messageId: string;
			notificationId: string;
			reason: string;
		} = {
			runId: "run-1",
			senderId: "sender-1",
			messageId: "message-1",
			notificationId: "notification-1",
			reason: "stage_never_started",
		};

		current.emitPiEvent(PENDING_STAGE_UNDELIVERABLE_EVENT, payload);
		assert.ok(payload.completion, "the relay claims the event and exposes a completion");

		assert.equal(await payload.completion, false);
		assert.deepEqual(relayFailureLogs(), []);
	});

	test("still reports a terminal pending-stage undeliverable relay failure", async () => {
		const terminal = new Error("Intercom heavy module is unavailable");
		const current = fixture([{ error: terminal }]);
		const payload: {
			handled?: boolean;
			completion?: Promise<boolean>;
			runId: string;
			senderId: string;
			messageId: string;
			notificationId: string;
			reason: string;
		} = {
			runId: "run-2",
			senderId: "sender-2",
			messageId: "message-2",
			notificationId: "notification-2",
			reason: "stage_never_started",
		};

		current.emitPiEvent(PENDING_STAGE_UNDELIVERABLE_EVENT, payload);
		assert.ok(payload.completion);

		assert.equal(await payload.completion, false);
		assert.deepEqual(relayFailureLogs(), [
			[`Intercom event relay failed (${PENDING_STAGE_UNDELIVERABLE_EVENT}):`, terminal],
		]);
	});
});
