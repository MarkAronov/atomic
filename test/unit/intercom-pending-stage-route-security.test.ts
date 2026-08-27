import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { createMessageReader, writeMessage } from "../../packages/intercom/broker/framing.js";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import { getJitiCliPath } from "../../packages/intercom/broker/spawn.js";
import type { BrokerMessage, ClientMessage } from "../../packages/intercom/types.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const extensionDir = join(repoRoot, "packages/intercom");
const agentDir = mkdtempSync(join(tmpdir(), "icr-"));
const socketPath = getBrokerSocketPath(process.platform, agentDir);
const RUN_ID = "4ac72924-c452-4e5f-9e63-2435722109f7";
const TARGET = `${RUN_ID}:reviewer`;
const VICTIM_GROUP = `workflow:${RUN_ID}`;
const ROUTE_CAPABILITY = "victim-workflow-route-capability";
const clients = new Set<WireClient>();
let broker: ChildProcess | undefined;
let brokerOutput = "";

class WireClient {
	readonly received: BrokerMessage[] = [];
	readonly socket = net.createConnection(socketPath);
	readonly closed: Promise<void>;
	private consumed = new Set<number>();

	constructor() {
		clients.add(this);
		this.closed = new Promise((resolveClosed) => this.socket.once("close", () => resolveClosed()));
		this.socket.on(
			"data",
			createMessageReader(
				(message) => this.received.push(message as BrokerMessage),
				(error) => this.socket.destroy(error),
			),
		);
		this.socket.on("error", () => {});
	}

	async connected(): Promise<void> {
		if (!this.socket.connecting) return;
		await new Promise<void>((resolveConnected, reject) => {
			this.socket.once("connect", resolveConnected).once("error", reject);
		});
	}

	send(message: ClientMessage): void {
		writeMessage(this.socket, message);
	}

	async next<T extends BrokerMessage["type"]>(
		type: T,
		matches: (message: Extract<BrokerMessage, { type: T }>) => boolean = () => true,
	): Promise<Extract<BrokerMessage, { type: T }>> {
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			const index = this.received.findIndex((message, candidate) => {
				if (this.consumed.has(candidate) || message.type !== type) return false;
				return matches(message as Extract<BrokerMessage, { type: T }>);
			});
			if (index >= 0) {
				this.consumed.add(index);
				return this.received[index] as Extract<BrokerMessage, { type: T }>;
			}
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
		}
		throw new Error(`Timed out waiting for broker frame ${type}`);
	}
}

async function waitForBroker(): Promise<void> {
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
	throw new Error(`Broker socket did not become ready: ${brokerOutput}`);
}

async function register(client: WireClient, name: string, group: string): Promise<string> {
	await client.connected();
	client.send({
		type: "register",
		session: { name, group, cwd: "/repo", model: "test", pid: 1, startedAt: 1, lastActivity: 1 },
	});
	return (await client.next("registered")).sessionId;
}

async function registrationOutcome(client: WireClient, requestId: string): Promise<"closed" | "acknowledged"> {
	client.send({ type: "list", requestId });
	return await Promise.race([
		client.closed.then(() => "closed" as const),
		client.next("sessions", (frame) => frame.requestId === requestId).then(() => "acknowledged" as const),
	]);
}

beforeAll(async () => {
	broker = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: undefined },
		stdio: ["ignore", "pipe", "pipe"],
	});
	broker.stdout?.on("data", (data) => {
		brokerOutput += String(data);
	});
	broker.stderr?.on("data", (data) => {
		brokerOutput += String(data);
	});
	await waitForBroker();
});

afterAll(async () => {
	for (const client of clients) client.socket.destroy();
	if (broker?.exitCode === null) {
		broker.kill("SIGTERM");
		await new Promise<void>((resolveExit) => broker?.once("exit", () => resolveExit()));
	}
	rmSync(agentDir, { recursive: true, force: true });
});

test("broker rejects cross-group pending-route impersonation before route mutation", async () => {
	const attacker = new WireClient();
	const sender = new WireClient();
	await register(attacker, "attacker", "attacker-group");
	await register(sender, "victim-sender", VICTIM_GROUP);

	attacker.send({
		type: "register_pending_stage_route",
		runId: RUN_ID,
		group: VICTIM_GROUP,
		capability: "attacker-capability",
	});
	assert.equal(await registrationOutcome(attacker, "attacker-route-processed"), "closed");

	const canary = "cross-group-security-canary-content";
	sender.send({
		type: "send",
		to: TARGET,
		message: {
			id: "cross-group-impersonation",
			timestamp: 1,
			content: { text: canary, attachments: [{ type: "context", name: "secret", content: canary }] },
		},
	});
	assert.deepEqual(await sender.next("delivery_failed"), {
		type: "delivery_failed",
		messageId: "cross-group-impersonation",
		reason: "Session not found",
	});
	assert.equal(
		attacker.received.some((frame) => frame.type === "pending_stage_message"),
		false,
	);
	assert.equal(brokerOutput.includes(canary), false);
});

test("broker rejects same-group replacement of an active pending route owner", async () => {
	const runId = "eaf2d23d-e52f-44a4-95b0-91c2109cbf34";
	const group = `workflow:${runId}`;
	const target = `${runId}:reviewer`;
	const legitimate = new WireClient();
	const attacker = new WireClient();
	const sender = new WireClient();
	await register(legitimate, "legitimate-owner", group);
	await register(attacker, "same-group-pending-attacker", group);
	await register(sender, "same-group-pending-sender", group);

	legitimate.send({
		type: "register_pending_stage_route",
		runId,
		group,
		capability: "pending-owner-route-capability",
	});
	assert.equal(await registrationOutcome(legitimate, "legitimate-pending-owner-processed"), "acknowledged");
	legitimate.send({
		type: "register_pending_stage_route",
		runId,
		group,
		capability: "pending-owner-route-capability",
	});
	assert.equal(await registrationOutcome(legitimate, "legitimate-pending-owner-repeat"), "acknowledged");
	attacker.send({
		type: "register_pending_stage_route",
		runId,
		group,
		capability: "same-group-attacker-capability",
	});
	assert.equal(await registrationOutcome(attacker, "pending-takeover-processed"), "closed");

	const canary = "pending-route-takeover-security-canary";
	sender.send({
		type: "send",
		to: target,
		message: { id: "after-pending-takeover", timestamp: 2, content: { text: canary } },
	});
	const request = await legitimate.next("pending_stage_message");
	assert.equal(request.message.content.text, canary);
	legitimate.send({
		type: "pending_stage_message_result",
		requestId: request.requestId,
		outcome: "queued",
		position: 1,
	});
	assert.equal((await sender.next("queued")).messageId, "after-pending-takeover");
	assert.equal(
		attacker.received.some((frame) => frame.type === "pending_stage_message"),
		false,
	);
	assert.equal(brokerOutput.includes(canary), false);
});

test("broker rejects an attacker-first live route without the workflow capability", async () => {
	const runId = "78c47adc-8cab-466f-a902-5d9ca2521c2c";
	const group = `workflow:${runId}`;
	const target = `${runId}:reviewer`;
	const owner = new WireClient();
	const attacker = new WireClient();
	const legitimate = new WireClient();
	const sender = new WireClient();
	await register(owner, "workflow-owner", group);
	await register(attacker, "attacker-first-stage", group);
	await register(legitimate, "legitimate-stage-after-attacker", group);
	await register(sender, "attacker-first-sender", group);
	owner.send({
		type: "register_pending_stage_route",
		runId,
		group,
		capability: "attacker-first-owner-capability",
	});
	assert.equal(await registrationOutcome(owner, "capability-owner-processed"), "acknowledged");

	attacker.send({
		type: "register_live_workflow_stage_route",
		requestId: "attacker-first-route",
		runId,
		stageKeys: ["reviewer"],
		capability: "attacker-live-capability",
	});
	assert.equal(await registrationOutcome(attacker, "attacker-first-route-processed"), "closed");
	legitimate.send({
		type: "register_live_workflow_stage_route",
		requestId: "legitimate-after-attacker-route",
		runId,
		stageKeys: ["reviewer", "reviewer-id"],
		capability: "attacker-first-owner-capability",
	});
	await legitimate.next(
		"live_workflow_stage_route_registered",
		(frame) => frame.requestId === "legitimate-after-attacker-route",
	);
	sender.send({
		type: "send",
		to: target,
		message: { id: "attacker-first-live-send", timestamp: 3, content: { text: "legitimate recipient only" } },
	});
	assert.equal((await sender.next("delivered")).messageId, "attacker-first-live-send");
	assert.equal((await legitimate.next("message")).message.content.text, "legitimate recipient only");
	assert.equal(
		attacker.received.some((frame) => frame.type === "message"),
		false,
	);
});
test("broker rejects a different active session taking over a live composite route", async () => {
	const owner = new WireClient();
	const legitimate = new WireClient();
	const attacker = new WireClient();
	const sender = new WireClient();
	await register(owner, "live-route-owner", VICTIM_GROUP);
	await register(legitimate, "legitimate-stage", VICTIM_GROUP);
	await register(attacker, "same-group-attacker", VICTIM_GROUP);
	await register(sender, "same-group-sender", VICTIM_GROUP);
	owner.send({
		type: "register_pending_stage_route",
		runId: RUN_ID,
		group: VICTIM_GROUP,
		capability: ROUTE_CAPABILITY,
	});
	assert.equal(await registrationOutcome(owner, "live-route-owner-processed"), "acknowledged");

	legitimate.send({
		type: "register_live_workflow_stage_route",
		requestId: "legitimate-route",
		runId: RUN_ID,
		stageKeys: ["reviewer", "reviewer-id"],
		capability: ROUTE_CAPABILITY,
	});
	await legitimate.next("live_workflow_stage_route_registered", (frame) => frame.requestId === "legitimate-route");
	legitimate.send({
		type: "register_live_workflow_stage_route",
		requestId: "legitimate-route-repeat",
		runId: RUN_ID,
		stageKeys: ["reviewer-id", "reviewer"],
		capability: ROUTE_CAPABILITY,
	});
	await legitimate.next(
		"live_workflow_stage_route_registered",
		(frame) => frame.requestId === "legitimate-route-repeat",
	);

	attacker.send({
		type: "register_live_workflow_stage_route",
		requestId: "takeover-route",
		runId: RUN_ID,
		stageKeys: ["reviewer"],
		capability: ROUTE_CAPABILITY,
	});
	assert.equal(await registrationOutcome(attacker, "takeover-route-processed"), "closed");

	const canary = "live-route-takeover-security-canary";
	sender.send({
		type: "send",
		to: TARGET,
		message: { id: "after-takeover", timestamp: 2, content: { text: canary } },
	});
	assert.deepEqual(await sender.next("delivered"), {
		type: "delivered",
		messageId: "after-takeover",
	});
	assert.equal((await legitimate.next("message")).message.content.text, canary);
	assert.equal(
		attacker.received.some((frame) => frame.type === "message"),
		false,
	);
	assert.equal(brokerOutput.includes(canary), false);
});

test("live composite route replacement requires the old owner to disconnect", async () => {
	const transitionRunId = "7f684570-74ec-4f17-a09f-2df742f1c911";
	const transitionGroup = `workflow:${transitionRunId}`;
	const owner = new WireClient();
	const oldOwner = new WireClient();
	const nextAttempt = new WireClient();
	const sender = new WireClient();
	await register(owner, "transition-owner", transitionGroup);
	const oldOwnerId = await register(oldOwner, "stage-attempt-1", transitionGroup);
	await register(nextAttempt, "stage-attempt-2", transitionGroup);
	await register(sender, "transition-sender", transitionGroup);
	owner.send({
		type: "register_pending_stage_route",
		runId: transitionRunId,
		group: transitionGroup,
		capability: "transition-route-capability",
	});
	assert.equal(await registrationOutcome(owner, "transition-owner-processed"), "acknowledged");

	oldOwner.send({
		type: "register_live_workflow_stage_route",
		requestId: "old-attempt-route",
		runId: transitionRunId,
		stageKeys: ["reviewer", "reviewer-id"],
		capability: "transition-route-capability",
	});
	await oldOwner.next("live_workflow_stage_route_registered", (frame) => frame.requestId === "old-attempt-route");
	oldOwner.socket.destroy();
	await sender.next("session_left", (frame) => frame.sessionId === oldOwnerId);

	nextAttempt.send({
		type: "register_live_workflow_stage_route",
		requestId: "next-attempt-route",
		runId: transitionRunId,
		stageKeys: ["reviewer-id", "reviewer"],
		capability: "transition-route-capability",
	});
	await nextAttempt.next("live_workflow_stage_route_registered", (frame) => frame.requestId === "next-attempt-route");
	sender.send({
		type: "send",
		to: `${transitionRunId}:reviewer`,
		message: { id: "stage-attempt-transition", timestamp: 3, content: { text: "transition message" } },
	});
	await sender.next("delivered", (frame) => frame.messageId === "stage-attempt-transition");
	assert.equal((await nextAttempt.next("message")).message.content.text, "transition message");
});
