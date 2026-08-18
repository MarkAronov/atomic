import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	build_scoring_prompt,
	MAX_INLINE_CANDIDATE_BYTES,
	type SharedHead,
	scoring_prompt_reads,
	warm_first_fan_out,
} from "../../packages/workflows/builtin/verification-prompts.js";
import type {
	WorkflowParallelOptions,
	WorkflowTaskResult,
	WorkflowTaskStep,
} from "../../packages/workflows/src/shared/types.js";

const criterionA = { id: "correctness", name: "Correctness", description: "The candidate is correct." };
const criterionB = { id: "evidence", name: "Evidence", description: "The candidate cites evidence." };

function result(name: string): WorkflowTaskResult {
	return { name, stageName: name, text: name };
}

function steps(...names: string[]): WorkflowTaskStep[] {
	return names.map((name) => ({ name, prompt: name.slice(0, 1) }));
}

describe("prompt-layout", () => {
	test("keeps the shared head byte-identical while only the criterion tail varies", () => {
		assert.equal(MAX_INLINE_CANDIDATE_BYTES, 32 * 1024);
		const head: SharedHead = {
			task: "Complete the task.",
			groundTruthNote: "The checked fixture is authoritative.",
			candidates: [
				{ path: "first.md", body: "first candidate α" },
				{ path: "second.md", body: "second candidate β" },
			],
		};
		const promptA = build_scoring_prompt(head, criterionA);
		const promptB = build_scoring_prompt(head, criterionB);
		const marker = "\n\n<criterion>\n";
		const [headA, tailA] = promptA.split(marker);
		const [headB, tailB] = promptB.split(marker);
		assert.notEqual(headA, undefined);
		assert.notEqual(tailA, undefined);
		assert.equal(headA, headB);
		assert.match(tailA!, /<name>Correctness<\/name>/);
		assert.match(tailB!, /<name>Evidence<\/name>/);
		assert.ok(promptA.indexOf("<task_statement>") < promptA.indexOf("<ground_truth_note>"));
		assert.ok(promptA.indexOf("<ground_truth_note>") < promptA.indexOf("<candidates>"));
		assert.ok(promptA.indexOf("<candidates>") < promptA.indexOf("<scale_anchors>"));
		assert.ok(promptA.indexOf("<scale_anchors>") < promptA.indexOf(marker));
		assert.match(headA!, /first candidate α/);
		assert.match(headA!, /second candidate β/);
		assert.equal(scoring_prompt_reads(head).length, 0);
	});

	test("flips every candidate to reads when one UTF-8 body exceeds the bound", () => {
		const oversizedBody = "é".repeat(Math.floor(MAX_INLINE_CANDIDATE_BYTES / 2) + 1);
		assert.ok(Buffer.byteLength(oversizedBody, "utf8") > MAX_INLINE_CANDIDATE_BYTES);
		const head: SharedHead = {
			task: "Review the candidates.",
			groundTruthNote: "Use the supplied artifacts.",
			candidates: [
				{ path: "small.md", body: "small body" },
				{ path: "large.md", body: oversizedBody },
				{ path: "small.md", body: "duplicate path stays ordered" },
			],
		};
		const promptA = build_scoring_prompt(head, criterionA);
		const promptB = build_scoring_prompt(head, criterionB);
		const marker = "\n\n<criterion>\n";
		assert.equal(promptA.slice(0, promptA.indexOf(marker)), promptB.slice(0, promptB.indexOf(marker)));
		assert.doesNotMatch(promptA, /small body/);
		assert.doesNotMatch(promptA, /duplicate path stays ordered/);
		assert.doesNotMatch(promptA, /é/);
		assert.match(promptA, /Read candidate from small\.md/);
		assert.match(promptA, /Read candidate from large\.md/);
		assert.deepEqual(scoring_prompt_reads(head), ["small.md", "large.md", "small.md"]);
	});

	test("keeps pathless and exact-boundary bodies inline", () => {
		const exactBody = "x".repeat(MAX_INLINE_CANDIDATE_BYTES);
		assert.equal(Buffer.byteLength(exactBody, "utf8"), MAX_INLINE_CANDIDATE_BYTES);
		const head: SharedHead = {
			task: "Review the exact boundary.",
			groundTruthNote: "The body is caller-provided.",
			candidates: [{ body: "pathless small body" }, { body: exactBody }],
		};
		const prompt = build_scoring_prompt(head, criterionA);
		assert.match(prompt, /pathless small body/);
		assert.ok(prompt.includes(exactBody));
		assert.deepEqual(scoring_prompt_reads(head), []);
	});

	test("rejects an oversized family when any candidate lacks a caller-bound path", () => {
		const oversizedBody = "é".repeat(Math.floor(MAX_INLINE_CANDIDATE_BYTES / 2) + 1);
		const head: SharedHead = {
			task: "Review the fallback.",
			groundTruthNote: "Every read must be caller-bound.",
			candidates: [{ body: "pathless sibling" }, { path: "large.md", body: oversizedBody }],
		};
		assert.throws(
			() => build_scoring_prompt(head, criterionA),
			(error: unknown) => {
				assert.ok(error instanceof TypeError);
				assert.match(error.message, /caller-bound path for every candidate/);
				assert.doesNotMatch(error.message, /candidate-1/);
				return true;
			},
		);
		assert.throws(() => scoring_prompt_reads(head), /caller-bound path for every candidate/);
	});

	test("partitions warm and rest phases deterministically and preserves original result order", async () => {
		const calls: string[][] = [];
		const options: WorkflowParallelOptions[] = [];
		const ctx = {
			parallel: async (phase: readonly WorkflowTaskStep[], phaseOptions: WorkflowParallelOptions = {}) => {
				calls.push(phase.map((step) => step.name));
				options.push(phaseOptions);
				return phase.map((step) => result(step.name));
			},
		};
		const input = steps("a-1", "a-2", "b-1", "b-2");
		const output = await warm_first_fan_out(ctx, input, (step) => step.prompt, { warmConcurrency: 2 });
		assert.deepEqual(calls, [
			["a-1", "b-1"],
			["a-2", "b-2"],
		]);
		assert.equal(options[0]?.concurrency, 2);
		assert.equal(options[0]?.failFast, false);
		assert.equal(options[1]?.concurrency, 2);
		assert.deepEqual(
			output.map((item) => item.name),
			["a-1", "a-2", "b-1", "b-2"],
		);

		const repeatCalls: string[][] = [];
		const repeatCtx = {
			parallel: async (phase: readonly WorkflowTaskStep[]) => {
				repeatCalls.push(phase.map((step) => step.name));
				return phase.map((step) => result(step.name));
			},
		};
		await warm_first_fan_out(repeatCtx, input, (step) => step.prompt, { warmConcurrency: 2 });
		assert.deepEqual(repeatCalls, calls);
	});

	test("honors inherited concurrency in both phases and uses the tighter cap", async () => {
		const inheritedOptions: WorkflowParallelOptions[] = [];
		const inheritedContext = {
			parallel: async (phase: readonly WorkflowTaskStep[], phaseOptions: WorkflowParallelOptions = {}) => {
				inheritedOptions.push(phaseOptions);
				return phase.map((step) => result(step.name));
			},
		};
		const input = steps("a-1", "a-2", "b-1", "b-2", "c-1", "c-2");
		await warm_first_fan_out(inheritedContext, input, (step) => step.prompt, { concurrency: 1 });
		assert.deepEqual(
			inheritedOptions.map((phase) => phase.concurrency),
			[1, 1],
		);

		const tighterOptions: WorkflowParallelOptions[] = [];
		const tighterContext = {
			parallel: async (phase: readonly WorkflowTaskStep[], phaseOptions: WorkflowParallelOptions = {}) => {
				tighterOptions.push(phaseOptions);
				return phase.map((step) => result(step.name));
			},
		};
		await warm_first_fan_out(tighterContext, steps("a-1", "a-2", "b-1", "b-2", "c-1", "c-2"), (step) => step.prompt, {
			warmConcurrency: 3,
			concurrency: 2,
		});
		assert.deepEqual(
			tighterOptions.map((phase) => phase.concurrency),
			[2, 2],
		);
	});

	test("releases the rest phase after a warm-phase failure", async () => {
		const calls: string[][] = [];
		let phaseNumber = 0;
		const ctx = {
			parallel: async (phase: readonly WorkflowTaskStep[]) => {
				calls.push(phase.map((step) => step.name));
				phaseNumber += 1;
				if (phaseNumber === 1) throw new Error("warm failed");
				return phase.map((step) => result(step.name));
			},
		};
		await assert.rejects(
			warm_first_fan_out(ctx, steps("a-1", "a-2", "b-1"), (step) => step.prompt, { warmConcurrency: 2 }),
			/warm failed/,
		);
		assert.deepEqual(calls, [["a-1", "b-1"], ["a-2"]]);
	});
});
