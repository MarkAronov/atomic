import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	build_progress_prompt,
	classify_trend,
	DEFAULT_FALL_DELTA,
	DEFAULT_RISE_DELTA,
	DEFAULT_TREND_WINDOW,
	type ProgressScoringContext,
	score_progress,
} from "../../packages/workflows/builtin/progress-scoring.js";
import type {
	WorkflowSerializableValue,
	WorkflowTaskOptions,
	WorkflowTaskResult,
} from "../../packages/workflows/src/shared/types.js";

function structuredScores(entries: readonly { checkpoint: number; score: number }[]): WorkflowSerializableValue {
	return { scores: entries.map((entry) => ({ ...entry })) };
}

type StubCall = { readonly name: string; readonly options: WorkflowTaskOptions };

function stubContext(outputs: readonly (WorkflowSerializableValue | undefined)[]): {
	readonly ctx: ProgressScoringContext;
	readonly calls: StubCall[];
} {
	const calls: StubCall[] = [];
	let outputIndex = 0;
	const ctx: ProgressScoringContext = {
		task: async (name, options): Promise<WorkflowTaskResult> => {
			calls.push({ name, options });
			const structured = outputs[outputIndex++];
			return structured === undefined
				? { name, stageName: name, text: "" }
				: { name, stageName: name, text: "", structured };
		},
	};
	return { ctx, calls };
}

describe("progress-scoring", () => {
	test("builds a skeptical current-state prompt with every calibration rule", () => {
		const prompt = build_progress_prompt({
			problem: "Repair the fixture.",
			steps: ["Observed the failing test.", "Changed the implementation."],
			checkpoints: [2],
		});
		assert.match(prompt, /Trust observed output, not the agent's narration\./);
		assert.match(prompt, /Effort and step count are NOT progress\./);
		assert.match(prompt, /Agent declarations of success \("done!", "all tests pass"\) are ZERO evidence\./);
		assert.match(prompt, /Scores may plateau or fall/);
		assert.match(prompt, /would the CURRENT state satisfy the acceptance criteria/);
		assert.match(prompt, /1 = certainly would not satisfy the acceptance criteria/);
		assert.match(prompt, /20 = verified satisfaction with observed output/);
		assert.doesNotMatch(prompt, /eventual (?:success|failure)|will (?:succeed|fail)|trajectory (?:succeeds|fails)/i);
	});

	test("keeps numbered steps in a byte-identical head and checkpoints in the tail", () => {
		const first = build_progress_prompt({
			problem: "Complete the task.",
			steps: ["first observation", "second observation", "third observation"],
			checkpoints: [2],
		});
		const second = build_progress_prompt({
			problem: "Complete the task.",
			steps: ["first observation", "second observation", "third observation"],
			checkpoints: [1, 3],
		});
		const marker = "\n\n<checkpoints>\n";
		const firstHead = first.slice(0, first.indexOf(marker));
		const secondHead = second.slice(0, second.indexOf(marker));
		assert.equal(firstHead, secondHead);
		assert.match(
			firstHead,
			/<steps>\n1\. first observation\n2\. second observation\n3\. third observation\n<\/steps>/,
		);
		assert.ok(first.indexOf("<steps>") < first.indexOf("<calibration>"));
		assert.ok(first.indexOf("</steps>") < first.indexOf("<checkpoints>"));
		assert.ok(first.indexOf("<checkpoints>") < first.indexOf("- 2"));
		assert.ok(first.indexOf("<checkpoints>") > first.indexOf("</progress_head>"));
	});

	test("uses interior checkpoints and one model call for the default single repeat", async () => {
		const { ctx, calls } = stubContext([
			structuredScores([
				{ checkpoint: 2, score: 7 },
				{ checkpoint: 3, score: 9 },
			]),
		]);
		const curve = await score_progress(ctx, {
			problem: "Complete the task.",
			steps: ["one", "two", "three", "four"],
		});
		assert.deepEqual(curve.checkpoints, [2, 3]);
		assert.deepEqual(curve.scores, [7, 9]);
		assert.deepEqual(curve.perRepeat, [[7, 9]]);
		assert.equal(calls.length, 1);
		assert.ok(calls[0]!.options.schema);
	});

	test("batches every checkpoint per repeat and averages only valid entries", async () => {
		const { ctx, calls } = stubContext([
			structuredScores([
				{ checkpoint: 2, score: 4 },
				{ checkpoint: 3, score: 8 },
				{ checkpoint: 4, score: 12 },
			]),
			structuredScores([
				{ checkpoint: 2, score: 6 },
				{ checkpoint: 2, score: 9 },
				{ checkpoint: 3, score: 99 },
				{ checkpoint: 99, score: 10 },
			]),
			structuredScores([
				{ checkpoint: 2, score: 0 },
				{ checkpoint: 99, score: 10 },
			]),
		]);
		const curve = await score_progress(ctx, {
			problem: "Complete the task.",
			steps: ["one", "two", "three", "four", "five"],
			checkpoints: [2, 3, 4],
			repeats: 3,
		});
		assert.equal(calls.length, 3);
		assert.deepEqual(curve.perRepeat, [
			[4, 8, 12],
			[6, null, null],
			[null, null, null],
		]);
		assert.deepEqual(curve.scores, [5, 8, 12]);
		const marker = "\n\n<checkpoints>\n";
		const heads = calls.map((call) => call.options.prompt!.slice(0, call.options.prompt!.indexOf(marker)));
		assert.equal(heads[0], heads[1]);
		assert.equal(heads[1], heads[2]);
	});

	test("keeps checkpoints null when all repeats are invalid", async () => {
		const { ctx } = stubContext([undefined, { malformed: true }, structuredScores([{ checkpoint: 2, score: 21 }])]);
		const curve = await score_progress(ctx, {
			problem: "Complete the task.",
			steps: ["one", "two", "three"],
			checkpoints: [2],
			repeats: 3,
		});
		assert.deepEqual(curve.perRepeat, [[null], [null], [null]]);
		assert.deepEqual(curve.scores, [null]);
	});

	test("rejects an empty prefix and checkpoints outside the 1-indexed step range", async () => {
		const { ctx } = stubContext([]);
		await assert.rejects(
			() => score_progress(ctx, { problem: "x", steps: [], checkpoints: [] }),
			/non-empty step prefix/,
		);
		await assert.rejects(
			() => score_progress(ctx, { problem: "x", steps: ["one", "two"], checkpoints: [0] }),
			/outside the step range/,
		);
		await assert.rejects(
			() => score_progress(ctx, { problem: "x", steps: ["one", "two"], checkpoints: [3] }),
			/outside the step range/,
		);
	});

	test("classifies clear rising and regressing series with inclusive boundaries", () => {
		assert.equal(classify_trend([1, 2, 3, 4, 5, 6]).trend, "rising");
		assert.equal(classify_trend([6, 5, 4, 3, 2, 1]).trend, "regressing");
		const risingBoundary = classify_trend([1, 1, 1, 2.5, 2.5, 2.5]);
		const fallingBoundary = classify_trend([2.5, 2.5, 2.5, 1, 1, 1]);
		assert.equal(risingBoundary.trend, "rising");
		assert.equal(risingBoundary.evidence.delta, DEFAULT_RISE_DELTA);
		assert.equal(fallingBoundary.trend, "regressing");
		assert.equal(fallingBoundary.evidence.delta, DEFAULT_FALL_DELTA);
	});

	test("keeps alternating noise and low-and-flat failure evidence flat", () => {
		assert.equal(classify_trend([6, 10, 6, 10, 6, 10]).trend, "flat");
		assert.equal(classify_trend([6, 10, 6, 10]).trend, "flat");
		const lowAndFlat = classify_trend([5, 5, 6, 5, 5, 6]);
		assert.equal(lowAndFlat.trend, "flat");
		assert.equal(lowAndFlat.evidence.delta, 0);
	});

	test("classifies short series as flat with named default evidence", () => {
		const series = [6, 7, 8];
		const result = classify_trend(series);
		assert.equal(result.trend, "flat");
		assert.equal(result.evidence.series, series);
		assert.equal(result.evidence.window, DEFAULT_TREND_WINDOW);
		assert.equal(result.evidence.delta, 0);
		assert.deepEqual(Object.keys(result), ["trend", "evidence"]);
	});
	test("composes score_progress curves with rising success and low-flat failure fixtures", async () => {
		const checkpoints = [2, 3, 4, 5, 6, 7];
		const successStub = stubContext([
			structuredScores([
				{ checkpoint: 2, score: 2 },
				{ checkpoint: 3, score: 5 },
				{ checkpoint: 4, score: 8 },
				{ checkpoint: 5, score: 11 },
				{ checkpoint: 6, score: 14 },
				{ checkpoint: 7, score: 17 },
			]),
		]);
		const successCurve = await score_progress(successStub.ctx, {
			problem: "Satisfy the acceptance criteria.",
			steps: [
				"Observed the failing acceptance test.",
				"Implemented the missing behavior.",
				"Added focused regression coverage.",
				"Ran the focused test suite.",
				"Ran the full test suite.",
				"Verified the generated artifacts.",
				"Confirmed the acceptance evidence.",
			],
			checkpoints,
		});
		const successScores = successCurve.scores.filter((score): score is number => score !== null);
		const successTrend = classify_trend(successScores);
		assert.equal(successScores.length, checkpoints.length);
		assert.equal(successTrend.trend, "rising");

		const failureStub = stubContext([
			structuredScores([
				{ checkpoint: 2, score: 5 },
				{ checkpoint: 3, score: 5 },
				{ checkpoint: 4, score: 6 },
				{ checkpoint: 5, score: 5 },
				{ checkpoint: 6, score: 5 },
				{ checkpoint: 7, score: 6 },
			]),
		]);
		const failureCurve = await score_progress(failureStub.ctx, {
			problem: "Satisfy the acceptance criteria.",
			steps: [
				"Observed the failing acceptance test.",
				"Repeated the same attempted fix.",
				"Observed the same failure again.",
				"Rebuilt the same incorrect approach.",
				"Observed no change in output.",
				"Repeated the failing test.",
				"Recorded the unchanged failure evidence.",
			],
			checkpoints,
		});
		const failureScores = failureCurve.scores.filter((score): score is number => score !== null);
		const failureTrend = classify_trend(failureScores);
		assert.ok(failureScores.length >= DEFAULT_TREND_WINDOW + 1);
		assert.equal(failureTrend.evidence.delta, 0);
		assert.equal(failureTrend.trend, "flat");
		assert.notEqual(failureTrend.trend, "regressing");
	});
});
