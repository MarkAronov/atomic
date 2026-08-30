import assert from "node:assert/strict";
import { once } from "node:events";
import { connect } from "node:net";
import { test } from "vitest";
import {
	LoopbackProviderCollector,
	REQUIRED_BENCHMARK_TOOLS,
	validateProviderRequest,
} from "../../scripts/perf/windows-startup/collector.js";

function requestBody(nonce: string, tools: readonly string[] = REQUIRED_BENCHMARK_TOOLS): string {
	return JSON.stringify({
		messages: [{ role: "user", content: nonce }],
		tools: tools.map((name) => ({ type: "function", function: { name, parameters: { type: "object" } } })),
	});
}

function rawRequest(body: string): string {
	return `POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

async function exchange(port: number, request: string, splitAt?: number): Promise<void> {
	const socket = connect(port, "127.0.0.1");
	await once(socket, "connect");
	socket.resume();
	if (splitAt === undefined) {
		socket.end(request);
	} else {
		socket.write(request.slice(0, splitAt));
		socket.end(request.slice(splitAt));
	}
	await once(socket, "end");
	socket.destroy();
}

test("the collector timestamps the first socket byte before parsing HTTP", async () => {
	const marks = [100n, 900n];
	const collector = new LoopbackProviderCollector("nonce-1", { nowNs: () => marks.shift() ?? 900n });
	await collector.start();
	await exchange(collector.port, rawRequest(requestBody("nonce-1")), 1);
	const record = await collector.waitForRequest();
	assert.equal(record.firstByteNs, "100");
	assert.equal(record.parsedAtNs, "900");
	await collector.stop();
});

test("duplicate provider requests fail the single-request assertion", async () => {
	const collector = new LoopbackProviderCollector("nonce-2");
	await collector.start();
	await exchange(collector.port, rawRequest(requestBody("nonce-2")));
	await exchange(collector.port, rawRequest(requestBody("nonce-2")));
	assert.throws(() => collector.assertSingleValidRequest(), /exactly one provider request/u);
	await collector.stop();
});

test("missing nonce and required tool schemas fail validation", () => {
	const missingNonce = validateProviderRequest(requestBody("other"), "expected");
	assert.ok(missingNonce.errors.some((error) => error.includes("nonce")));
	const missingTool = validateProviderRequest(requestBody("expected", REQUIRED_BENCHMARK_TOOLS.slice(1)), "expected");
	assert.ok(missingTool.errors.some((error) => error.includes(REQUIRED_BENCHMARK_TOOLS[0]!)));
});
