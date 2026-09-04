import { describe, expect, it } from "vitest";
import { resolveGoogleThinkingLevel } from "../src/api/google-shared.ts";
import { getModel, getModels, getProviders } from "../src/compat.ts";
import type { Api, Model } from "../src/types.ts";

/**
 * Catalog regressions for Gemini 3.8 Flash in the shipped, hydrated provider catalogs.
 *
 * Every Google-side value asserted here is published by Google and mirrored by models.dev
 * (GA, released 2026-09-02):
 * - https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-flash
 * - https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-flash
 * - https://deepmind.google/models/model-cards/gemini-3-8-flash/
 * 1,048,576 context, 65,536 max output, text/image/video/audio/pdf in, text out,
 * thinking with effort levels low | medium | high, $0.75 / $3.75 / $0.075 cache read.
 *
 * GitHub shipped the model in Copilot on 2026-09-03:
 * - https://github.blog/changelog/2026-09-03-gemini-3-8-flash-is-now-available-in-github-copilot/
 * - https://docs.github.com/en/copilot/reference/ai-models/model-comparison
 * GitHub publishes no limits or pricing for it, and models.dev carries no `github-copilot`
 * entry, so those fields are inherited from Copilot's own `gemini-3.7-flash` entry. The
 * assertions below therefore compare Copilot against its sibling rather than against Google.
 *
 * These `getModel(...)` calls are also the compile-time proof of typed catalog lookup:
 * `getBuiltinModel` constrains the model id to `keyof (typeof MODELS)[TProvider]`, and this
 * package typechecks `test/**`, so an absent id fails the build rather than only the run.
 */

describe("Gemini 3.8 Flash Google catalogs", () => {
	it("publishes the documented Gemini API limits, pricing, and capabilities", () => {
		const model = getModel("google", "gemini-3.8-flash");

		expect(model).toBeDefined();
		expect(model.id).toBe("gemini-3.8-flash");
		expect(model.name).toBe("Gemini 3.8 Flash");
		expect(model.provider).toBe("google");
		expect(model.api).toBe("google-generative-ai");
		expect(model.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
		expect(model.reasoning).toBe(true);
		expect(model.contextWindow).toBe(1_048_576);
		expect(model.maxTokens).toBe(65_536);
		// `Model.input` advertises what Atomic can serialize on this API, not every modality
		// Google accepts, so the published five input modalities collapse to text+image.
		expect(model.input).toEqual(["text", "image"]);
		expect(model.cost).toEqual({ input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 });
	});

	it("publishes the same model on Vertex under the plain, unprefixed model id", () => {
		const model = getModel("google-vertex", "gemini-3.8-flash");

		expect(model).toBeDefined();
		// Vertex names this model `gemini-3.8-flash`, with no `publishers/google/models/` prefix.
		expect(model.id).toBe("gemini-3.8-flash");
		expect(model.provider).toBe("google-vertex");
		expect(model.api).toBe("google-vertex");
		expect(model.baseUrl).toBe("https://{location}-aiplatform.googleapis.com");
		expect(model.reasoning).toBe(true);
		expect(model.contextWindow).toBe(1_048_576);
		expect(model.maxTokens).toBe(65_536);
		expect(model.input).toEqual(["text", "image"]);
		// Vertex accounts only cachedContentTokenCount as a cache read; there is no cache write price.
		expect(model.cost).toEqual({ input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 });
	});

	// Gemini 3.x Flash always thinks; `off` is denied rather than mapped. Everything else falls
	// through to `resolveGoogleThinkingLevel`, which is pre-existing shared behavior with
	// gemini-3.6/3.7-flash and is pinned here so a reviewer does not read it as new.
	it("denies thinking off and resolves the remaining levels like its Gemini 3 Flash siblings", () => {
		for (const provider of ["google", "google-vertex"] as const) {
			const model = getModel(provider, "gemini-3.8-flash") as Model<"google-generative-ai" | "google-vertex">;

			expect(model.thinkingLevelMap?.off, provider).toBeNull();
			expect(resolveGoogleThinkingLevel(model, "off"), provider).toBe("high");
			expect(resolveGoogleThinkingLevel(model, "low"), provider).toBe("low");
			expect(resolveGoogleThinkingLevel(model, "medium"), provider).toBe("medium");
			expect(resolveGoogleThinkingLevel(model, "high"), provider).toBe("high");
			// `xhigh`/`max` are unmapped for every Gemini entry and must stay rejected.
			expect(() => resolveGoogleThinkingLevel(model, "xhigh")).toThrow();
			expect(() => resolveGoogleThinkingLevel(model, "max")).toThrow();
		}
	});
});

describe("Gemini 3.8 Flash GitHub Copilot catalog", () => {
	it("routes through Copilot's OpenAI-compatible endpoint rather than Google's API", () => {
		const model = getModel("github-copilot", "gemini-3.8-flash");

		expect(model).toBeDefined();
		expect(model.id).toBe("gemini-3.8-flash");
		expect(model.name).toBe("Gemini 3.8 Flash");
		expect(model.provider).toBe("github-copilot");
		expect(model.api).toBe("openai-completions");
		expect(model.baseUrl).toBe("https://api.individual.githubcopilot.com");
		expect(model.reasoning).toBe(true);
		expect(model.input).toEqual(["text", "image"]);
		expect(model.headers?.["Copilot-Integration-Id"]).toBe("vscode-chat");
		expect(model.compat).toMatchObject({
			supportsStore: false,
			supportsDeveloperRole: false,
			// Copilot's completions endpoint does not accept `reasoning_effort`.
			supportsReasoningEffort: false,
		});
		expect(model.thinkingLevelMap).toBeUndefined();
	});

	it("carries Copilot's platform limits, not Google's, for the fields GitHub does not publish", () => {
		const model = getModel("github-copilot", "gemini-3.8-flash");
		const sibling = getModel("github-copilot", "gemini-3.7-flash");

		// Inherited from the Copilot sibling, and deliberately different from Google's 65,536.
		expect(model.contextWindow).toBe(sibling.contextWindow);
		expect(model.maxTokens).toBe(sibling.maxTokens);
		expect(model.cost).toEqual(sibling.cost);
		expect(model.maxTokens).not.toBe(getModel("google", "gemini-3.8-flash").maxTokens);
	});

	// GitHub's "Models with extended capabilities" table does not list any Gemini model, so the
	// Copilot extended-context override must not pick this one up.
	it("is not promoted into Copilot's extended-context set", () => {
		expect(getModel("github-copilot", "gemini-3.8-flash").contextWindow).toBe(
			getModel("github-copilot", "gemini-3.7-flash").contextWindow,
		);
	});
});

describe("Gemini 3.8 Flash catalog coverage", () => {
	it("is available on every built-in provider whose catalog advertises it", () => {
		const mirrors = getProviders()
			.flatMap((provider) => getModels(provider) as Model<Api>[])
			.filter((model) => /(^|\/)gemini-3\.8-flash(:|$)/.test(model.id));

		const providers = new Set(mirrors.map((model) => model.provider));
		// Named explicitly by the acceptance contract.
		expect(providers).toContain("google");
		expect(providers).toContain("google-vertex");
		expect(providers).toContain("github-copilot");

		// Anything else that lands does so from that provider's own live catalog. Assert the
		// invariants rather than a fixed provider list, so an upstream catalog change is not a
		// spurious failure here.
		for (const model of mirrors) {
			expect(model.reasoning, `${model.provider}/${model.id}`).toBe(true);
			expect(model.input, `${model.provider}/${model.id}`).toContain("text");
			expect(model.contextWindow, `${model.provider}/${model.id}`).toBeGreaterThan(0);
			expect(model.maxTokens, `${model.provider}/${model.id}`).toBeGreaterThan(0);
		}
	});
});
