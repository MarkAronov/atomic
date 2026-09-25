import assert from "node:assert/strict";
import type { Api, ClassifierContext, ClassifierModel, Model } from "@bastani/pi-ai";
import { getBuiltinClassifierModel } from "@bastani/pi-ai/providers/all";
import { test } from "vitest";
import {
	type ModelRoutingContext,
	routeExecutionModel,
} from "../../packages/coding-agent/src/core/execution-model-router.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { deepMergeSettings } from "../../packages/coding-agent/src/core/settings-merge.js";
import type { ModelRoutingSettings } from "../../packages/coding-agent/src/core/settings-types.js";
import { workflowModelCatalogFromContext } from "../../packages/workflows/src/extension/workflow-model-catalog.js";

const jev = getBuiltinClassifierModel("typesafe", "jev-latest") as ClassifierModel<Api>;

function chatModel(provider: string, id: string): Model<Api> {
	return {
		type: "chat",
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_000,
	} as Model<Api>;
}

const models = [
	chatModel("github-copilot", "claude-opus-5.5"),
	chatModel("anthropic", "claude-opus-5-5"),
	chatModel("openrouter", "anthropic/claude-opus-5.5"),
];

function routingContext(modelRouting?: ModelRoutingSettings) {
	const offered: string[][] = [];
	const ctx: ModelRoutingContext = {
		model: models[0],
		getRouterModel: () => "typesafe/jev-latest",
		...(modelRouting ? { getModelRouting: () => modelRouting } : {}),
		modelRegistry: {
			getAvailable: () => models,
			getAll: () => models,
			streamSimple: () => {
				throw new Error("classifier routing only");
			},
			containsConfiguredCredential: async () => false,
			getClassifierModel: () => jev,
			classify: async (_model: ClassifierModel<Api>, context: ClassifierContext) => {
				const question = context.questions.pair;
				assert.ok(question?.type === "choice");
				const keys = Object.keys(question.criteria);
				offered.push(keys.map((key) => (JSON.parse(question.criteria[key]!) as { model: string }).model));
				return {
					api: jev.api,
					provider: jev.provider,
					model: jev.id,
					stopReason: "stop",
					timestamp: 0,
					answers: { pair: { type: "choice", choice: keys[0]!, probabilities: {}, confidence: 1 } },
				};
			},
		},
	};
	return { ctx, offered };
}

const route = (ctx: ModelRoutingContext) =>
	routeExecutionModel({ ctx, task: "Review the change", agent: { name: "reviewer", description: "Reviews code" } });

test("settings expose validated, de-duplicated modelRouting provider lists", () => {
	assert.deepEqual(SettingsManager.inMemory().getModelRouting(), {});
	assert.deepEqual(
		SettingsManager.inMemory({
			modelRouting: { allowedProviders: ["github-copilot", "github-copilot"], excludedProviders: ["openrouter"] },
		}).getModelRouting(),
		{ allowedProviders: ["github-copilot"], excludedProviders: ["openrouter"] },
	);
	for (const modelRouting of [
		{ allowedProviders: "github-copilot" },
		{ excludedProviders: [" openrouter"] },
		{ excludedProviders: [""] },
		["github-copilot"],
	])
		assert.throws(
			() => SettingsManager.inMemory({ modelRouting } as never).getModelRouting(),
			/Invalid modelRouting/u,
		);
});

test("a project list replaces the global list of the same name and keeps the other", () => {
	const merged = deepMergeSettings(
		{ modelRouting: { allowedProviders: ["github-copilot", "anthropic"], excludedProviders: ["openrouter"] } },
		{ modelRouting: { allowedProviders: ["anthropic"] } },
	);
	assert.deepEqual(merged.modelRouting, { allowedProviders: ["anthropic"], excludedProviders: ["openrouter"] });
});

test("without modelRouting every available provider is a candidate", async () => {
	const { ctx, offered } = routingContext();
	await route(ctx);
	assert.deepEqual(offered[0]?.sort(), models.map((model) => `${model.provider}/${model.id}`).sort());
});

test("excluded providers are never offered, even when they are allowed", async () => {
	const excluded = routingContext({ excludedProviders: ["openrouter", "anthropic"] });
	const result = await route(excluded.ctx);
	assert.deepEqual(excluded.offered.flat(), ["github-copilot/claude-opus-5.5"]);
	assert.equal(result.routerSelection.model, "github-copilot/claude-opus-5.5");

	const both = routingContext({ allowedProviders: ["github-copilot", "anthropic"], excludedProviders: ["anthropic"] });
	await route(both.ctx);
	assert.deepEqual([...new Set(both.offered.flat())], ["github-copilot/claude-opus-5.5"]);
});

test("allowed providers restrict candidates to that list", async () => {
	const { ctx, offered } = routingContext({ allowedProviders: ["anthropic", "openrouter"] });
	await route(ctx);
	assert.deepEqual([...new Set(offered.flat())].sort(), [
		"anthropic/claude-opus-5-5",
		"openrouter/anthropic/claude-opus-5.5",
	]);
});

test("filters that leave no candidate name the modelRouting setting", async () => {
	const { ctx } = routingContext({ allowedProviders: ["openai-codex"] });
	await assert.rejects(route(ctx), /modelRouting allowedProviders\/excludedProviders/u);
});

test("a recorded decision from a provider excluded since then is no longer eligible on resume", async () => {
	const { ctx } = routingContext({ excludedProviders: ["anthropic"] });
	await assert.rejects(
		routeExecutionModel({
			ctx,
			task: "Review the change",
			agent: { name: "reviewer", description: "Reviews code" },
			selection: { model: "anthropic/claude-opus-5-5", effort: null },
		}),
		/no longer eligible/u,
	);
});

test("workflow stage routing applies the host's modelRouting providers", async () => {
	const { ctx, offered } = routingContext();
	const catalog = workflowModelCatalogFromContext({
		...ctx,
		getModelRouting: () => ({ allowedProviders: ["github-copilot"] }),
	} as never);
	assert.ok(catalog?.routeModel);
	const result = await catalog.routeModel({ task: "Review the change", stageName: "review" } as never);
	assert.equal(result.routerSelection.model, "github-copilot/claude-opus-5.5");
	assert.deepEqual([...new Set(offered.flat())], ["github-copilot/claude-opus-5.5"]);
});
