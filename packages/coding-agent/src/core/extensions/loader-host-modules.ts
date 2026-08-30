let virtualModules: Record<string, object> | null = null;
let virtualModulesPromise: Promise<Record<string, object>> | null = null;

export async function loadVirtualModules(): Promise<Record<string, object>> {
	const [
		typebox,
		typeboxCompile,
		typeboxValue,
		piAgentCore,
		piTui,
		piTuiLayout,
		piAi,
		piAiOauth,
		piAiCloudflareGatewayBinding,
		properLockfile,
		piCodingAgent,
	] = await Promise.all([
		import("typebox"),
		import("typebox/compile"),
		import("typebox/value"),
		import("@earendil-works/pi-agent-core"),
		import("@earendil-works/pi-tui"),
		import("@earendil-works/pi-tui/dist/layout.js"),
		// pi 0.80.2: the old global pi-ai API moved off the root entrypoint onto
		// `/compat` (a strict superset). Extensions still use the root specifier.
		import("@bastani/pi-ai/compat"),
		import("@bastani/pi-ai/oauth"),
		import("@bastani/pi-ai/api/cloudflare-gateway-binding"),
		// Keep proper-lockfile in the compiled host so extensions share its live
		// CommonJS module state instead of evaluating it through jiti.
		import("proper-lockfile"),
		// loader.ts exports are not re-exported from index.ts, avoiding a cycle.
		import("../../index.ts"),
	]);

	return {
		typebox,
		"typebox/compile": typeboxCompile,
		"typebox/value": typeboxValue,
		"@sinclair/typebox": typebox,
		"@sinclair/typebox/compile": typeboxCompile,
		"@sinclair/typebox/value": typeboxValue,
		"@earendil-works/pi-agent-core": piAgentCore,
		"@earendil-works/pi-tui": piTui,
		"@earendil-works/pi-tui/dist/layout.js": piTuiLayout,
		"@bastani/pi-ai": piAi,
		"@bastani/pi-ai/compat": piAi,
		"@bastani/pi-ai/oauth": piAiOauth,
		"@bastani/pi-ai/api/cloudflare-gateway-binding": piAiCloudflareGatewayBinding,
		"@earendil-works/pi-ai": piAi,
		"@earendil-works/pi-ai/compat": piAi,
		"@earendil-works/pi-ai/oauth": piAiOauth,
		"@earendil-works/pi-ai/api/cloudflare-gateway-binding": piAiCloudflareGatewayBinding,
		"proper-lockfile": properLockfile,
		"@bastani/atomic": piCodingAgent,
		"@mariozechner/pi-agent-core": piAgentCore,
		"@mariozechner/pi-tui": piTui,
		"@mariozechner/pi-tui/dist/layout.js": piTuiLayout,
		"@mariozechner/pi-ai": piAi,
		"@mariozechner/pi-ai/compat": piAi,
		"@mariozechner/pi-ai/oauth": piAiOauth,
		"@mariozechner/pi-ai/api/cloudflare-gateway-binding": piAiCloudflareGatewayBinding,
	};
}

/** Modules shared with extensions in Bun single-file builds. */
export async function getVirtualModules(): Promise<Record<string, object>> {
	if (virtualModules) return virtualModules;
	virtualModulesPromise ??= loadVirtualModules().then(
		(modules) => {
			virtualModules = modules;
			return modules;
		},
		(error: Error) => {
			virtualModulesPromise = null;
			throw error;
		},
	);
	return virtualModulesPromise;
}
