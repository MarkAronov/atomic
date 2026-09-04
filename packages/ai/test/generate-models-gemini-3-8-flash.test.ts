import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, test } from "vitest";

/**
 * Deterministic generator regressions for Gemini 3.8 Flash.
 *
 * The fixture below mirrors the models.dev entries published for this model
 * (release date 2026-09-02, GA) so these assertions do not drift with the live catalog:
 * - https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-flash
 * - https://deepmind.google/models/model-cards/gemini-3-8-flash/
 *
 * models.dev publishes no `github-copilot` entry for the model even though GitHub shipped it
 * on 2026-09-03, so the generator supplements it from the Copilot `gemini-3.7-flash` sibling.
 * The last test pins that the supplement retires itself once models.dev catches up.
 */

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

type GeneratedModel = {
	id: string;
	name: string;
	api: string;
	provider: string;
	baseUrl: string;
	reasoning: boolean;
	input: string[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	headers?: Record<string, string>;
	thinkingLevelMap?: Record<string, string | null>;
	compat?: Record<string, unknown>;
};
type GeneratedProviderCatalog = Record<string, Record<string, GeneratedModel>>;

function generateProviderCatalogs(catalog: unknown, providers: readonly string[]): GeneratedProviderCatalog {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-generate-gemini-3-8-flash-"));
	temporaryRoots.push(fixtureRoot);
	const isolatedPackageRoot = join(fixtureRoot, "package");
	mkdirSync(isolatedPackageRoot);
	for (const entry of ["package.json", "scripts", "src"]) {
		cpSync(join(packageRoot, entry), join(isolatedPackageRoot, entry), { recursive: true });
	}

	const preloadPath = join(fixtureRoot, "mock-model-apis.mjs");
	writeFileSync(
		preloadPath,
		`const catalog = ${JSON.stringify(catalog)};\n` +
			`globalThis.fetch = async (input) => {\n` +
			`  const url = String(input);\n` +
			`  if (url === "https://models.dev/api.json") return new Response(JSON.stringify(catalog), { status: 200 });\n` +
			`  return new Response(JSON.stringify({ data: [] }), { status: 200 });\n` +
			`};\n`,
	);

	const outputPath = join(fixtureRoot, "catalog");
	const result = spawnSync(
		process.execPath,
		[
			"--import",
			pathToFileURL(preloadPath).href,
			"scripts/generate-models.ts",
			"--json-only",
			"--json-output",
			outputPath,
		],
		{ cwd: isolatedPackageRoot, encoding: "utf8", timeout: 30_000 },
	);
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

	const catalogs: GeneratedProviderCatalog = {};
	for (const provider of providers) {
		// `--json-output` writes one flat model map per provider, with `api` on each model.
		catalogs[provider] = JSON.parse(readFileSync(join(outputPath, `providers/${provider}.json`), "utf8")) as Record<
			string,
			GeneratedModel
		>;
	}
	return catalogs;
}

// models.dev's `google` and `google-vertex` entries for this model are byte-identical.
const GEMINI_3_8_FLASH = {
	name: "Gemini 3.8 Flash",
	family: "gemini-flash",
	attachment: true,
	reasoning: true,
	reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
	tool_call: true,
	structured_output: true,
	temperature: true,
	release_date: "2026-09-02",
	last_updated: "2026-09-02",
	modalities: { input: ["text", "image", "video", "audio", "pdf"], output: ["text"] },
	limit: { context: 1_048_576, output: 65_536 },
	cost: { input: 0.75, output: 3.75, cache_read: 0.075, input_audio: 0.75 },
} as const;

// The Copilot sibling the supplement inherits its platform-specific limits and pricing from.
const COPILOT_GEMINI_3_7_FLASH = {
	name: "Gemini 3.7 Flash",
	reasoning: true,
	reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
	tool_call: true,
	modalities: { input: ["text", "image"], output: ["text"] },
	limit: { context: 1_000_000, input: 936_000, output: 64_000 },
	cost: { input: 0.75, output: 3.75, cache_read: 0.075 },
} as const;

const BASE_CATALOG = {
	google: { models: { "gemini-3.8-flash": GEMINI_3_8_FLASH } },
	"google-vertex": {
		models: {
			"gemini-3.8-flash": GEMINI_3_8_FLASH,
			// A non-Gemini Vertex MaaS entry must stay excluded from the Gemini-only Vertex provider.
			"claude-opus-5": {
				name: "Claude Opus 5",
				tool_call: true,
				reasoning: true,
				limit: { context: 200_000, output: 64_000 },
				cost: { input: 5, output: 25 },
			},
		},
	},
	"github-copilot": { models: { "gemini-3.7-flash": COPILOT_GEMINI_3_7_FLASH } },
	// A provider with no Gemini entry must never sprout a mirrored one.
	anthropic: {
		models: {
			"claude-opus-5": {
				name: "Claude Opus 5",
				tool_call: true,
				reasoning: true,
				limit: { context: 200_000, output: 64_000 },
				cost: { input: 5, output: 25 },
			},
		},
	},
} as const;

test("generates the documented Gemini 3.8 Flash entry for the Google Gemini API", () => {
	const { google } = generateProviderCatalogs(BASE_CATALOG, ["google"]);
	const model = google["gemini-3.8-flash"];

	assert.ok(model, "expected google/gemini-3.8-flash to be generated");
	assert.equal(model.id, "gemini-3.8-flash");
	assert.equal(model.name, "Gemini 3.8 Flash");
	assert.equal(model.provider, "google");
	assert.equal(model.api, "google-generative-ai");
	assert.equal(model.baseUrl, "https://generativelanguage.googleapis.com/v1beta");
	assert.equal(model.reasoning, true);
	assert.equal(model.contextWindow, 1_048_576);
	assert.equal(model.maxTokens, 65_536);
	// `Model.input` describes what Atomic can serialize, not everything the model accepts, so
	// the five models.dev input modalities collapse to text+image on the Gemini path.
	assert.deepEqual(model.input, ["text", "image"]);
	assert.deepEqual(model.cost, { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 });
	// Gemini 3.x Flash cannot disable thinking; every other level falls back to
	// `resolveGoogleThinkingLevel`, exactly as for gemini-3.7-flash.
	assert.equal(model.thinkingLevelMap?.off, null);
});

test("generates the Vertex Gemini 3.8 Flash entry without inventing non-Gemini mirrors", () => {
	const catalogs = generateProviderCatalogs(BASE_CATALOG, ["google-vertex", "anthropic"]);
	const vertex = catalogs["google-vertex"];
	const model = vertex["gemini-3.8-flash"];

	assert.ok(model, "expected google-vertex/gemini-3.8-flash to be generated");
	// Vertex publishes the plain model id, with no `publishers/google/models/` prefix.
	assert.equal(model.id, "gemini-3.8-flash");
	assert.equal(model.provider, "google-vertex");
	assert.equal(model.api, "google-vertex");
	assert.equal(model.baseUrl, "https://{location}-aiplatform.googleapis.com");
	assert.equal(model.reasoning, true);
	assert.equal(model.contextWindow, 1_048_576);
	assert.equal(model.maxTokens, 65_536);
	assert.deepEqual(model.input, ["text", "image"]);
	// Vertex accounts only cachedContentTokenCount, so cacheWrite is always 0 on this path.
	assert.deepEqual(model.cost, { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 });
	assert.equal(model.thinkingLevelMap?.off, null);

	// Negative controls: the Vertex provider serves only Gemini, and no unrelated provider
	// gains a Gemini 3.8 Flash entry it does not publish.
	assert.equal(vertex["claude-opus-5"], undefined);
	assert.equal(catalogs.anthropic["gemini-3.8-flash"], undefined);
});

test("supplements the GitHub Copilot entry with Copilot's own routing, headers, and limits", () => {
	const copilot = generateProviderCatalogs(BASE_CATALOG, ["github-copilot"])["github-copilot"];
	const model = copilot["gemini-3.8-flash"];

	assert.ok(model, "expected github-copilot/gemini-3.8-flash to be supplemented");
	assert.equal(model.id, "gemini-3.8-flash");
	assert.equal(model.name, "Gemini 3.8 Flash");
	assert.equal(model.provider, "github-copilot");
	// Copilot serves Gemini through its OpenAI-compatible endpoint, not Google's API.
	assert.equal(model.api, "openai-completions");
	assert.equal(model.baseUrl, "https://api.individual.githubcopilot.com");
	assert.equal(model.reasoning, true);
	assert.deepEqual(model.input, ["text", "image"]);
	// Inherited from Copilot's gemini-3.7-flash entry, not from Google's own catalog: Copilot
	// publishes platform-specific limits, and its 1M/64K window differs from Google's 1M/65,536.
	assert.equal(model.contextWindow, 1_000_000);
	assert.equal(model.maxTokens, 64_000);
	assert.deepEqual(model.cost, { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 });
	assert.deepEqual(model.headers, {
		"User-Agent": "GitHubCopilotChat/0.35.0",
		"Editor-Version": "vscode/1.107.0",
		"Editor-Plugin-Version": "copilot-chat/0.35.0",
		"Copilot-Integration-Id": "vscode-chat",
	});
	assert.deepEqual(model.compat, {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
	});
	// Copilot's OpenAI-compatible endpoint does not accept `reasoning_effort`, so models.dev's
	// effort options must not become a thinking level map here.
	assert.equal(model.thinkingLevelMap, undefined);
	// The sibling it is sourced from stays untouched and is not duplicated.
	assert.equal(copilot["gemini-3.7-flash"]?.maxTokens, 64_000);
});

test("yields to models.dev once it publishes the GitHub Copilot entry", () => {
	const catalog = {
		...BASE_CATALOG,
		"github-copilot": {
			models: {
				"gemini-3.7-flash": COPILOT_GEMINI_3_7_FLASH,
				"gemini-3.8-flash": {
					...COPILOT_GEMINI_3_7_FLASH,
					name: "Gemini 3.8 Flash (upstream)",
					limit: { context: 512_000, output: 32_000 },
					cost: { input: 1.5, output: 7.5, cache_read: 0.15 },
				},
			},
		},
	};

	const copilot = generateProviderCatalogs(catalog, ["github-copilot"])["github-copilot"];

	assert.equal(Object.keys(copilot).filter((id) => id === "gemini-3.8-flash").length, 1);
	// Every asserted field comes from models.dev, proving the supplement did not override it.
	assert.equal(copilot["gemini-3.8-flash"].name, "Gemini 3.8 Flash (upstream)");
	assert.equal(copilot["gemini-3.8-flash"].contextWindow, 512_000);
	assert.equal(copilot["gemini-3.8-flash"].maxTokens, 32_000);
	assert.deepEqual(copilot["gemini-3.8-flash"].cost, {
		input: 1.5,
		output: 7.5,
		cacheRead: 0.15,
		cacheWrite: 0,
	});
});

test("does not supplement Copilot when the sibling it inherits from is absent", () => {
	const catalog = {
		...BASE_CATALOG,
		"github-copilot": {
			models: {
				"claude-opus-5": {
					name: "Claude Opus 5",
					tool_call: true,
					reasoning: true,
					limit: { context: 200_000, output: 64_000 },
					cost: { input: 5, output: 25 },
				},
			},
		},
	};

	const copilot = generateProviderCatalogs(catalog, ["github-copilot"])["github-copilot"];

	assert.equal(copilot["gemini-3.8-flash"], undefined);
	assert.ok(copilot["claude-opus-5"], "expected the unrelated Copilot entry to survive");
});
