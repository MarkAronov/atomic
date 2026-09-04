import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	type AiGatewayBinding,
	CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
	createGatewayBindingFetch,
} from "../src/api/cloudflare-gateway-binding.ts";
import { streamSimple as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { Model } from "../src/types.ts";

const BINDING_PREFIX = "https://workers-binding.ai/ai-gateway/gateways/my-gateway";
const PASSTHROUGH_OPTIONS = { baseUrl: BINDING_PREFIX, gateway: "my-gateway" };

function fakeFetchBinding(response?: Response) {
	const calls: Array<{ input: Request | string | URL; init?: RequestInit }> = [];
	const binding: AiGatewayBinding = {
		aiGatewayLogId: null,
		fetch: (input: Request | string | URL, init?: RequestInit) => {
			calls.push({ input, init });
			return Promise.resolve(response ?? new Response("{}"));
		},
	};
	return { binding, calls };
}

describe("createGatewayBindingFetch binding.fetch() passthrough", () => {
	it("passes input, init, and the streaming response through by identity", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
				controller.close();
			},
		});
		const bindingResponse = new Response(stream, {
			headers: { "content-type": "text/event-stream", "cf-aig-log-id": "log-1" },
		});
		const { binding, calls } = fakeFetchBinding(bindingResponse);
		const fetchFn = createGatewayBindingFetch({ binding, ...PASSTHROUGH_OPTIONS });
		const request = new Request(`${BINDING_PREFIX}/anthropic/v1/messages?beta=true`, {
			method: "PATCH",
			headers: { "cf-aig-authorization": `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}` },
			body: "unparsed body",
		});
		const init: RequestInit = { headers: { "x-init": "yes" } };

		const response = await fetchFn(request, init);

		assert.equal(calls.length, 1);
		assert.equal(calls[0].input, request);
		assert.equal(calls[0].init, init);
		assert.equal(response, bindingResponse);
		assert.equal(await response.text(), "data: {}\n\n");
	});

	it("ignores legacy baseUrl and gateway translation options", async () => {
		const { binding, calls } = fakeFetchBinding();
		const fetchFn = createGatewayBindingFetch({
			binding,
			baseUrl: "https://gateway.ai.cloudflare.com/v1/wrong-account/wrong-gateway",
			gateway: "wrong-gateway",
		});
		const url = "https://workers-binding.ai/ai-gateway/gateways/real-gateway/openai/responses";

		await fetchFn(url, { method: "GET" });

		assert.equal(calls.length, 1);
		assert.equal(calls[0].input, url);
		assert.deepEqual(calls[0].init, { method: "GET" });
	});

	it("rejects a binding without fetch() at construction", () => {
		assert.throws(
			() =>
				createGatewayBindingFetch({
					binding: { aiGatewayLogId: null } as unknown as AiGatewayBinding,
					...PASSTHROUGH_OPTIONS,
				}),
			/does not expose fetch\(\)/,
		);
	});

	it("keeps SDK-generated provider auth headers off the passthrough when explicitly nulled", async () => {
		const { binding, calls } = fakeFetchBinding(
			Response.json({ error: { type: "bad_request", message: "stubbed" } }, { status: 400 }),
		);
		const model: Model<"openai-completions"> = {
			id: "test-model",
			name: "Test Model",
			api: "openai-completions",
			provider: "openai",
			baseUrl: `${BINDING_PREFIX}/openai`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10_000,
			maxTokens: 1_000,
		};

		const result = await streamOpenAICompletions(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				headers: {
					"cf-aig-authorization": `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
					Authorization: null,
					"x-api-key": null,
				},
				fetch: createGatewayBindingFetch({ binding, ...PASSTHROUGH_OPTIONS }),
				maxRetries: 0,
			},
		).result();

		assert.equal(result.stopReason, "error");
		assert.equal(calls.length, 1);
		const initHeaders = new Headers(calls[0].init?.headers);
		assert.equal(initHeaders.has("authorization"), false);
		assert.equal(initHeaders.has("x-api-key"), false);
		assert.equal(initHeaders.get("cf-aig-authorization"), `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`);
	});
});
