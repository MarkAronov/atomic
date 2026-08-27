import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentSession, CreateAgentSessionOptions } from "@bastani/atomic";
import { Type } from "typebox";
import { afterAll, beforeAll, test } from "vitest";
import type { WorkflowStageAdmissionBoundary } from "../../packages/coding-agent/src/core/workflow-stage-admission.ts";
import type { BrokerMessage } from "../../packages/intercom/types.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { createMockSdk } from "../unit/durable-dbos-backend-helpers.js";

const RUN_ID = "4ac72924-c452-4e5f-9e63-2435722109f7";
const GROUP = `workflow:${RUN_ID}`;
const TARGET = `${RUN_ID}:reviewer`;
const BROKER_FRAME_TIMEOUT_MS = 5_000;
const BROKER_STARTUP_TIMEOUT_MS = 10_000;
const BROKER_SHUTDOWN_TIMEOUT_MS = 5_000;
const repoRoot = resolve(import.meta.dirname, "../..");
const extensionDir = join(repoRoot, "packages/intercom");
const agentDir = mkdtempSync(join(tmpdir(), "pending-stage-"));
const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const previousLegacyAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CODING_AGENT_DIR;

const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
const { createMessageReader, writeMessage } = await import("../../packages/intercom/broker/framing.js");
const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");
const { default: intercom } = await import("../../packages/intercom/index.js");
const { default: intercomHeavy } = await import("../../packages/intercom/index-heavy.js");
const { InMemoryDurableBackend } = await import("../../packages/workflows/src/durable/backend.js");
const { DbosDurableBackend } = await import("../../packages/workflows/src/durable/dbos-backend.js");
const { setDurableBackend } = await import("../../packages/workflows/src/durable/factory.js");
const { WorkflowStageAdmissionBoundary: StageAdmissionBoundary } = await import(
	"../../packages/coding-agent/src/core/workflow-stage-admission.ts"
);
const { registerPendingStageIntercomBridge } = await import(
	"../../packages/workflows/src/extension/pending-stage-intercom.js"
);
const { workflow } = await import("../../packages/workflows/src/authoring/workflow.js");
const { run } = await import("../../packages/workflows/src/runs/foreground/executor.js");
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
		messageAdmission?: {
			readonly boundary: WorkflowStageAdmissionBoundary;
			readonly extensionState: Map<string, object>;
			isOpen(): boolean;
		};
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
	orchestrationContext?: TestContext["orchestrationContext"],
) {
	const lifecycleHandlers = new Map<string, LifecycleHandler[]>();
	const eventHandlers = new Map<string, EventHandler[]>();
	const eventCompletions = new Map<string, Promise<void>>();
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
		orchestrationContext:
			orchestrationContext ??
			(pendingStageDelivery
				? {
						intercomGroup,
						kind: "workflow-stage",
						workflowRunId: RUN_ID,
						workflowStageId: "reviewer-id",
						workflowStageName: "reviewer",
						pendingStageDelivery,
					}
				: { intercomGroup }),
		sessionManager: { getSessionId: () => sessionId },
		ui: {
			confirm: async () => true,
			notify() {},
		},
	};
	const recordInjected = (messages: readonly InjectedMessage[], options: InjectedMessageOptions | undefined): void => {
		injectedMessages.push(...messages);
		injectedOptions.push(...messages.map(() => options));
		resolveInjectedWaiters();
	};
	const admitInjected = async (
		messages: readonly InjectedMessage[],
		options: InjectedMessageOptions | undefined,
	): Promise<void> => {
		const boundary = context.orchestrationContext.messageAdmission?.boundary;
		if (boundary === undefined || options?.stageAdmissionKey === undefined) {
			recordInjected(messages, options);
			return;
		}
		await boundary.admit(
			options.stageAdmissionKey,
			() => recordInjected(messages, options),
			() => {
				throw new Error("workflow stage admission was sealed before pre-start delivery");
			},
		).completion;
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
			await admitInjected([message], options);
		},
		async sendMessages(messages: InjectedMessage[], options?: InjectedMessageOptions) {
			await admitInjected(messages, options);
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
				const completion = (payload as { completion?: Promise<void> }).completion;
				if (completion !== undefined) eventCompletions.set(name, completion);
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
		waitForEventCompletion(name: string): Promise<void> {
			const completion = eventCompletions.get(name);
			assert.ok(completion, `Expected ${name} to expose a completion promise`);
			return completion;
		},
		start: () => fire("session_start", { type: "session_start", reason: "startup" }),
		shutdown: () => fire("session_shutdown", { type: "session_shutdown", reason: "quit" }),
	};
}

async function waitForBroker(child: ChildProcess): Promise<void> {
	await new Promise<void>((resolveReady, rejectReady) => {
		let stdout = "";
		const finish = (error?: Error): void => {
			clearTimeout(timer);
			child.stdout?.off("data", onStdout);
			child.off("exit", onExit);
			if (error === undefined) resolveReady();
			else rejectReady(error);
		};
		const onStdout = (chunk: Buffer | string): void => {
			stdout += chunk.toString();
			if (stdout.includes("Intercom broker started")) finish();
		};
		const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
			finish(new Error(`Intercom broker exited before readiness (code=${String(code)}, signal=${String(signal)})`));
		};
		const timer = setTimeout(
			() => finish(new Error(`Intercom broker did not become ready within ${BROKER_STARTUP_TIMEOUT_MS}ms`)),
			BROKER_STARTUP_TIMEOUT_MS,
		);
		child.stdout?.on("data", onStdout);
		child.once("exit", onExit);
	});
}

async function executeIntercom(
	fixture: ReturnType<typeof extensionFixture>,
	params: { action: string; message?: string; to?: string },
): Promise<ToolResult> {
	const execute = fixture.tools.get("intercom")?.execute;
	assert.ok(execute);
	return execute("test-call", params, undefined, undefined, fixture.context);
}

interface BrokerFrameWaiter {
	readonly type: BrokerMessage["type"];
	readonly matches: (message: BrokerMessage) => boolean;
	readonly resolve: (message: BrokerMessage) => void;
	readonly reject: (error: Error) => void;
	readonly timer: NodeJS.Timeout;
}

class RawBrokerClient {
	readonly socket = net.createConnection(getBrokerSocketPath());
	readonly received: BrokerMessage[] = [];
	private readonly consumed = new Set<number>();
	private readonly waiters = new Set<BrokerFrameWaiter>();

	constructor() {
		this.socket.on(
			"data",
			createMessageReader(
				(message) => {
					this.received.push(message as BrokerMessage);
					this.resolveWaiters();
				},
				(error) => this.socket.destroy(error),
			),
		);
		this.socket.on("error", (error) => this.rejectWaiters(error));
		this.socket.on("close", () => this.rejectWaiters(new Error("Broker client closed")));
	}

	async register(name: string, group: string): Promise<void> {
		if (this.socket.connecting) await new Promise<void>((resolve) => this.socket.once("connect", resolve));
		writeMessage(this.socket, {
			type: "register",
			session: { name, group, cwd: repoRoot, model: "test", pid: 1, startedAt: 1, lastActivity: 1 },
		});
		await this.next("registered");
	}

	send(message: unknown): void {
		writeMessage(this.socket, message as never);
	}

	async next<T extends BrokerMessage["type"]>(
		type: T,
		matches: (message: Extract<BrokerMessage, { type: T }>) => boolean = () => true,
	): Promise<Extract<BrokerMessage, { type: T }>> {
		const buffered = this.consume(type, (message) => matches(message as Extract<BrokerMessage, { type: T }>));
		if (buffered !== undefined) return buffered as Extract<BrokerMessage, { type: T }>;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters.delete(waiter);
				reject(new Error(`Timed out waiting for broker frame ${type}`));
			}, BROKER_FRAME_TIMEOUT_MS);
			const waiter: BrokerFrameWaiter = {
				type,
				matches: (message) => matches(message as Extract<BrokerMessage, { type: T }>),
				resolve: (message) => resolve(message as Extract<BrokerMessage, { type: T }>),
				reject,
				timer,
			};
			this.waiters.add(waiter);
			this.resolveWaiters();
		});
	}

	async close(): Promise<void> {
		if (this.socket.destroyed) return;
		await new Promise<void>((resolve) => {
			this.socket.once("close", resolve);
			this.socket.destroy();
		});
	}

	private consume(
		type: BrokerMessage["type"],
		matches: (message: BrokerMessage) => boolean,
	): BrokerMessage | undefined {
		const index = this.received.findIndex(
			(message, candidate) => !this.consumed.has(candidate) && message.type === type && matches(message),
		);
		if (index < 0) return undefined;
		this.consumed.add(index);
		return this.received[index];
	}

	private resolveWaiters(): void {
		for (const waiter of this.waiters) {
			const message = this.consume(waiter.type, waiter.matches);
			if (message === undefined) continue;
			this.waiters.delete(waiter);
			clearTimeout(waiter.timer);
			waiter.resolve(message);
		}
	}

	private rejectWaiters(error: Error): void {
		for (const waiter of this.waiters) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		this.waiters.clear();
	}
}

const rawClients = new Set<RawBrokerClient>();
let broker: ChildProcess | undefined;

beforeAll(async () => {
	broker = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: undefined },
		stdio: ["ignore", "pipe", "pipe"],
	});
	await waitForBroker(broker);
});

afterAll(async () => {
	await Promise.all([...rawClients].map((client) => client.close()));
	const activeBroker = broker;
	if (activeBroker !== undefined && activeBroker.exitCode === null) {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`Broker did not exit within ${BROKER_SHUTDOWN_TIMEOUT_MS}ms after SIGTERM`)),
				BROKER_SHUTDOWN_TIMEOUT_MS,
			);
			activeBroker.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
			if (!activeBroker.kill("SIGTERM")) {
				clearTimeout(timer);
				reject(new Error("Broker rejected SIGTERM"));
			}
		});
	}
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
			stages: [
				{ id: "reviewer-id", name: "reviewer", status: "pending", parentIds: [], toolEvents: [] },
				{ id: "completed-id", name: "completed-stage", status: "completed", parentIds: [], toolEvents: [] },
				{
					id: "late-id",
					name: "late-stage",
					status: "running",
					sessionId: "former-live-session",
					parentIds: [],
					toolEvents: [],
				},
				{
					id: "closed-id",
					name: "closed-stage",
					status: "completed",
					sessionFile: "/tmp/closed-stage.jsonl",
					parentIds: [],
					toolEvents: [],
				},
			],
			startedAt: 1,
		});
		backend.registerWorkflow({ workflowId: RUN_ID, name: "flow", inputs: {}, status: "running", createdAt: 1 });
		await owner.waitForEventCompletion("atomic:workflow-pending-stage-route");
		await sender.start();

		const unknown = await executeIntercom(sender, {
			action: "send",
			to: `${RUN_ID}:unknown-stage`,
			message: "This target does not exist.",
		});
		assert.match(unknown.content[0]?.text ?? "", /Session not found/);
		assert.equal(unknown.details.delivered, false);
		assert.deepEqual(store.pendingStageMessagesFor(RUN_ID, "unknown-stage"), []);

		for (const stageKey of ["unknown-stage", "completed-stage", "late-stage", "closed-stage"]) {
			const ordinaryAskFailure = await executeIntercom(sender, {
				action: "ask",
				to: `${RUN_ID}:${stageKey}`,
				message: `Lifecycle validation for ${stageKey}`,
			});
			assert.match(ordinaryAskFailure.content[0]?.text ?? "", /Session not found/);
			assert.equal(ordinaryAskFailure.details.refusal, undefined);
		}

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

test("a durable pending admission survives a real stage-session fallback attempt exactly once", async () => {
	const messageId = "2717-stage-attempt-restart-message";
	const admissionId = `intercom:${messageId}`;
	const replayKey = "stage:reviewer:1";
	const attemptSessionIds = ["2717-reviewer-attempt-1", "2717-reviewer-attempt-2"] as const;
	const store = createStore();
	const backend = new InMemoryDurableBackend();
	backend.registerWorkflow({
		workflowId: RUN_ID,
		name: "attempt-restart",
		inputs: {},
		status: "running",
		createdAt: 1,
	});
	setDurableBackend(backend);
	const owner = extensionFixture("attempt-restart-owner", "attempt-restart-owner", undefined, "default");
	intercom(owner.pi as never);
	const disposeBridge = registerPendingStageIntercomBridge(owner.pi as never, store);
	const sender = new RawBrokerClient();
	rawClients.add(sender);
	const releaseStageInitialization = Promise.withResolvers<void>();
	const stageRegistered = Promise.withResolvers<void>();
	const lifecycle: string[] = [];
	const attempts: Array<{
		readonly fixture: ReturnType<typeof extensionFixture>;
		readonly model: string;
		readonly orchestrationContext: TestContext["orchestrationContext"];
		readonly sessionId: string;
		readonly shutdown: () => Promise<void>;
	}> = [];
	const adapters = {
		agentSession: {
			async create(options: CreateAgentSessionOptions) {
				const rawContext = options.orchestrationContext;
				assert.equal(rawContext?.kind, "workflow-stage");
				const orchestrationContext = rawContext as TestContext["orchestrationContext"];
				const pendingStageDelivery = orchestrationContext.pendingStageDelivery;
				assert.ok(pendingStageDelivery, "stage attempt did not receive production pending delivery");
				if (orchestrationContext.messageAdmission === undefined) {
					const boundary = new StageAdmissionBoundary();
					orchestrationContext.messageAdmission = {
						boundary,
						extensionState: new Map(),
						isOpen: () => boundary.isOpen(),
					};
				}
				const modelValue = options.model;
				const model =
					typeof modelValue === "string"
						? modelValue
						: `${String(modelValue?.provider)}/${String(modelValue?.id)}`;
				const sessionId = attemptSessionIds[attempts.length];
				assert.ok(sessionId, `unexpected stage attempt ${attempts.length + 1}`);
				const fixture = extensionFixture(sessionId, "reviewer", pendingStageDelivery, GROUP, orchestrationContext);
				if (attempts.length === 0) {
					fixture.pi.sendMessage = async () => {
						throw new Error("503 service unavailable before external pending-stage admission");
					};
				}
				intercomHeavy(fixture.pi as never);
				let stopped = false;
				const shutdown = async (): Promise<void> => {
					if (stopped) return;
					stopped = true;
					await fixture.shutdown();
				};
				attempts.push({ fixture, model, orchestrationContext, sessionId, shutdown });
				try {
					await fixture.start();
				} catch (error) {
					await shutdown();
					throw error;
				}
				if (fixture.injectedMessages.length > 0) lifecycle.push(`admission:${sessionId}`);
				const messages: AgentSession["messages"] = [];
				const session: StageSessionRuntime & {
					readonly orchestrationContext: TestContext["orchestrationContext"];
					readonly state: object;
					readonly sessionManager: TestContext["sessionManager"];
					readonly modelRuntime: object;
					getContextUsage(): undefined;
				} = {
					async prompt() {
						lifecycle.push(`task:${sessionId}`);
						return "fallback attempt completed";
					},
					async steer() {},
					async followUp() {},
					subscribe: () => () => {},
					sessionFile: join(agentDir, `${sessionId}.jsonl`),
					sessionId,
					async setModel() {},
					setThinkingLevel() {},
					cycleModel: async () => undefined,
					cycleThinkingLevel: () => undefined,
					agent: { waitForIdle: async () => {} } as never,
					model: {
						provider: model.split("/")[0] ?? "test",
						id: model.split("/")[1] ?? model,
					} as AgentSession["model"],
					thinkingLevel: "medium",
					messages,
					isStreaming: false,
					navigateTree: async () => ({ cancelled: false }),
					compact: async () => ({}) as never,
					abortCompaction() {},
					async abort() {},
					dispose: shutdown,
					getLastAssistantText: () => "fallback attempt completed",
					orchestrationContext,
					state: {},
					sessionManager: fixture.context.sessionManager,
					modelRuntime: {},
					getContextUsage: () => undefined,
				};
				return { session };
			},
		},
	};
	const definition = workflow({
		name: "attempt-restart",
		description: "",
		inputs: {},
		outputs: { result: Type.String() },
		run: async (ctx) => {
			const reviewer = ctx.stage("reviewer", {
				tools: ["intercom"],
				model: "anthropic/primary",
				fallbackModels: ["openai/fallback"],
				settingsManager: {
					getCodexFastModeSettings: () => ({ chat: false, workflow: false }),
					getRetrySettings: () => ({ enabled: false, maxRetries: 0, baseDelayMs: 0 }),
				},
			} as never);
			stageRegistered.resolve();
			await releaseStageInitialization.promise;
			return { result: String(await reviewer.prompt("attempt 2 first model task")) };
		},
	});
	let runPromise: ReturnType<typeof run> | undefined;

	try {
		await owner.start();
		runPromise = run(definition, {}, { runId: RUN_ID, store, adapters });
		await stageRegistered.promise;
		await owner.waitForEventCompletion("atomic:workflow-pending-stage-route");
		await sender.register("attempt-restart-sender", GROUP);
		sender.send({
			type: "send",
			to: TARGET,
			message: {
				id: messageId,
				timestamp: 1_787_860_000_000,
				content: { text: "preserve this admission across the stage attempt restart" },
			},
		});
		const queued = await sender.next("queued", (frame) => frame.messageId === messageId);
		assert.equal(queued.position, 1);
		const queuedEntry = store.pendingStageMessagesFor(RUN_ID, "reviewer")[0];
		assert.equal(queuedEntry?.id, messageId);
		assert.equal(queuedEntry?.stageReplayKey, replayKey);
		assert.equal(queuedEntry?.status, "queued");

		releaseStageInitialization.resolve();
		const result = await runPromise;
		assert.equal(result.status, "completed", JSON.stringify(result, undefined, 2));
		assert.deepEqual(
			attempts.map(({ model, sessionId }) => ({ model, sessionId })),
			[
				{ model: "anthropic/primary", sessionId: attemptSessionIds[0] },
				{ model: "openai/fallback", sessionId: attemptSessionIds[1] },
			],
		);
		assert.notEqual(attempts[0]?.sessionId, attempts[1]?.sessionId);
		assert.equal(new Set(attempts.map(({ orchestrationContext }) => orchestrationContext.workflowStageId)).size, 1);
		assert.equal(queuedEntry?.stageId, attempts[1]?.orchestrationContext.workflowStageId);
		assert.deepEqual(lifecycle, [`admission:${attemptSessionIds[1]}`, `task:${attemptSessionIds[1]}`]);
		assert.equal(attempts[0]?.fixture.injectedMessages.length, 0);
		assert.equal(attempts[1]?.fixture.injectedMessages.length, 1);
		const visible = attempts.flatMap(({ fixture }) => fixture.injectedMessages);
		assert.notStrictEqual(attempts[0]?.orchestrationContext, attempts[1]?.orchestrationContext);
		assert.notStrictEqual(
			attempts[0]?.orchestrationContext.messageAdmission?.boundary,
			attempts[1]?.orchestrationContext.messageAdmission?.boundary,
		);
		assert.equal(visible.length, 1);
		assert.equal(visible[0]?.details?.message?.id, messageId);
		assert.equal(visible[0]?.details?.from?.id, queuedEntry?.from.id);
		assert.equal(visible[0]?.details?.from?.name, "attempt-restart-sender");
		assert.equal(attempts[1]?.fixture.injectedOptions[0]?.stageAdmissionKey, admissionId);
		const durableEntry = backend.getWorkflow(RUN_ID)?.pendingStageMessages?.[0];
		assert.deepEqual(
			durableEntry && {
				id: durableEntry.id,
				stageId: durableEntry.stageId,
				stageReplayKey: durableEntry.stageReplayKey,
				status: durableEntry.status,
			},
			{
				id: messageId,
				stageId: attempts[1]?.orchestrationContext.workflowStageId,
				stageReplayKey: replayKey,
				status: "delivered",
			},
		);
		assert.equal(store.runs().find((candidate) => candidate.id === RUN_ID)?.status, "completed");
		assert.deepEqual(
			result.stages[0]?.modelAttempts?.map((attempt) => ({ model: attempt.model, success: attempt.success })),
			[
				{ model: "anthropic/primary", success: false },
				{ model: "openai/fallback", success: true },
			],
		);
	} finally {
		releaseStageInitialization.resolve();
		try {
			if (runPromise !== undefined) await runPromise;
		} finally {
			await Promise.all(attempts.map(({ shutdown }) => shutdown()));
			await sender.close();
			rawClients.delete(sender);
			disposeBridge();
			await owner.shutdown();
		}
	}
});
test("raw malformed messages are rejected before durable mutation and valid optional fields survive DBOS reload", async () => {
	const runId = "2f34ff35-9813-4a60-b7a3-24698cd01592";
	const group = `workflow:${runId}`;
	const target = `${runId}:reviewer`;
	const sdk = createMockSdk();
	const writer = new DbosDurableBackend(sdk, { executorId: "wire-validation-writer" });
	writer.registerWorkflow({ workflowId: runId, name: "wire-validation", inputs: {}, status: "running", createdAt: 1 });
	await writer.flush();
	setDurableBackend(writer);
	const store = createStore();
	store.recordRunStart({
		id: runId,
		name: "wire-validation",
		inputs: {},
		status: "running",
		stages: [{ id: "reviewer-id", name: "reviewer", status: "pending", parentIds: [], toolEvents: [] }],
		startedAt: 1,
	});
	const owner = extensionFixture("wire-owner", "wire-owner", undefined, "default");
	intercom(owner.pi as never);
	const disposeBridge = registerPendingStageIntercomBridge(owner.pi as never, store);
	const raw = new RawBrokerClient();
	rawClients.add(raw);
	try {
		await owner.start();
		await owner.waitForEventCompletion("atomic:workflow-pending-stage-route");
		await raw.register("raw-sender", group);
		const malformed = [
			{ id: "malformed-reply-error", timestamp: 1, replyError: { bad: true }, content: { text: "bad" } },
			{ id: "malformed-source", timestamp: 2, source: {}, content: { text: "bad" } },
			{
				id: "malformed-attachment",
				timestamp: 3,
				content: { text: "bad", attachments: [{ type: "file", name: "bad", content: "bad", language: 9 }] },
			},
		] as const;
		for (const message of malformed) {
			raw.send({ type: "send", to: target, message });
			assert.deepEqual(await raw.next("delivery_failed", (frame) => frame.messageId === message.id), {
				type: "delivery_failed",
				messageId: message.id,
				reason: "Invalid message format",
			});
		}
		assert.deepEqual(store.pendingStageMessagesFor(runId, "reviewer"), []);
		const cleanReload = new DbosDurableBackend(sdk, { executorId: "wire-validation-clean-reader" });
		await cleanReload.hydrateWorkflow(runId);
		assert.deepEqual(cleanReload.getWorkflow(runId)?.pendingStageMessages, []);

		const validMessage = {
			id: "valid-full-message",
			timestamp: 4,
			replyTo: "prior-message",
			expectsReply: false,
			replyError: "preserved remote context",
			source: { subagentRunId: "subagent-run", subagentAgent: "reviewer", subagentIndex: 3 },
			content: {
				text: "valid",
				attachments: [{ type: "context", name: "contract", content: "literal", language: "txt" }],
			},
		};
		raw.send({ type: "send", to: target, message: validMessage });
		const queued = await raw.next("queued", (frame) => frame.messageId === validMessage.id);
		assert.equal(queued.position, 1);
		raw.send({ type: "send", to: `${runId}:reviewer-id`, message: validMessage });
		assert.equal((await raw.next("queued", (frame) => frame.messageId === validMessage.id)).position, 1);
		raw.send({
			type: "send",
			to: `${runId}:reviewer-id`,
			message: { ...validMessage, content: { ...validMessage.content, text: "conflicting reuse" } },
		});
		assert.deepEqual(await raw.next("delivery_failed", (frame) => frame.messageId === validMessage.id), {
			type: "delivery_failed",
			messageId: validMessage.id,
			reason: `Intercom message ID '${validMessage.id}' was already queued for ${runId}:reviewer-id with a different target, sender, or payload`,
		});
		for (let position = 2; position <= 50; position++) {
			const message = { id: `capacity-${position}`, timestamp: position + 4, content: { text: String(position) } };
			raw.send({
				type: "send",
				to: `${runId}:${position % 2 === 0 ? "reviewer-id" : "reviewer"}`,
				message,
			});
			assert.equal((await raw.next("queued", (frame) => frame.messageId === message.id)).position, position);
		}
		raw.send({
			type: "send",
			to: `${runId}:reviewer`,
			message: { id: "capacity-51", timestamp: 55, content: { text: "refused" } },
		});
		assert.match(
			(await raw.next("delivery_failed", (frame) => frame.messageId === "capacity-51")).reason,
			/queue is full \(limit 50\)/,
		);
		const validReload = new DbosDurableBackend(sdk, { executorId: "wire-validation-valid-reader" });
		await validReload.hydrateWorkflow(runId);
		assert.equal(validReload.getWorkflow(runId)?.pendingStageMessages?.length, 50);
		assert.deepEqual(validReload.getWorkflow(runId)?.pendingStageMessages?.[0]?.message, validMessage);
	} finally {
		await raw.close();
		rawClients.delete(raw);
		disposeBridge();
		await owner.shutdown();
	}
});
