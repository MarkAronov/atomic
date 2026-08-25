import { expect, test } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionAPI } from "../src/core/extensions/loader-api.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader-runtime.ts";
import type { Extension, ProviderConfig } from "../src/core/extensions/types.ts";

function extension(path: string): Extension {
	return {
		path,
		resolvedPath: path,
		sourceInfo: { path, source: "test", scope: "user", origin: "top-level", configurationOrigin: "bundled" },
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		entryRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

const providerConfig: ProviderConfig = {
	baseUrl: "https://provider.test/v1",
	apiKey: "provider-test-key",
	api: "openai-completions",
	models: [
		{
			id: "instant-model",
			name: "Instant Model",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.75 },
			contextWindow: 128000,
			maxTokens: 4096,
		},
	],
};

test("rolls back providers applied before a failed commit", () => {
	const runtime = createExtensionRuntime();
	const originalRegister = runtime.registerProvider.bind(runtime);
	let calls = 0;
	runtime.registerProvider = ((nameOrProvider, configOrPath, extensionPath) => {
		calls += 1;
		if (calls === 2) throw new Error("second provider failed");
		originalRegister(nameOrProvider, configOrPath, extensionPath);
	}) as typeof runtime.registerProvider;

	const { api, commit, discard } = createExtensionAPI(extension("multi"), runtime, "/tmp", createEventBus());
	api.registerProvider("first", providerConfig);
	api.registerProvider("second", { ...providerConfig, baseUrl: "https://provider-two.test/v1" });

	expect(() => commit()).toThrow("second provider failed");
	discard();
	expect(
		runtime.pendingProviderRegistrations.map((registration) =>
			"provider" in registration ? registration.provider.id : registration.name,
		),
	).toEqual([]);
});
