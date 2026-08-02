import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { expandWorkflowGraph } from "../../packages/workflows/src/shared/expanded-workflow-graph.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

describe("payload-free store observation", () => {
	test("notifies synchronously without traversing unrelated workflow inputs", () => {
		const store = createStore();
		let payloadReads = 0;
		const evidence: Record<string, string> = {};
		Object.defineProperty(evidence, "occurrences", {
			enumerable: true,
			get() {
				payloadReads++;
				return "large-unrelated-payload";
			},
		});
		store.recordRunStart({
			id: "run-large",
			name: "large-workflow",
			inputs: { evidence },
			status: "running",
			stages: [
				{
					id: "question",
					name: "question",
					status: "running",
					parentIds: [],
					toolEvents: [],
				},
			],
			startedAt: Date.now(),
		});
		payloadReads = 0;
		let calls = 0;
		const unsubscribe = store.subscribeInvalidation?.(() => {
			calls++;
			store.graphSnapshot?.();
		});
		assert.ok(unsubscribe);

		assert.equal(
			store.recordStageInputRequest("run-large", "question", {
				id: "question-1",
				kind: "ask_user_question",
				questions: [{ question: "Continue?", options: [] }],
				createdAt: Date.now(),
			}),
			true,
		);

		assert.equal(calls, 1);
		assert.equal(payloadReads, 0);
		assert.deepEqual(store.graphSnapshot?.().runs[0]?.inputs, {});
		unsubscribe();
	});

	test("preserves legacy full-snapshot subscribers", () => {
		const store = createStore();
		const versions: number[] = [];
		store.subscribe((snapshot) => versions.push(snapshot.version));
		store.recordRunStart({
			id: "run-legacy",
			name: "legacy",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: Date.now(),
		});
		assert.deepEqual(versions, [1]);
	});

	test("excludes authored stage results but preserves durable tool summaries", () => {
		const store = createStore();
		store.recordRunStart({
			id: "run-results",
			name: "results",
			inputs: {},
			status: "running",
			stages: [
				{
					id: "agent-stage",
					name: "agent-stage",
					status: "completed",
					parentIds: [],
					result: "unbounded agent output",
					toolEvents: [],
				},
			],
			toolNodes: [
				{
					kind: "tool",
					id: "tool-node",
					name: "verify",
					argsHash: "hash",
					ordinal: 1,
					parentIds: ["agent-stage"],
					status: "completed",
					resultSummary: "bounded tool summary",
					attachable: false,
				},
			],
			startedAt: Date.now(),
		});

		const snapshot = store.graphSnapshot?.();
		assert.ok(snapshot);
		assert.equal(snapshot.runs[0]?.stages[0]?.result, undefined);
		assert.equal(snapshot.runs[0]?.toolNodes?.[0]?.resultSummary, "bounded tool summary");
		const graph = expandWorkflowGraph(snapshot, "run-results");
		assert.equal(graph.renderStages.find((stage) => stage.nodeKind === "tool")?.result, "bounded tool summary");
	});
});
