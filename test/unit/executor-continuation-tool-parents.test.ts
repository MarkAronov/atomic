import assert from "node:assert/strict";
import { Type } from "typebox";
import { describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createContinuationReplayIndex } from "../../packages/workflows/src/runs/foreground/executor-continuation.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot, ToolNodeSnapshot } from "../../packages/workflows/src/shared/store-types.js";

function toolNode(id: string, status: ToolNodeSnapshot["status"] = "completed"): ToolNodeSnapshot {
	return {
		kind: "tool",
		id,
		name: "preflight",
		argsHash: "preflight-hash",
		ordinal: 1,
		parentIds: [],
		status,
		attachable: false,
	};
}

function stage(input: {
	readonly id: string;
	readonly name: string;
	readonly status: StageSnapshot["status"];
	readonly parentIds: readonly string[];
}): StageSnapshot {
	return {
		id: input.id,
		name: input.name,
		status: input.status,
		parentIds: input.parentIds,
		toolEvents: [],
		replayKey: `stage:task:${input.name}:1`,
	};
}

function sourceRun(stages: StageSnapshot[], toolNodes: ToolNodeSnapshot[] = []): RunSnapshot {
	return {
		id: "source-run",
		name: "tool-parent-continuation",
		inputs: {},
		status: "failed",
		stages,
		toolNodes,
		startedAt: 1,
		failedStageId: stages.find((candidate) => candidate.status !== "completed")?.id,
	};
}

describe("continuation tool-parent identity map", () => {
	test("translates a pre-seeded tool parent and replays the completed child", () => {
		const toolId = "tool:preflight";
		const completed = stage({
			id: "source-completed",
			name: "mapping 1",
			status: "completed",
			parentIds: [toolId],
		});
		const incomplete = stage({
			id: "source-incomplete",
			name: "mapping 2",
			status: "running",
			parentIds: [toolId],
		});
		const identities = new Map<string, string>([[toolId, toolId]]);
		const index = createContinuationReplayIndex(
			{
				source: sourceRun([completed, incomplete]),
				resumeFromStageId: incomplete.id,
			},
			identities,
		);

		const replayed = index.decide({
			displayName: completed.name,
			replayKey: completed.replayKey!,
			parentIds: [toolId],
			stageId: "continuation-completed",
			kind: "stage",
		});
		assert.equal(replayed.kind, "replay");
		assert.deepEqual(replayed.parentIds, [toolId]);
		assert.equal(identities.get(completed.id), "continuation-completed");

		const executed = index.decide({
			displayName: incomplete.name,
			replayKey: incomplete.replayKey!,
			parentIds: [toolId],
			stageId: "continuation-incomplete",
			kind: "stage",
		});
		assert.equal(executed.kind, "execute");
		assert.deepEqual(executed.parentIds, [toolId]);
	});

	test("does not translate a snapshot tool parent that was never admitted", () => {
		const toolId = "tool:preflight";
		const completed = stage({
			id: "source-completed",
			name: "mapping 1",
			status: "completed",
			parentIds: [toolId],
		});
		const index = createContinuationReplayIndex(
			{
				source: sourceRun([completed], [toolNode(toolId)]),
				resumeFromStageId: completed.id,
			},
			new Map(),
		);

		assert.throws(
			() =>
				index.decide({
					displayName: completed.name,
					replayKey: completed.replayKey!,
					parentIds: [toolId],
					stageId: "continuation-completed",
					kind: "stage",
				}),
			/insufficient_state: replay topology mismatch/,
		);
	});

	test("rejects a completed child whose tool parent is absent from the identity map", () => {
		const completed = stage({
			id: "source-completed",
			name: "mapping 1",
			status: "completed",
			parentIds: ["tool:missing"],
		});
		const index = createContinuationReplayIndex(
			{
				source: sourceRun([completed], []),
				resumeFromStageId: completed.id,
			},
			new Map(),
		);

		assert.throws(
			() =>
				index.decide({
					displayName: completed.name,
					replayKey: completed.replayKey!,
					parentIds: ["tool:missing"],
					stageId: "continuation-completed",
					kind: "stage",
				}),
			/insufficient_state: replay topology mismatch/,
		);
	});

	test("still rejects a genuine parent change after tool identities are translated", () => {
		const toolId = "tool:preflight";
		const completed = stage({
			id: "source-completed",
			name: "mapping 1",
			status: "completed",
			parentIds: [toolId],
		});
		const index = createContinuationReplayIndex(
			{
				source: sourceRun([completed]),
				resumeFromStageId: completed.id,
			},
			new Map([[toolId, toolId]]),
		);

		assert.throws(
			() =>
				index.decide({
					displayName: completed.name,
					replayKey: completed.replayKey!,
					parentIds: ["stage:inserted-parent"],
					stageId: "continuation-completed",
					kind: "stage",
				}),
			/insufficient_state: replay topology mismatch/,
		);
	});

	test("fresh-id continuation rejects a changed tool graph instead of keeping stale parents", async () => {
		const backend = new InMemoryDurableBackend();
		let toolCalls = 0;
		const sourceDef = workflow({
			name: "changed-tool-graph",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				await ctx.tool("root", { n: 1 }, async () => {
					toolCalls += 1;
					return "ready";
				});
				await ctx.stage("after").prompt("after");
				return { result: "done" };
			},
		});
		const sourceStore = createStore();
		const first = await run(
			sourceDef,
			{},
			{
				store: sourceStore,
				durableBackend: backend,
				adapters: {
					prompt: {
						prompt: async (text) => {
							if (text === "after") throw new Error("source after failed");
							return text;
						},
					},
				},
			},
		);
		assert.equal(first.status, "failed");
		assert.equal(toolCalls, 1);
		const source = sourceStore.runs().find((candidate) => candidate.id === first.runId);
		assert.ok(source);
		const changedDef = workflow({
			name: "changed-tool-graph",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				await ctx.stage("inserted").prompt("inserted");
				await ctx.tool("root", { n: 1 }, async () => {
					toolCalls += 1;
					return "ready";
				});
				return { result: "done" };
			},
		});
		const continued = await run(
			changedDef,
			{},
			{
				store: createStore(),
				durableBackend: backend,
				continuation: { source, resumeFromStageId: source.failedStageId },
				adapters: { prompt: { prompt: async (text) => text } },
			},
		);
		assert.equal(continued.status, "failed");
		assert.match(continued.error ?? "", /insufficient_state: replay topology mismatch/);
		assert.equal(toolCalls, 1);
		assert.equal(continued.result?.result, undefined);
	});

	test("fresh-id continuation rejects an inserted parent before a parented tool", async () => {
		const backend = new InMemoryDurableBackend();
		let toolCalls = 0;
		const sourceDef = workflow({
			name: "parented-tool-insert",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				await ctx.stage("a").prompt("a");
				await ctx.tool("t", { n: 1 }, async () => {
					toolCalls += 1;
					return "t";
				});
				await ctx.stage("b").prompt("b");
				return { result: "done" };
			},
		});
		const sourceStore = createStore();
		const first = await run(
			sourceDef,
			{},
			{
				store: sourceStore,
				durableBackend: backend,
				adapters: {
					prompt: {
						prompt: async (text) => {
							if (text === "b") throw new Error("source b failed");
							return text;
						},
					},
				},
			},
		);
		assert.equal(first.status, "failed");
		assert.equal(toolCalls, 1);
		const source = sourceStore.runs().find((candidate) => candidate.id === first.runId);
		assert.ok(source);
		const changedDef = workflow({
			name: "parented-tool-insert",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				await ctx.stage("a").prompt("a");
				await ctx.stage("inserted").prompt("inserted");
				await ctx.tool("t", { n: 1 }, async () => {
					toolCalls += 1;
					return "t";
				});
				return { result: "done" };
			},
		});
		const continued = await run(
			changedDef,
			{},
			{
				store: createStore(),
				durableBackend: backend,
				continuation: { source, resumeFromStageId: source.failedStageId },
				adapters: { prompt: { prompt: async (text) => text } },
			},
		);
		assert.equal(continued.status, "failed");
		assert.match(continued.error ?? "", /insufficient_state: replay topology mismatch/);
		assert.equal(toolCalls, 1);
	});

	test("fresh-id continuation rejects a tool whose restored parents cannot be translated", async () => {
		const backend = new InMemoryDurableBackend();
		let toolCalls = 0;
		const sourceDef = workflow({
			name: "untranslated-tool-parent",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				await ctx.stage("a").prompt("a");
				await ctx.tool("t", { n: 1 }, async () => {
					toolCalls += 1;
					return "t";
				});
				await ctx.stage("after").prompt("after");
				return { result: "done" };
			},
		});
		const sourceStore = createStore();
		const first = await run(
			sourceDef,
			{},
			{
				store: sourceStore,
				durableBackend: backend,
				adapters: {
					prompt: {
						prompt: async (text) => {
							if (text === "after") throw new Error("source after failed");
							return text;
						},
					},
				},
			},
		);
		assert.equal(first.status, "failed");
		assert.equal(toolCalls, 1);
		const source = sourceStore.runs().find((candidate) => candidate.id === first.runId);
		assert.ok(source);
		const changedDef = workflow({
			name: "untranslated-tool-parent",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				await ctx.stage("z").prompt("z");
				await ctx.tool("t", { n: 1 }, async () => {
					toolCalls += 1;
					return "t";
				});
				return { result: "done" };
			},
		});
		const continued = await run(
			changedDef,
			{},
			{
				store: createStore(),
				durableBackend: backend,
				continuation: { source, resumeFromStageId: source.failedStageId },
				adapters: { prompt: { prompt: async (text) => text } },
			},
		);
		assert.equal(continued.status, "failed");
		assert.match(continued.error ?? "", /insufficient_state: replay topology mismatch/);
		assert.equal(toolCalls, 1);
	});

	test("fresh-id continuation keeps a tool parented by a when a replayed sibling stage settles first", async () => {
		const backend = new InMemoryDurableBackend();
		let toolCalls = 0;
		let failAfter = true;
		const definition = workflow({
			name: "tool-after-live-stage",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				await ctx.stage("a").prompt("a");
				const b = ctx.stage("b").prompt("b");
				await ctx.tool("t", { n: 1 }, async () => {
					toolCalls += 1;
					return "t";
				});
				await b;
				await ctx.stage("c").prompt("c");
				return { result: "done" };
			},
		});
		const adapters = {
			prompt: {
				prompt: async (text: string) => {
					if (failAfter && text === "c") throw new Error("source c failed");
					return text;
				},
			},
		};
		const sourceStore = createStore();
		const first = await run(definition, {}, { store: sourceStore, durableBackend: backend, adapters });
		assert.equal(first.status, "failed");
		assert.equal(toolCalls, 1);
		const source = sourceStore.runs().find((candidate) => candidate.id === first.runId);
		assert.ok(source);
		failAfter = false;
		const continued = await run(
			definition,
			{},
			{
				store: createStore(),
				durableBackend: backend,
				budget: { maxTokens: 10_000 },
				continuation: { source, resumeFromStageId: source.failedStageId },
				adapters,
			},
		);
		assert.equal(continued.status, "completed", continued.error);
		assert.equal(toolCalls, 1);
		const seed = continued.stages.find((stage) => stage.name === "a");
		const tool = continued.toolNodes?.[0];
		assert.ok(seed);
		assert.ok(tool);
		assert.deepEqual(tool.parentIds, [seed.id]);
	});

	test("fresh-id continuation keeps cached tool siblings parented by the shared seed", async () => {
		const backend = new InMemoryDurableBackend();
		let toolCalls = 0;
		let failAfter = true;
		const definition = workflow({
			name: "sibling-tool-continuation",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.stage("seed").prompt("seed");
				const left = ctx.tool("left", {}, async () => {
					toolCalls += 1;
					return "left";
				});
				await Promise.resolve();
				const right = ctx.tool("right", {}, async () => {
					toolCalls += 1;
					return "right";
				});
				await Promise.all([left, right]);
				await ctx.stage("after").prompt("after");
				return {};
			},
		});
		const adapters = {
			prompt: {
				prompt: async (text: string) => {
					if (failAfter && text === "after") throw new Error("source after failed");
					return text;
				},
			},
		};
		const sourceStore = createStore();
		const first = await run(definition, {}, { store: sourceStore, durableBackend: backend, adapters });
		assert.equal(first.status, "failed");
		assert.equal(toolCalls, 2);
		const source = sourceStore.runs().find((candidate) => candidate.id === first.runId);
		assert.ok(source);
		failAfter = false;
		const continued = await run(
			definition,
			{},
			{
				store: createStore(),
				durableBackend: backend,
				continuation: { source, resumeFromStageId: source.failedStageId },
				adapters,
			},
		);
		assert.equal(continued.status, "completed", continued.error);
		assert.equal(toolCalls, 2);
		const seed = continued.stages.find((stage) => stage.name === "seed");
		assert.ok(seed);
		const tools = continued.toolNodes ?? [];
		assert.equal(tools.length, 2);
		assert.deepEqual(
			tools.map((tool) => tool.parentIds),
			[[seed.id], [seed.id]],
		);
	});
});
