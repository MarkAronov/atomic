import { describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { InteractiveEngineMonitor } from "../src/modes/interactive-engine/engine-monitor.ts";
import {
	INTERACTIVE_ENGINE_PROTOCOL_VERSION,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineMessage,
} from "../src/modes/interactive-engine/protocol.ts";
import { createRpcCommandHandler } from "../src/modes/rpc/rpc-command-handler.ts";
import { RpcSessionBinding } from "../src/modes/rpc/rpc-session-binding.ts";
import { createHarness } from "./suite/harness.ts";

function frame(message: Parameters<typeof serializeInteractiveEngineMessage>[0]): string {
	return serializeInteractiveEngineMessage(message).trimEnd();
}

describe("interactive engine resource readiness", () => {
	it("keeps binding separate from optional resource readiness", async () => {
		const monitor = new InteractiveEngineMonitor(vi.fn(), vi.fn());
		let resourcesReady = false;
		void monitor.waitUntilResourcesReady().then(() => {
			resourcesReady = true;
		});

		expect(
			monitor.handleLine(
				frame({ type: "engine_ready", protocolVersion: INTERACTIVE_ENGINE_PROTOCOL_VERSION, pid: 123 }),
			),
		).toBe(true);
		expect(monitor.handleLine(frame({ type: "engine_bound" }))).toBe(true);
		await monitor.waitUntilBound();
		await Promise.resolve();
		expect(resourcesReady).toBe(false);

		expect(monitor.handleLine(frame({ type: "engine_resources_ready" }))).toBe(true);
		await expect(monitor.waitUntilResourcesReady()).resolves.toBeUndefined();
	});

	it("rejects the generation resource gate when transactional loading fails", async () => {
		const monitor = new InteractiveEngineMonitor(vi.fn(), vi.fn());
		const readiness = monitor.waitUntilResourcesReady();

		expect(monitor.handleLine(frame({ type: "engine_resources_failed", message: "workflow load failed" }))).toBe(
			true,
		);
		await expect(readiness).rejects.toThrow("workflow load failed");
	});

	it("gates child-side prompts and dispatches them through the current session", async () => {
		const harness = await createHarness();
		const replacement = await createHarness();
		let releaseResources!: () => void;
		const waitForResources = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					releaseResources = resolve;
				}),
		);
		const stalePrompt = vi.spyOn(harness.session, "prompt").mockImplementation(async (_text, options) => {
			options?.preflightResult?.(true);
		});
		const replacementPrompt = vi.spyOn(replacement.session, "prompt").mockImplementation(async (_text, options) => {
			options?.preflightResult?.(true);
		});
		let currentSession = harness.session;
		const output = vi.fn();
		const runtime = new AgentSessionRuntime(
			harness.session,
			{ cwd: harness.tempDir, agentDir: harness.tempDir } as never,
			async () => {
				throw new Error("unused runtime factory");
			},
		);
		const handle = createRpcCommandHandler({
			runtimeHost: runtime,
			getSession: () => currentSession,
			rebindSession: async () => {},
			output,
			waitForResources,
		});

		try {
			await expect(handle({ id: "first", type: "prompt", message: "hello" })).resolves.toBeUndefined();
			await Promise.resolve();
			expect(waitForResources).toHaveBeenCalledTimes(1);
			expect(stalePrompt).not.toHaveBeenCalled();
			expect(replacementPrompt).not.toHaveBeenCalled();

			currentSession = replacement.session;
			releaseResources();
			await vi.waitFor(() => expect(replacementPrompt).toHaveBeenCalledWith("hello", expect.any(Object)));
			expect(stalePrompt).not.toHaveBeenCalled();
			expect(output).toHaveBeenCalledWith(expect.objectContaining({ id: "first", success: true }));
		} finally {
			harness.cleanup();
			replacement.cleanup();
		}
	});

	it("holds resource-dependent control commands and reacquires the current session", async () => {
		const harness = await createHarness();
		const replacement = await createHarness();
		let releaseResources!: () => void;
		const waitForResources = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					releaseResources = resolve;
				}),
		);
		const staleReload = vi.spyOn(harness.session, "reload").mockResolvedValue();
		const replacementReload = vi.spyOn(replacement.session, "reload").mockResolvedValue();
		let currentSession = harness.session;
		const runtime = new AgentSessionRuntime(
			harness.session,
			{ cwd: harness.tempDir, agentDir: harness.tempDir } as never,
			async () => {
				throw new Error("unused runtime factory");
			},
		);
		const handle = createRpcCommandHandler({
			runtimeHost: runtime,
			getSession: () => currentSession,
			rebindSession: async () => {},
			output: vi.fn(),
			waitForResources,
		});

		try {
			const reload = handle({ id: "reload", type: "reload" });
			await Promise.resolve();
			expect(staleReload).not.toHaveBeenCalled();
			expect(replacementReload).not.toHaveBeenCalled();

			currentSession = replacement.session;
			releaseResources();
			await expect(reload).resolves.toMatchObject({ success: true });
			expect(staleReload).not.toHaveBeenCalled();
			expect(replacementReload).toHaveBeenCalledTimes(1);
		} finally {
			harness.cleanup();
			replacement.cleanup();
		}
	});

	it("allows only explicitly partial startup metadata through the resource gate", async () => {
		const harness = await createHarness();
		const waitForResources = vi.fn(async () => {});
		const runtime = new AgentSessionRuntime(
			harness.session,
			{ cwd: harness.tempDir, agentDir: harness.tempDir } as never,
			async () => {
				throw new Error("unused runtime factory");
			},
		);
		const handle = createRpcCommandHandler({
			runtimeHost: runtime,
			getSession: () => harness.session,
			rebindSession: async () => {},
			output: vi.fn(),
			waitForResources,
		});

		try {
			await handle({ id: "state", type: "get_state" });
			await handle({ id: "catalog", type: "get_available_models", allowPartialResources: true });
			expect(waitForResources).not.toHaveBeenCalled();

			await handle({ id: "user-catalog", type: "get_available_models" });
			expect(waitForResources).toHaveBeenCalledTimes(1);
		} finally {
			harness.cleanup();
		}
	});

	it("fails deferred readiness when any extension did not load", async () => {
		const harness = await createHarness();
		const output = vi.fn();
		const runtime = new AgentSessionRuntime(
			harness.session,
			{ cwd: harness.tempDir, agentDir: harness.tempDir } as never,
			async () => {
				throw new Error("unused runtime factory");
			},
		);
		const reload = vi.spyOn(harness.session, "reload").mockRejectedValue(new Error("workflow load failed"));
		const extensionRuntime = harness.session.resourceLoader.getExtensions().runtime;
		vi.spyOn(harness.session.resourceLoader, "getExtensions").mockReturnValue({
			extensions: [],
			errors: [{ path: "builtin/workflows", error: "workflow load failed" }],
			runtime: extensionRuntime,
		} as never);
		const binding = new RpcSessionBinding({
			runtimeHost: runtime,
			output,
			pendingExtensionRequests: new Map(),
			requestShutdown: () => {},
		});

		try {
			await expect(binding.loadDeferredResources()).rejects.toThrow("workflow load failed");
			expect(reload).toHaveBeenCalledWith({ reason: "startup", failOnExtensionErrors: true });
			expect(output).toHaveBeenCalledWith(
				expect.objectContaining({ type: "extension_error", extensionPath: "builtin/workflows" }),
			);
		} finally {
			harness.cleanup();
		}
	});

	it("rejects malformed resource lifecycle messages", () => {
		expect(parseInteractiveEngineMessage('{"type":"engine_resources_failed"}')).toBeUndefined();
		expect(parseInteractiveEngineMessage('{"type":"engine_resources_ready","message":"unexpected"}')).toEqual({
			type: "engine_resources_ready",
		});
	});
});
