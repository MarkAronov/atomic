/**
 * AI Gateway transport over the Workers AI binding.
 *
 * `createGatewayBindingFetch` returns a {@link FetchFunction} backed by the binding's
 * plain `env.AI.fetch()` passthrough. Requests are forwarded untouched, so methods,
 * headers, query strings, non-JSON bodies, and streaming bodies retain native fetch
 * semantics. Models using that route should point their `baseUrl` at
 * `https://workers-binding.ai/ai-gateway/gateways/{gateway}/{provider}`.
 *
 * Bindings that only expose `gateway(id).run(...)` are not supported. Use a current
 * Workers AI binding with `fetch()`.
 */

import type { FetchFunction } from "../types.ts";

/**
 * Structural type for the Workers AI binding's gateway surface (`env.AI`), so this
 * module does not depend on `@cloudflare/workers-types`. Any real `Ai` binding satisfies it.
 */
export interface AiGatewayBinding {
	/** Unique member of the Workers AI binding. */
	aiGatewayLogId?: string | null;
	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

/** @deprecated Universal-endpoint surface. No longer used by `createGatewayBindingFetch`. */
export interface AiGatewayBindingGateway {
	run(data: AiGatewayUniversalRequestLike, options?: { signal?: AbortSignal }): Promise<Response>;
}

/** One universal-endpoint request entry, as accepted by `AiGateway.run()`. */
export interface AiGatewayUniversalRequestLike {
	provider: string;
	endpoint: string;
	headers: Record<string, string>;
	query: unknown;
}

/**
 * Placeholder value for auth headers on binding-routed requests. API implementations
 * require an API key or a recognized auth header (`authorization`, `x-api-key`,
 * `cf-aig-authorization`) before dispatch; binding calls are pre-authenticated, so pass
 * `cf-aig-authorization: Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}` to satisfy
 * the check. The gateway recognizes and strips the sentinel. Pair it with
 * `Authorization: null` / `x-api-key: null` so the SDKs' placeholder auth headers never reach
 * the gateway.
 */
export const CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL = "cloudflare-gateway-binding";

export interface GatewayBindingFetchOptions {
	/** The Workers AI binding (e.g. `env.AI`). Must expose `fetch()`. */
	binding: AiGatewayBinding;
	/** Ignored. Retained so existing call sites compile. */
	baseUrl?: string;
	/** Ignored. Retained so existing call sites compile. */
	gateway?: string;
}

/**
 * Create a `fetch` that routes AI Gateway requests through the Workers AI binding.
 */
export function createGatewayBindingFetch(options: GatewayBindingFetchOptions): FetchFunction {
	const fetchFn = options.binding.fetch;
	if (typeof fetchFn !== "function") {
		throw new TypeError("createGatewayBindingFetch: the AI binding does not expose fetch()");
	}
	return fetchFn.bind(options.binding);
}
