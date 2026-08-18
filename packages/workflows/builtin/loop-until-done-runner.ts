import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type {
  WorkflowRunContext,
  WorkflowSerializableObject,
  WorkflowSerializableValue,
  WorkflowTaskResult,
} from "../src/shared/types.js";
import { classify_trend, score_progress, type Trend } from "./progress-scoring.js";
import {
  renderCompletionPrompt,
  renderEvaluationPrompt,
  renderIterationPrompt,
} from "./loop-until-done-prompts.js";
import { stableArtifactRoot } from "./pattern-artifact-root.js";

const PROGRESS_DISCLAIMER = "Progress scores are a monitoring signal; VOC separation +0.079; never authoritative.";

const evaluationSchema = Type.Object({
  done: Type.Boolean(),
  summary: Type.String(),
  new_findings: Type.Array(Type.String()),
  failures: Type.Array(Type.String()),
  validation_evidence: Type.Array(Type.String()),
  remaining_work: Type.String(),
}, { additionalProperties: false });

type LoopInputs = {
  readonly prompt: string;
  readonly max_iterations: number;
  readonly progress_scoring?: boolean;
  readonly progress_repeats?: number;
} & Record<string, WorkflowSerializableValue>;

type Evaluation = {
  readonly done: boolean;
  readonly summary: string;
  readonly newFindings: readonly string[];
  readonly failures: readonly string[];
  readonly validationEvidence: readonly string[];
  readonly remainingWork: string;
};
type LedgerProgress = {
  readonly score: number;
  readonly perRepeat: (number | null)[][];
  readonly trend: Trend;
  readonly window: number;
};
type LedgerEntry = {
  readonly iteration: number;
  readonly artifact_path: string;
  readonly evaluation_artifact_path: string;
  readonly summary: string;
  readonly findings: readonly string[];
  readonly failures: readonly string[];
  readonly validation_evidence: readonly string[];
  readonly done: boolean;
  readonly remaining_work: string;
  readonly progress?: LedgerProgress;
};

function progressCurve(entries: readonly LedgerEntry[]): number[] {
  return entries.flatMap((entry) => (entry.progress === undefined ? [] : [entry.progress.score]));
}

function progressReport(entries: readonly LedgerEntry[]): { curve: number[]; trend: Trend } {
  const curve = progressCurve(entries);
  return { curve, trend: classify_trend(curve).trend };
}

function formatProgressReport(report: { curve: readonly number[]; trend: Trend }): string {
  return [
    `Progress curve: ${JSON.stringify(report.curve)}`,
    `Final trend: ${report.trend}`,
    PROGRESS_DISCLAIMER,
  ].join("\n");
}

function repeatCount(input: LoopInputs): number {
	const repeats = input.progress_repeats;
	return typeof repeats === "number" && Number.isInteger(repeats) && repeats > 0 ? repeats : 1;
}

async function scoreIteration(
  ctx: WorkflowRunContext<LoopInputs>,
  task: string,
  entries: readonly LedgerEntry[],
  repeats: number,
): Promise<LedgerProgress | undefined> {
  try {
    const curve = await score_progress(ctx, {
      problem: task,
      steps: entries.map((entry) => entry.summary),
      checkpoints: [entries.length],
      repeats,
    });
    const score = curve.scores[0];
    if (score === null || score === undefined) return undefined;
    const trend = classify_trend([...progressCurve(entries), score]);
    return {
      score,
      perRepeat: curve.perRepeat,
      trend: trend.trend,
      window: trend.evidence.window,
    };
  } catch {
    return undefined;
  }
}
function serializableObject(
  value: WorkflowSerializableValue | undefined,
): WorkflowSerializableObject | undefined {
  if (value === null || Array.isArray(value) || typeof value !== "object") return undefined;
  return value as WorkflowSerializableObject;
}

function stringArray(value: WorkflowSerializableValue | undefined): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function evaluationFrom(result: WorkflowTaskResult): Evaluation {
  const value = serializableObject(result.structured);
  if (value === undefined) {
    throw new Error(`loop-until-done: evaluator ${result.stageName} did not return a structured decision`);
  }
  const done = value.done;
  const summary = value.summary;
  const newFindings = stringArray(value.new_findings);
  const failures = stringArray(value.failures);
  const validationEvidence = stringArray(value.validation_evidence);
  const remainingWork = value.remaining_work;
  if (typeof done !== "boolean" || typeof summary !== "string" ||
      newFindings === undefined || failures === undefined || validationEvidence === undefined ||
      typeof remainingWork !== "string") {
    throw new Error(`loop-until-done: evaluator ${result.stageName} returned an invalid decision`);
  }
  return { done, summary, newFindings, failures, validationEvidence, remainingWork };
}

async function writeLedger(
  path: string,
  task: string,
  maxIterations: number,
  status: string,
  entries: readonly LedgerEntry[],
): Promise<void> {
  const report = progressReport(entries);
  await writeFile(path, `${JSON.stringify({
    task,
    max_iterations: maxIterations,
    status,
    iterations_completed: entries.length,
    entries,
    progress_curve: report.curve,
    final_trend: report.trend,
    progress_disclaimer: PROGRESS_DISCLAIMER,
  }, null, 2)}\n`);
}

export async function runLoopUntilDone(ctx: WorkflowRunContext<LoopInputs>) {
  const artifactDir = await stableArtifactRoot(ctx, "loop-until-done");
  const iterationsDir = join(artifactDir, "iterations");
  const evaluationsDir = join(artifactDir, "evaluations");
  await mkdir(iterationsDir, { recursive: true });
  await mkdir(evaluationsDir, { recursive: true });
  const ledgerPath = join(artifactDir, "progress-ledger.json");
  const entries: LedgerEntry[] = [];
  const iterationArtifactPaths: string[] = [];
  const evaluationArtifactPaths: string[] = [];
  await writeLedger(ledgerPath, ctx.inputs.prompt, ctx.inputs.max_iterations, "active", entries);

  for (let iteration = 1; iteration <= ctx.inputs.max_iterations; iteration += 1) {
    const iterationPath = join(iterationsDir, `iteration-${iteration}.md`);
    const evaluationPath = join(evaluationsDir, `evaluation-${iteration}.json`);
    iterationArtifactPaths.push(iterationPath);
    evaluationArtifactPaths.push(evaluationPath);
    await ctx.task(`iteration-${iteration}`, {
      prompt: renderIterationPrompt({
        task: ctx.inputs.prompt,
        iteration,
        maxIterations: ctx.inputs.max_iterations,
        ledgerPath,
      }),
      context: "fresh",
      reads: [ledgerPath, ...(iteration > 1 ? [iterationArtifactPaths[iteration - 2]!] : [])],
      output: iterationPath,
      outputMode: "file-only",
    });
    const evaluator = await ctx.task(`evaluate-${iteration}`, {
      prompt: renderEvaluationPrompt({
        task: ctx.inputs.prompt,
        iteration,
        ledgerPath,
        iterationPath,
      }),
      context: "fresh",
      reads: [ledgerPath, iterationPath],
      schema: evaluationSchema,
    });
    const decision = evaluationFrom(evaluator);
    // Evaluation reports are declared workflow outputs consumed as data: the
    // runner persists the structured decision itself so evaluation-N.json
    // stays schema-shaped JSON rather than stage prose.
    await writeFile(evaluationPath, `${JSON.stringify(evaluator.structured, null, 2)}\n`);
    const entry: LedgerEntry = {
      iteration,
      artifact_path: iterationPath,
      evaluation_artifact_path: evaluationPath,
      summary: decision.summary,
      findings: decision.newFindings,
      failures: decision.failures,
      validation_evidence: decision.validationEvidence,
      done: decision.done,
      remaining_work: decision.remainingWork,
    };
    entries.push(entry);
    if (ctx.inputs.progress_scoring !== false) {
      const progress = await scoreIteration(ctx, ctx.inputs.prompt, entries, repeatCount(ctx.inputs));
      if (progress !== undefined) entries[entries.length - 1] = { ...entry, progress };
    }
    await writeLedger(
      ledgerPath,
      ctx.inputs.prompt,
      ctx.inputs.max_iterations,
      decision.done ? "complete" : "active",
      entries,
    );
    if (decision.done) {
      const report = progressReport(entries);
      const resultPath = join(artifactDir, "result.md");
      const final = await ctx.task("completion-summary", {
        prompt: renderCompletionPrompt({ task: ctx.inputs.prompt, ledgerPath, iterationPath }),
        context: "fresh",
        reads: [ledgerPath, iterationPath],
        output: resultPath,
        // Keep the completion report out of the caller's context window;
        // `result_path` below carries it for callers that want the contents.
        outputMode: "file-only",
      });
      const result = `${final.text ? `${final.text.trimEnd()}\n\n` : ""}${formatProgressReport(report)}\n`;
      await writeFile(resultPath, result);
      return {
        result,
        status: "complete" as const,
        iterations_completed: iteration,
        ledger_path: ledgerPath,
        iteration_artifact_paths: iterationArtifactPaths,
        evaluation_artifact_paths: evaluationArtifactPaths,
        result_path: resultPath,
        remaining_work: "",
        artifact_dir: artifactDir,
        progress_curve: report.curve,
        final_trend: report.trend,
        progress_disclaimer: PROGRESS_DISCLAIMER,
      };
    }
  }

  const last = entries.at(-1)!;
  const report = progressReport(entries);
  await writeLedger(ledgerPath, ctx.inputs.prompt, ctx.inputs.max_iterations, "failed", entries);
  const result = [
    `Iteration limit exhausted after ${ctx.inputs.max_iterations} iterations. Inspect ${ledgerPath}.`,
    formatProgressReport(report),
  ].join("\n\n");
  return {
    result,
    status: "failed" as const,
    iterations_completed: ctx.inputs.max_iterations,
    ledger_path: ledgerPath,
    iteration_artifact_paths: iterationArtifactPaths,
    evaluation_artifact_paths: evaluationArtifactPaths,
    result_path: ledgerPath,
    remaining_work: last.remaining_work,
    artifact_dir: artifactDir,
    progress_curve: report.curve,
    final_trend: report.trend,
    progress_disclaimer: PROGRESS_DISCLAIMER,
  };
}
