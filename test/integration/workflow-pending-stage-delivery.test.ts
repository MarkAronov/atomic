import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, test } from "vitest";

const RUN_ID = "4ac72924-c452-4e5f-9e63-2435722109f7";
const GROUP = `workflow:${RUN_ID}`;
const TARGET = `${RUN_ID}:reviewer`;
const OWNER_DISCOVERY_BUDGET_MS = 2_000;
const repoRoot = resolve(import.meta.dirname, "../..");
const extensionDir = join(repoRoot, "packages/intercom");
const agentDir = mkdtempSync(join(tmpdir(), "pending-stage-"));
const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const previousLegacyAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CODING_AGENT_DIR;

const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");
const { default: intercom } = await import("../../packages/intercom/index.js");
const { InMemoryDurableBackend } = await import("../../packages/workflows/src/durable/backend.js");
const { setDurableBackend } = await import("../../packages/workflows/src/durable/factory.js");
const { registerPendingStageIntercomBridge } = await import(
	"../../packages/workflows/src/extension/pending-stage-intercom.js"
);
const { createWorkflowPendingStageDelivery } = await import(
	"../../packages/workflows/src/runs/foreground/pending-stage-delivery.js"
);
const { createStore } = await import("../../packages/workflows/src/shared/store.js");

interface TestContext {
	hasUI: boolean;
	cwd: string;
	isIdle(): boolean;
	model: { id: string };
	orchestrationContext: {
		intercomGroup: string;
		kind?: "workflow-stage";
		workflowRunId?: string;
		workflowStageId?: string;
		workflowStageName?: string;
		pendingStageDelivery?: ReturnType<typeof createWorkflowPendingStageDelivery>;
	};
	sessionManager: { getSessionId(): string };
	ui: {
		confirm(): Promise<boolean>;
		notify(): void;
	};
}

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details: {
		delivered?: boolean;
		position?: number;
		queued?: boolean;
		runId?: string;
		stageKey?: string;
		messageId?: string;
		refusal?: string;
	};
	isError: boolean;
}

interface InjectedMessage {
	customType?: string;
	content?: string;
	details?: {
		from?: { id?: string; name?: string };
		message?: { id?: string; timestamp?: number };
	};
}

interface InjectedMessageOptions {
	deliverAs?: "followUp";
	stageAdmissionKey?: string;
	triggerTurn?: boolean;
}

interface CapturedTool {
	name: string;
	execute?: (
		toolCallId: string,
		params: { action: string; message?: string; to?: string },
		signal: undefined,
		onUpdate: undefined,
		ctx: TestContext,
	) => Promise<ToolResult>;
}

type LifecycleHandler = (event: Record<string, object | string>, ctx: TestContext) => void | Promise<void>;
type EventHandler = (payload: object) => void | Promise<void>;

function extensionFixture(
	sessionId: string,
	initialName: string,
	pendingStageDelivery?: ReturnType<typeof createWorkflowPendingStageDelivery>,
	intercomGroup = GROUP,
) {
	const lifecycleHandlers = new Map<string, LifecycleHandler[]>();
	const eventHandlers = new Map<string, EventHandler[]>();
	const tools = new Map<string, CapturedTool>();
	const injectedMessages: InjectedMessage[] = [];
	const injectedOptions: Array<InjectedMessageOptions | undefined> = [];
	const injectedWaiters: Array<{ count: number; resolve(): void }> = [];
	const resolveInjectedWaiters = (): void => {
		for (let index = injectedWaiters.length - 1; index >= 0; index -= 1) {
			const waiter = injectedWaiters[index]!;
			if (injectedMessages.length < waiter.count) continue;
			injectedWaiters.splice(index, 1);
			waiter.resolve();
		}
	};
	let sessionName = initialName;
	let activeTools: string[] = [];
	const context: TestContext = {
		hasUI: false,
		cwd: repoRoot,
		isIdle: () => true,
		model: { id: "test-model" },
		orchestrationContext: pendingStageDelivery
			? {
					intercomGroup,
					kind: "workflow-stage",
					workflowRunId: RUN_ID,
					workflowStageId: "reviewer-id",
					workflowStageName: "reviewer",
					pendingStageDelivery,
				}
			: { intercomGroup },
		sessionManager: { getSessionId: () => sessionId },
		ui: {
			confirm: async () => true,
			notify() {},
		},
	};
	const pi = {
		on(name: string, handler: LifecycleHandler) {
			const handlers = lifecycleHandlers.get(name) ?? [];
			handlers.push(handler);
			lifecycleHandlers.set(name, handlers);
		},
		registerTool(tool: CapturedTool) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		appendEntry() {},
		async sendMessage(message: InjectedMessage, options?: InjectedMessageOptions) {
			injectedMessages.push(message);
			injectedOptions.push(options);
			resolveInjectedWaiters();
		},
		async sendMessages(messages: InjectedMessage[], options?: InjectedMessageOptions) {
			injectedMessages.push(...messages);
			injectedOptions.push(...messages.map(() => options));
			resolveInjectedWaiters();
		},
		getSessionName: () => sessionName,
		setSessionName(name: string) {
			sessionName = name;
		},
		getActiveTools: () => activeTools,
		setActiveTools(next: string[]) {
			activeTools = next;
		},
		events: {
			on(name: string, handler: EventHandler) {
				const handlers = eventHandlers.get(name) ?? [];
				handlers.push(handler);
				eventHandlers.set(name, handlers);
				return () =>
					eventHandlers.set(
						name,
						(eventHandlers.get(name) ?? []).filter((candidate) => candidate !== handler),
					);
			},
			emit(name: string, payload: object) {
				for (const handler of eventHandlers.get(name) ?? []) void handler(payload);
			},
		},
	};
	const fire = async (name: string, event: Record<string, object | string>): Promise<void> => {
		for (const handler of lifecycleHandlers.get(name) ?? []) await handler(event, context);
	};
	return {
		context,
		pi,
		injectedMessages,
		injectedOptions,
		tools,
		waitForInjectedCount(count: number): Promise<void> {
			if (injectedMessages.length >= count) return Promise.resolve();
			return new Promise((resolveWaiter) => injectedWaiters.push({ count, resolve: resolveWaiter }));
		},
		start: () => fire("session_start", { type: "session_start", reason: "startup" }),
		shutdown: () => fire("session_shutdown", { type: "session_shutdown", reason: "quit" }),
	};
}

async function waitForBroker(socketPath: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const connected = await new Promise<boolean>((resolveConnected) => {
			const probe = net.createConnection(socketPath);
			probe.once("connect", () => {
				probe.destroy();
				resolveConnected(true);
			});
			probe.once("error", () => resolveConnected(false));
		});
		if (connected) return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
	}
	throw new Error("Broker socket did not become ready");
}

async function executeIntercom(
	fixture: ReturnType<typeof extensionFixture>,
	params: { action: string; message?: string; to?: string },
): Promise<ToolResult> {
	const execute = fixture.tools.get("intercom")?.execute;
	assert.ok(execute);
	return execute("test-call", params, undefined, undefined, fixture.context);
}

let broker: ChildProcess | undefined;

beforeAll(async () => {
	broker = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: undefined },
		stdio: "ignore",
	});
	await waitForBroker(getBrokerSocketPath());
});

afterAll(() => {
	broker?.kill("SIGTERM");
	setDurableBackend(undefined);
	if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
	if (previousLegacyAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousLegacyAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

test("one composite workflow-stage target transitions atomically from durable queueing to live delivery", async () => {
	const store = createStore();
	const backend = new InMemoryDurableBackend();
	setDurableBackend(backend);
	const owner = extensionFixture("owner-runtime-session", "workflow-owner", undefined, "default");
	const sender = extensionFixture("sender-runtime-session", "stage-a");
	intercom(owner.pi as never);
	const disposeBridge = registerPendingStageIntercomBridge(owner.pi as never, store);
	intercom(sender.pi as never);
	let reviewer: ReturnType<typeof extensionFixture> | undefined;

	try {
		await owner.start();
		store.recordRunStart({
			id: RUN_ID,
			name: "flow",
			inputs: {},
			status: "running",
			stages: [{ id: "reviewer-id", name: "reviewer", status: "pending", parentIds: [], toolEvents: [] }],
			startedAt: 1,
		});
		backend.registerWorkflow({ workflowId: RUN_ID, name: "flow", inputs: {}, status: "running", createdAt: 1 });
		await sender.start();

		const discoveryDeadline = Date.now() + OWNER_DISCOVERY_BUDGET_MS;
		while (Date.now() < discoveryDeadline) {
			const listed = await executeIntercom(sender, { action: "list" });
			if (listed.content.some(({ text }) => text.includes("workflow-owner"))) break;
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
		}

		const unknown = await executeIntercom(sender, {
			action: "send",
			to: `${RUN_ID}:unknown-stage`,
			message: "This target does not exist.",
		});
		assert.match(unknown.content[0]?.text ?? "", /Session not found/);
		assert.equal(unknown.details.delivered, false);
		assert.deepEqual(store.pendingStageMessagesFor(RUN_ID, "unknown-stage"), []);

		const ask = await executeIntercom(sender, {
			action: "ask",
			to: TARGET,
			message: "Can you reply before starting?",
		});
		assert.match(ask.content[0]?.text ?? "", /Use send/);
		assert.equal(ask.details.refusal, "pending_stage_ask_unsupported");
		assert.deepEqual(store.pendingStageMessagesFor(RUN_ID, "reviewer"), []);

		const workflowSessions = await executeIntercom(sender, { action: "list" });
		assert.equal(
			workflowSessions.content.some(({ text }) => text.includes("workflow-owner")),
			false,
		);
		const ordinaryOwnerSend = await executeIntercom(sender, {
			action: "send",
			to: "workflow-owner",
			message: "Must not use the route-registration membership window.",
		});
		assert.match(ordinaryOwnerSend.content[0]?.text ?? "", /Session not found/);
		assert.equal(ordinaryOwnerSend.details.delivered, false);

		const result = await executeIntercom(sender, {
			action: "send",
			to: TARGET,
			message: "Scope changed: preserve raw amendments.",
		});
		assert.match(result.content[0]?.text ?? "", /queued/i);
		assert.equal(result.isError, false);
		assert.deepEqual(result.details, {
			messageId: result.details.messageId,
			delivered: false,
			queued: true,
			runId: RUN_ID,
			stageKey: "reviewer",
			position: 1,
		});
		assert.equal(store.pendingStageMessagesFor(RUN_ID, "reviewer").length, 1);
		assert.equal(store.pendingStageMessagesFor(RUN_ID, "reviewer")[0]?.id, result.details.messageId);

		const pendingStageDelivery = createWorkflowPendingStageDelivery(store, RUN_ID, "reviewer-id", "reviewer");
		let signalDrainEntered!: () => void;
		let releaseDrain!: () => void;
		const drainEntered = new Promise<void>((resolveEntered) => {
			signalDrainEntered = resolveEntered;
		});
		const drainRelease = new Promise<void>((resolveRelease) => {
			releaseDrain = resolveRelease;
		});
		const heldPendingStageDelivery: ReturnType<typeof createWorkflowPendingStageDelivery> = {
			routeCapability: pendingStageDelivery.routeCapability,
			async deliverPending(deliver) {
				signalDrainEntered();
				await drainRelease;
				await pendingStageDelivery.deliverPending(deliver);
			},
			ready: () => pendingStageDelivery.ready(),
		};
		reviewer = extensionFixture("reviewer-runtime-session", "reviewer", heldPendingStageDelivery);
		intercom(reviewer.pi as never);
		const reviewerStart = reviewer.start();
		await drainEntered;

		const transition = await executeIntercom(sender, {
			action: "send",
			to: TARGET,
			message: "Transition message while pending delivery is draining.",
		});
		releaseDrain();
		await reviewerStart;
		assert.equal(transition.isError, false);
		assert.equal(transition.details.delivered, true);
		assert.equal(transition.details.queued, undefined);

		assert.equal(reviewer.injectedMessages.length, 2);
		const pendingMessageIndex = reviewer.injectedMessages.findIndex(({ content }) =>
			content?.includes("Scope changed: preserve raw amendments."),
		);
		assert.notEqual(pendingMessageIndex, -1);
		assert.equal(reviewer.injectedOptions[pendingMessageIndex]?.triggerTurn, undefined);
		assert.equal(reviewer.injectedOptions[pendingMessageIndex]?.deliverAs, undefined);
		assert.equal(
			reviewer.injectedMessages.filter(({ content }) => content?.includes("Scope changed: preserve raw amendments."))
				.length,
			1,
		);
		assert.equal(
			reviewer.injectedMessages.filter(({ content }) =>
				content?.includes("Transition message while pending delivery is draining."),
			).length,
			1,
		);
		assert.equal(reviewer.injectedMessages[pendingMessageIndex]?.details?.from?.name, "stage-a");
		assert.equal(typeof reviewer.injectedMessages[pendingMessageIndex]?.details?.message?.timestamp, "number");
		assert.equal(store.runs()[0]?.pendingStageMessages?.length, 1);
		assert.equal(store.runs()[0]?.pendingStageMessages?.[0]?.status, "delivered");

		const live = await executeIntercom(sender, {
			action: "send",
			to: TARGET,
			message: "Live message after initialization.",
		});
		assert.equal(live.isError, false);
		assert.equal(live.details.delivered, true);
		assert.equal(live.details.queued, undefined);
		await reviewer.waitForInjectedCount(3);
		assert.equal(
			reviewer.injectedMessages.filter(({ content }) => content?.includes("Live message after initialization."))
				.length,
			1,
		);
		assert.equal(store.runs()[0]?.pendingStageMessages?.length, 1);

		const unknownAfterInitialization = await executeIntercom(sender, {
			action: "send",
			to: `${RUN_ID}:unknown-stage`,
			message: "This target still does not exist.",
		});
		assert.match(unknownAfterInitialization.content[0]?.text ?? "", /Session not found/);
		assert.equal(unknownAfterInitialization.details.delivered, false);
		assert.deepEqual(store.pendingStageMessagesFor(RUN_ID, "unknown-stage"), []);
	} finally {
		if (reviewer !== undefined) await reviewer.shutdown();
		disposeBridge();
		await sender.shutdown();
		await owner.shutdown();
	}
});
