import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type Api,
	containsKnownEnvCredential,
	getSupportedThinkingLevels,
	isModelType,
	type Model,
} from "@bastani/pi-ai";
import { Type } from "typebox";
import { getDocsPath } from "../config.js";
import type { ModelRegistry } from "./model-registry.ts";
import { jsonBytes, ROUTING_REQUEST_BYTES, TRUNCATED_MARKER, truncateToBytes } from "./model-routing-bytes.js";
import {
	eligiblePair,
	type ModelConstraints,
	type ModelRouterOutput,
	parseModelConstraints,
} from "./model-routing-constraints.js";
import { candidateReleaseDate, catalogEvidence, parseEvalsCatalog } from "./model-routing-evals.js";
import { packRoutingBatches, seededCandidateOrder } from "./model-routing-tournament.js";
import type { ModelRoutingSettings } from "./settings-types.ts";
import { resolveRouterModel, routeModel } from "./structured-output/index.js";

export interface ModelRoutingContext {
	readonly modelRegistry: Pick<
		ModelRegistry,
		"getAll" | "getAvailable" | "streamSimple" | "containsConfiguredCredential"
	> &
		Partial<Pick<ModelRegistry, "getProviderAuthStatus" | "getProviderAuth" | "getClassifierModel" | "classify">>;
	readonly model?: Model<Api>;
	getRouterModel(): string;
	/** Provider filters from settings.json `modelRouting`; absent means every provider is a candidate. */
	getModelRouting?(): ModelRoutingSettings;
}
export interface ModelRoute {
	readonly routerSelection: ModelRouterOutput;
	readonly modelOverride: string;
	readonly fallbackModels?: readonly string[];
	assertCurrent(): void;
	allowsModel(model: Model<Api>, effort?: string): boolean;
}

interface RouterWireDecision {
	modelId: string;
	reasoningEffort: string | null;
}

interface RoutingPair {
	readonly model: string;
	readonly effort: string | null;
}

interface RoutingGroup {
	readonly model: string;
	readonly entry: Model<Api>;
	readonly pairs: readonly RoutingPair[];
}

/**
 * Total auto-routing inference failure: Jev and the chat structured-output
 * fallback both failed before any model was selected (#3206). Validation,
 * eligibility, and credential-screening errors are never marked.
 */
export class AutoRoutingInferenceError extends Error {
	/**
	 * Route pinned to the current chat model, present only when that model is
	 * available and satisfies every routing constraint. Consumers may degrade
	 * to it; when it is absent the failure stays fatal.
	 */
	readonly currentModelRoute?: ModelRoute;

	constructor(message: string, currentModelRoute?: ModelRoute) {
		super(message);
		this.name = "AutoRoutingInferenceError";
		if (currentModelRoute !== undefined) this.currentModelRoute = currentModelRoute;
	}
}

/** Degraded routes keep a balanced effort when the constraints leave a choice. */
const CURRENT_MODEL_EFFORT_PREFERENCE: readonly (string | null)[] = [
	null,
	"medium",
	"high",
	"low",
	"xhigh",
	"minimal",
	"max",
	"off",
];
const instructions =
	"Select one eligible model/effort pair for `task` and `agent` from the supplied Choice criteria, using `evals` as evidence and `model_selection_guide` as policy. Match the agent role to the guide's model cost tier and thinking level first, then consider task fit, measured effort, release recency (prefer newer comparable models), caveats and cost. Evals cannot add candidates or bypass constraints. Return exactly modelId and reasoningEffort; null reasoningEffort means no configurable reasoning.";

/** Static selection policy sent with every auto-routing request alongside the dated `evals` evidence. */
export const MODEL_SELECTION_GUIDE = `## Benchmarks are evidence, not policy

Benchmark results are measurements under named harnesses, dates, models, efforts, agents, tools, prompts, prices, and scoring rules. Treat a bracketed effort level as the measurement configuration for that row, not a command to run every task at that effort. Compare only records whose measured setup resembles the decision at hand, and keep unmeasured work under ordinary validation rather than inheriting a score.

Missing evidence is unknown, not zero. A rounded lead is not proof of significance. A result for one provider, model version, effort, agent, fallback setting, or benchmark harness does not transfer to another identity.

Prefer recency. Each evals row has a release date. When candidates fit the same role tier and price range, choose the most recently released model over an older one from the same provider or family; a newer release usually supersedes it. Do not let an older model win only because it has no evals row: its missing evidence stays unknown, and a recent comparable model with evidence is the safer choice. Recency does not override the role's cost tier or explicit constraints.

## Role-based thinking effort

Use these starting defaults unless the user requests a level. Higher effort can improve hard reasoning, but it also costs more and can be slower. \`max\` is an exception, not a default.

Price is per task. Candidate cost is USD per million tokens, and roles differ in token volume and in what a mistake costs. High-volume, tool-checked roles such as exploration and routine implementation default to cheaper, faster models; roles where a missed defect is expensive, such as review, verification, and final approval, justify frontier models at high effort. Pick the tier first, then the effort within it; do not compensate for a cheap model with \`max\` or for an expensive one with \`minimal\`.

| Stage role | Default thinking level | Model cost tier | Why |
| --- | --- | --- | --- |
| Codebase exploration: locating files, reading code, tracing call sites | \`minimal\` or \`low\` | Cheap, fast | Tool-driven lookups need speed, not deliberation; escalate to mapping or analysis only when the question becomes a design judgement. |
| Coding, implementation, routine fixes | \`low\` or \`medium\` | Cheap or mid-priced | Runs many times per task and is validated by tools and review afterwards. |
| Code review, test design, failure analysis, security, identity, adversarial challenge, final approval | \`high\` or \`xhigh\` | Frontier | A missed defect is the expensive outcome; spend the strongest model and reasoning here. |
| Codebase mapping, lifecycle analysis, compatibility, planning, synthesis, triage | \`high\` | Frontier or mid-priced | Resolve ambiguity before downstream work depends on it. |
| Orchestration, delegation, and multi-stage coordination | \`medium\` or \`high\` | Mid-priced | Judge scope, sequence work, and integrate results without re-deriving what delegated stages already verified. |
| User-impact review and final reporting | \`medium\` | Mid-priced | Preserve evidence and communicate clearly without unnecessary reasoning. |
| Deterministic checks | No model call | — | Run tests, typechecks, probes, and scripts directly. |

An explicit user request wins over these defaults, but the requested level must exist for the selected catalog entry. Do not invent unsupported suffixes. If \`xhigh\` is unavailable, use \`high\` rather than automatically promoting to \`max\`; choose another catalog model or leave the stage unpinned if neither fits.
`;

const EVALS_BUDGET_ERROR =
	"Auto routing requires a nonempty evals.md document. Repair the Atomic installation or select a concrete execution model.";
// Decision policy, key names and JSON framing the classifier transport adds.
const ROUTING_WIRE_OVERHEAD_BYTES = 1_000;
const PAIR_QUESTION =
	"Which eligible model and reasoning effort best suit this task and agent role, considering the model_selection_guide role tiers, evals, and candidate capabilities and prices? Prefer cheaper candidates for exploration and routine implementation and stronger ones for review and verification. Candidate cost is USD per million tokens, not benchmark task cost.";

type RoutingState = {
	task: string;
	agent: { name: string; description: string };
	evals: string;
	model_selection_guide: string;
};

function requestBytes(state: RoutingState, criteria: Record<string, string>): number {
	return (
		Buffer.byteLength(JSON.stringify({ ...state, instructions, question: PAIR_QUESTION, criteria }), "utf8") +
		ROUTING_WIRE_OVERHEAD_BYTES
	);
}

/**
 * Cut only the routing copy of the evals so the request fits ROUTING_REQUEST_BYTES.
 * The task, candidates, agent and guide are always sent in full.
 */
function fitRoutingEvidence(state: RoutingState, criteria: Record<string, string>): RoutingState {
	const room = Math.max(0, ROUTING_REQUEST_BYTES - requestBytes({ ...state, evals: "" }, criteria));
	return { ...state, evals: truncateToBytes(state.evals, Math.max(jsonBytes(TRUNCATED_MARKER), room)) };
}

async function readModelSelectionEvals(signal?: AbortSignal): Promise<string> {
	try {
		const evals = await readFile(join(getDocsPath(), "models", "evals.md"), { encoding: "utf8", signal });
		if (!evals.trim()) throw new Error(EVALS_BUDGET_ERROR);
		return evals;
	} catch (error) {
		signal?.throwIfAborted();
		if (error instanceof Error && error.message === EVALS_BUDGET_ERROR) throw error;
		throw new Error(EVALS_BUDGET_ERROR);
	}
}

export async function routeExecutionModel(input: {
	ctx: ModelRoutingContext;
	task: string;
	agent: { name: string; description: string };
	constraints?: readonly ModelConstraints[];
	signal?: AbortSignal;
	/** Restore a recorded decision without another inference call. */
	selection?: ModelRouterOutput;
}): Promise<ModelRoute> {
	const { ctx, signal } = input;
	signal?.throwIfAborted();
	const constraints = structuredClone((input.constraints ?? []).map((c) => parseModelConstraints(c)!));
	const { allowedProviders = [], excludedProviders = [] } = ctx.getModelRouting?.() ?? {};
	const providerPermitted = (provider: string) =>
		(allowedProviders.length === 0 || allowedProviders.includes(provider)) && !excludedProviders.includes(provider);
	const catalog = () =>
		ctx.modelRegistry
			.getAvailable()
			.filter((model) => isModelType(model, "chat") && providerPermitted(model.provider))
			.map((model) => ({
				model,
				pairs: (model.reasoning ? getSupportedThinkingLevels(model) : [null])
					.map((effort) => ({ model: `${model.provider}/${model.id}`, effort }))
					.filter((pair) => eligiblePair(model, pair, constraints)),
			}))
			.filter((entry) => entry.pairs.length > 0);
	const available = catalog();
	const pairs = available.flatMap((entry) => entry.pairs);
	if (!pairs.length)
		throw new Error(
			allowedProviders.length || excludedProviders.length
				? "Auto routing has no eligible model/effort pairs. Check configured providers, modelConstraints, and the modelRouting allowedProviders/excludedProviders settings."
				: "Auto routing has no eligible model/effort pairs. Check configured providers and modelConstraints.",
		);
	let selection = input.selection;
	if (selection === undefined) {
		const settings = { getRouterModel: () => ctx.getRouterModel() };
		resolveRouterModel({ settings, currentModel: ctx.model, modelRegistry: ctx.modelRegistry });
		const catalogEvals = parseEvalsCatalog(await readModelSelectionEvals(signal));
		const groups = seededCandidateOrder<RoutingGroup>(
			available.map(({ model, pairs: modelPairs }) => ({
				model: `${model.provider}/${model.id}`,
				entry: model,
				pairs: modelPairs,
			})),
			input.task,
		);
		const allCriteria = new Map<RoutingPair, string>();
		for (const { entry, pairs: modelPairs } of groups) {
			const released = candidateReleaseDate(catalogEvals, `${entry.provider}/${entry.id}`);
			for (const pair of modelPairs)
				allCriteria.set(
					pair,
					JSON.stringify({
						...pair,
						...(released ? { released } : {}),
						input: entry.input,
						contextWindow: entry.contextWindow,
						cost: { ...entry.cost, tiers: (entry.cost.tiers ?? []).map((tier) => ({ ...tier })) },
					}),
				);
		}
		const pairIndex = new Map<RoutingPair, number>(pairs.map((pair, index) => [pair, index]));
		const criteriaFor = (batch: readonly RoutingGroup[]) =>
			Object.fromEntries(
				batch.flatMap((group) =>
					group.pairs.map((pair) => [`pair_${pairIndex.get(pair)}`, allCriteria.get(pair)!]),
				),
			);
		const state = {
			task: input.task,
			agent: { name: input.agent.name, description: input.agent.description },
			evals: catalogEvidence(
				catalogEvals,
				groups.map((group) => group.model),
			),
			model_selection_guide: MODEL_SELECTION_GUIDE,
		};
		if (!state.task.trim()) throw new Error("Auto routing requires task instructions.");
		const serialized = JSON.stringify({ state, criteria: criteriaFor(groups), constraints });
		let configuredCredential: boolean;
		try {
			configuredCredential = await ctx.modelRegistry.containsConfiguredCredential(serialized);
		} catch {
			throw new Error("Auto routing could not screen configured credentials. No inference was performed.");
		}
		if (
			containsKnownEnvCredential(serialized) ||
			configuredCredential ||
			/\bBearer\s+[A-Za-z0-9._~+/-]{8,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk|ghp|github_pat)[-_][A-Za-z0-9_-]{16,}/i.test(
				serialized,
			)
		)
			throw new Error("Auto routing context contains credential material. Remove secrets before retrying.");
		// Screen the full task first: the router receives it unchanged.
		const batchState = (batch: readonly RoutingGroup[]): RoutingState => ({
			...state,
			evals: catalogEvidence(
				catalogEvals,
				batch.map((group) => group.model),
			),
		});
		const fitsWith =
			(task: string) =>
			(batch: readonly RoutingGroup[]): boolean =>
				requestBytes({ ...batchState(batch), task }, criteriaFor(batch)) <= ROUTING_REQUEST_BYTES;
		// A batch fits when the full task, its own evidence and its candidates fit
		// one request. A task too long to leave room for any candidate is never
		// shortened: batches are then sized without it, and a classifier that
		// rejects the oversized request falls back to the current chat model.
		const fitsUntruncated = groups.some((group) => fitsWith(input.task)([group]))
			? fitsWith(input.task)
			: fitsWith("");
		const choose = async (batch: readonly RoutingGroup[]): Promise<ModelRouterOutput> => {
			const batchPairs = batch.flatMap((group) => group.pairs);
			const criteria = criteriaFor(batch);
			// Strict Responses providers reject object unions, and Anthropic rejects an
			// enum under a type array. Enumerate scalar values on the wire with one
			// declared type per enum, then verify the exact model/effort relation.
			const efforts = [...new Set(batchPairs.map((pair) => pair.effort))];
			const stringEfforts = efforts.filter((effort) => effort !== null);
			const stringEffortSchema = { type: "string", enum: stringEfforts };
			const reasoningEffort = !efforts.includes(null)
				? stringEffortSchema
				: stringEfforts.length
					? { anyOf: [stringEffortSchema, { type: "null" }] }
					: { type: "null" };
			const schema = Type.Unsafe<RouterWireDecision>({
				type: "object",
				properties: {
					modelId: Type.String({ enum: batch.map((group) => group.model) }),
					reasoningEffort,
				},
				required: ["modelId", "reasoningEffort"],
				additionalProperties: false,
			});
			const result = await routeModel(
				{
					settings,
					modelRegistry: ctx.modelRegistry,
					currentModel: ctx.model,
					state: fitRoutingEvidence(batchState(batch), criteria),
					instructions,
					schema,
					classifier: {
						questions: {
							pair: {
								instructions: PAIR_QUESTION,
								criteria,
							},
						},
						decode: (choices) => {
							const pair = pairs[Number(choices.pair?.replace(/^pair_/, ""))];
							if (!pair || choices.pair !== `pair_${pairs.indexOf(pair)}`)
								throw new Error("Invalid execution model Choice.");
							return { modelId: pair.model, reasoningEffort: pair.effort };
						},
					},
					signal,
				},
				(value) => batchPairs.some((pair) => pair.model === value.modelId && pair.effort === value.reasoningEffort),
			);
			return { model: result.value.modelId, effort: result.value.reasoningEffort };
		};
		// Knock-out rounds: each batch picks a winner, and winners meet in a final
		// round that is itself batched until it fits one request. Choice
		// probabilities from different batches are never compared.
		const tournament = async (entrants: readonly RoutingGroup[]): Promise<ModelRouterOutput> => {
			const batches = packRoutingBatches(entrants, fitsUntruncated);
			if (batches.length === 1 || batches.every((batch) => batch.length === 1)) return choose(entrants);
			const winners = await Promise.all(batches.map(choose));
			return tournament(entrants.filter((group) => winners.some((winner) => winner.model === group.model)));
		};
		const ranked: ModelRouterOutput[] = [];
		// Degrade only to a current chat model that is available and eligible under
		// the same constraints, restored through the normal selection path (#3206).
		const currentModelRoute = async (): Promise<ModelRoute | undefined> => {
			const current = ctx.model;
			const entry = available.find(
				(candidate) => candidate.model.provider === current?.provider && candidate.model.id === current?.id,
			);
			const pair = CURRENT_MODEL_EFFORT_PREFERENCE.map((effort) =>
				entry?.pairs.find((candidate) => candidate.effort === effort),
			).find((candidate) => candidate !== undefined);
			if (pair === undefined) return undefined;
			return routeExecutionModel({ ...input, selection: { model: pair.model, effort: pair.effort } });
		};
		// Batches are packed once. A later ranking pass reruns only the batch that
		// lost its winner; every other batch keeps its earlier winner.
		const packed = packRoutingBatches(groups, fitsUntruncated);
		const batchWinners = new Map<number, ModelRouterOutput>();
		const isRanked = (model: string) => ranked.some((selected) => selected.model === model);
		const nextWinner = async (): Promise<ModelRouterOutput | undefined> => {
			const live = packed.map((batch) => batch.filter((group) => !isRanked(group.model)));
			if (packed.length === 1 || packed.every((batch) => batch.length === 1)) {
				const remaining = live.flat();
				return remaining.length ? choose(remaining) : undefined;
			}
			const winners = await Promise.all(
				live.map(async (batch, index) => {
					if (!batch.length) return undefined;
					const cached = batchWinners.get(index);
					if (cached && !isRanked(cached.model)) return cached;
					const winner = await choose(batch);
					batchWinners.set(index, winner);
					return winner;
				}),
			);
			const finalists = groups.filter((group) => winners.some((winner) => winner?.model === group.model));
			if (finalists.length <= 1) return winners.find((winner) => winner !== undefined);
			return tournament(finalists);
		};
		// Only a failure before the primary is chosen is a total inference failure:
		// Jev and its chat structured-output fallback both failed (#3206). A failed
		// optional fallback-ranking pass keeps the models already ranked.
		while (ranked.length < Math.min(3, available.length)) {
			let winner: ModelRouterOutput | undefined;
			try {
				winner = await nextWinner();
			} catch (error) {
				signal?.throwIfAborted();
				if (ranked.length > 0) break;
				throw new AutoRoutingInferenceError(
					error instanceof Error ? error.message : String(error),
					await currentModelRoute().catch(() => undefined),
				);
			}
			if (!winner) break;
			ranked.push(winner);
		}
		selection = { ...ranked[0]!, ...(ranked.length > 1 ? { fallbacks: ranked.slice(1) } : {}) };
	}
	const fallbacks = selection.fallbacks?.map((pair) => Object.freeze({ model: pair.model, effort: pair.effort }));
	if (
		fallbacks &&
		(fallbacks.length > 2 ||
			new Set([selection.model, ...fallbacks.map((pair) => pair.model)]).size !== fallbacks.length + 1)
	)
		throw new Error("Invalid ranked auto selection: expected up to three distinct models.");
	const routerSelection = Object.freeze({
		model: selection.model,
		effort: selection.effort,
		...(fallbacks?.length ? { fallbacks: Object.freeze(fallbacks) } : {}),
	});
	const hasPair = (pair: ModelRouterOutput) =>
		catalog().some((entry) => entry.pairs.some((p) => p.model === pair.model && p.effort === pair.effort));
	const allowsModel = (model: Model<Api>, effort?: string): boolean => {
		const levels = model.reasoning ? getSupportedThinkingLevels(model) : [null];
		return levels.some((level) => {
			if (model.reasoning && effort !== undefined && level !== effort) return false;
			const pair = { model: `${model.provider}/${model.id}`, effort: level };
			return eligiblePair(model, pair, constraints) && hasPair(pair);
		});
	};
	const assertCurrent = () => {
		signal?.throwIfAborted();
		if (![routerSelection, ...(routerSelection.fallbacks ?? [])].every(hasPair))
			throw new Error("Auto selection is no longer eligible. Retry explicitly with the current catalog.");
	};
	assertCurrent();
	return {
		routerSelection,
		modelOverride: routerSelection.model + (routerSelection.effort === null ? "" : `:${routerSelection.effort}`),
		fallbackModels: Object.freeze(
			(routerSelection.fallbacks ?? []).map((pair) => pair.model + (pair.effort === null ? "" : `:${pair.effort}`)),
		),
		assertCurrent,
		allowsModel,
	};
}
