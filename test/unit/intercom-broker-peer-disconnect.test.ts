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
const agentDir = mkdtempSync(join(tmpdir(), "intercom-peer-disconnect-"));
const socketPath = getBrokerSocketPath(process.platform, agentDir);
let broker: ChildProcess | undefined;

class WireClient {
	readonly received: BrokerMessage[] = [];
	readonly socket = net.createConnection(socketPath);
	private consumed = new Set<number>();

	constructor() {
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
			this.socket.once("connect", resolveConnected);
			this.socket.once("error", reject);
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
	throw new Error("Broker socket did not become ready");
}

async function register(client: WireClient, name?: string): Promise<string> {
	await client.connected();
	client.send({
		type: "register",
		session: {
			...(name !== undefined ? { name } : {}),
			cwd: "/tmp/exact",
			model: "test-model",
			pid: 42,
			startedAt: 1,
			lastActivity: 1,
		},
	});
	return (await client.next("registered")).sessionId;
}

beforeAll(async () => {
	broker = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: undefined },
		stdio: "ignore",
	});
	await waitForBroker();
});

afterAll(() => {
	broker?.kill("SIGTERM");
	rmSync(agentDir, { recursive: true, force: true });
});

test("broker emits exact idempotent peer_disconnected frames for graceful and abrupt target exits", async () => {
	const gracefulAsker = new WireClient();
	const secondAsker = new WireClient();
	const gracefulTarget = new WireClient();
	const gracefulAskerId = await register(gracefulAsker, "graceful-asker");
	await register(secondAsker, "second-asker");
	const gracefulTargetId = await register(gracefulTarget, "graceful-target-exact");

	for (const [asker, questionId] of [
		[gracefulAsker, "graceful-question-1"],
		[gracefulAsker, "graceful-question-2"],
		[secondAsker, "second-question-exact"],
		[gracefulAsker, "answered-question-exact"],
	] as const) {
		asker.send({
			type: "send",
			to: gracefulTargetId,
			message: { id: questionId, timestamp: 1, expectsReply: true, content: { text: "question" } },
		});
		await asker.next("delivered");
		await gracefulTarget.next("message");
	}
	gracefulTarget.send({
		type: "send",
		to: gracefulAskerId,
		message: { id: "answer-exact", timestamp: 2, replyTo: "answered-question-exact", content: { text: "answer" } },
	});
	await gracefulTarget.next("delivered");
	await gracefulAsker.next("message");
	gracefulTarget.send({ type: "unregister" });
	gracefulTarget.socket.end();
	assert.deepEqual(await gracefulAsker.next("peer_disconnected"), {
		type: "peer_disconnected",
		replyTo: "graceful-question-1",
		peerSessionId: gracefulTargetId,
		peerName: "graceful-target-exact",
	});
	assert.deepEqual(await gracefulAsker.next("peer_disconnected"), {
		type: "peer_disconnected",
		replyTo: "graceful-question-2",
		peerSessionId: gracefulTargetId,
		peerName: "graceful-target-exact",
	});
	assert.deepEqual(await secondAsker.next("peer_disconnected"), {
		type: "peer_disconnected",
		replyTo: "second-question-exact",
		peerSessionId: gracefulTargetId,
		peerName: "graceful-target-exact",
	});
	await gracefulAsker.next("session_left", (frame) => frame.sessionId === gracefulTargetId);
	await secondAsker.next("session_left", (frame) => frame.sessionId === gracefulTargetId);

	const abruptAsker = new WireClient();
	const abruptTarget = new WireClient();
	await register(abruptAsker, "abrupt-asker");
	const abruptTargetId = await register(abruptTarget);
	for (const [asker, questionId] of [
		[abruptAsker, "abrupt-question-exact"],
		[gracefulAsker, "mixed-target-question"],
	] as const) {
		asker.send({
			type: "send",
			to: abruptTargetId,
			message: { id: questionId, timestamp: 3, expectsReply: true, content: { text: "question" } },
		});
		await asker.next("delivered");
		await abruptTarget.next("message");
	}
	abruptTarget.socket.destroy();
	assert.deepEqual(await abruptAsker.next("peer_disconnected"), {
		type: "peer_disconnected",
		replyTo: "abrupt-question-exact",
		peerSessionId: abruptTargetId,
	});
	assert.deepEqual(await gracefulAsker.next("peer_disconnected"), {
		type: "peer_disconnected",
		replyTo: "mixed-target-question",
		peerSessionId: abruptTargetId,
	});
	await abruptAsker.next("session_left", (frame) => frame.sessionId === abruptTargetId);
	await gracefulAsker.next("session_left", (frame) => frame.sessionId === abruptTargetId);

	const gracefulDepartedAsker = new WireClient();
	const abruptDepartedAsker = new WireClient();
	const survivingAsker = new WireClient();
	const scopedTarget = new WireClient();
	const gracefulDepartedId = await register(gracefulDepartedAsker, "graceful-departed-asker");
	const abruptDepartedId = await register(abruptDepartedAsker, "abrupt-departed-asker");
	await register(survivingAsker, "surviving-asker");
	const scopedTargetId = await register(scopedTarget, "scoped-target");
	for (const [asker, questionId] of [
		[gracefulDepartedAsker, "gracefully-pruned-question"],
		[abruptDepartedAsker, "abruptly-pruned-question"],
		[survivingAsker, "surviving-question"],
	] as const) {
		asker.send({
			type: "send",
			to: scopedTargetId,
			message: {
				id: questionId,
				timestamp: 4,
				expectsReply: true,
				content: { text: "question" },
			},
		});
		await asker.next("delivered");
		await scopedTarget.next("message");
	}
	gracefulDepartedAsker.send({ type: "unregister" });
	gracefulDepartedAsker.socket.end();
	await scopedTarget.next("session_left", (frame) => frame.sessionId === gracefulDepartedId);
	abruptDepartedAsker.socket.destroy();
	await scopedTarget.next("session_left", (frame) => frame.sessionId === abruptDepartedId);
	scopedTarget.socket.destroy();
	assert.deepEqual(await survivingAsker.next("peer_disconnected"), {
		type: "peer_disconnected",
		replyTo: "surviving-question",
		peerSessionId: scopedTargetId,
		peerName: "scoped-target",
	});
	await survivingAsker.next("session_left", (frame) => frame.sessionId === scopedTargetId);
	for (const client of [gracefulAsker, secondAsker, abruptAsker]) {
		await client.next("session_left", (frame) => frame.sessionId === scopedTargetId);
	}
	const notices = (client: WireClient) => client.received.filter((frame) => frame.type === "peer_disconnected");
	assert.deepEqual(
		notices(gracefulAsker).map((frame) => frame.replyTo),
		["graceful-question-1", "graceful-question-2", "mixed-target-question"],
	);
	assert.deepEqual(
		notices(secondAsker).map((frame) => frame.replyTo),
		["second-question-exact"],
	);
	assert.deepEqual(
		notices(abruptAsker).map((frame) => frame.replyTo),
		["abrupt-question-exact"],
	);
	assert.deepEqual(notices(survivingAsker), [
		{
			type: "peer_disconnected",
			replyTo: "surviving-question",
			peerSessionId: scopedTargetId,
			peerName: "scoped-target",
		},
	]);
	for (const client of [gracefulAsker, secondAsker, abruptAsker, survivingAsker]) client.socket.destroy();
});
