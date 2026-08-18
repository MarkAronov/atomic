import assert from "node:assert/strict";
import { test } from "vitest";
import { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import type { RpcEvent } from "../../packages/coding-agent/src/modes/rpc/rpc-types.ts";
import { createHarness, type Harness } from "../../packages/coding-agent/test/suite/harness.ts";

function servicesFor(harness: Harness) {
	return {
		cwd: harness.tempDir,
		agentDir: harness.tempDir,
		modelRuntime: harness.session.modelRuntime,
		settingsManager: harness.settingsManager,
		resourceLoader: harness.session.resourceLoader,
		diagnostics: [],
	};
}

function createClearQueueClient() {
	let eventListener: ((event: RpcEvent) => void) | undefined;
	const clearRequest = Promise.withResolvers<void>();
	let clearCalls = 0;
	const client = {
		onEvent(listener: (event: RpcEvent) => void) {
			eventListener = listener;
			return () => {
				if (eventListener === listener) eventListener = undefined;
			};
		},
		onGenerationEnded: () => () => {},
		requestInternal<T>(command: { type: string }): Promise<T> {
			if (command.type === "clear_queue") {
				clearCalls += 1;
				return clearRequest.promise as Promise<T>;
			}
			return Promise.resolve(undefined as T);
		},
		stop: async () => {},
		restart: async () => {},
	};
	return {
		client,
		emit(event: RpcEvent): void {
			eventListener?.(event);
		},
		reject(error: Error): void {
			clearRequest.reject(error);
		},
		get clearCalls(): number {
			return clearCalls;
		},
	};
}

async function createRuntime(
	harness: Harness,
	client: ReturnType<typeof createClearQueueClient>["client"],
): Promise<IsolatedInteractiveRuntime> {
	const localRuntime = new AgentSessionRuntime(harness.session, servicesFor(harness), async () => {
		throw new Error("unused runtime factory");
	});
	return new IsolatedInteractiveRuntime(
		localRuntime,
		async () => {
			throw new Error("unused isolated runtime factory");
		},
		client as never,
	);
}

test("clearQueue restores its snapshot before messages admitted after the local clear", async () => {
	const harness = await createHarness();
	try {
		const probe = createClearQueueClient();
		const runtime = await createRuntime(harness, probe.client);
		const session = runtime.session;
		probe.emit({ type: "queue_update", steering: ["before steer"], followUp: ["before follow-up"] });

		const returned = session.clearQueue();
		assert.deepEqual(returned, { steering: ["before steer"], followUp: ["before follow-up"] });
		assert.deepEqual(session.getSteeringMessages(), []);
		assert.deepEqual(session.getFollowUpMessages(), []);
		assert.equal(probe.clearCalls, 1);

		probe.emit({ type: "queue_update", steering: ["admitted steer"], followUp: ["admitted follow-up"] });
		probe.reject(new Error("engine unavailable"));
		await Promise.resolve();
		await Promise.resolve();

		assert.deepEqual(session.getSteeringMessages(), ["before steer", "admitted steer"]);
		assert.deepEqual(session.getFollowUpMessages(), ["before follow-up", "admitted follow-up"]);
	} finally {
		harness.cleanup();
	}
});
