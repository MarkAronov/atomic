import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createContinuationReplayIndex } from "../../packages/workflows/src/runs/foreground/executor-continuation.js";
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

	test("translates a pre-seeded return_failure tool parent", () => {
		const toolId = "tool:return-failure";
		const completed = stage({
			id: "source-completed",
			name: "after",
			status: "completed",
			parentIds: [toolId],
		});
		const identities = new Map<string, string>([[toolId, toolId]]);
		const index = createContinuationReplayIndex(
			{
				source: sourceRun([completed]),
				resumeFromStageId: completed.id,
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
});
