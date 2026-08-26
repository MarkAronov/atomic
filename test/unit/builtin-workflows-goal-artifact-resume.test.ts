import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { test } from "vitest";
import { createGoalLedger } from "../../packages/workflows/builtin/goal-ledger.js";
import { createGoalArtifactDirectory } from "../../packages/workflows/builtin/goal-runner.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import {
	createCheckpointIdGenerator,
	createToolPrimitive,
} from "../../packages/workflows/src/durable/tool-primitive.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { taskReadInstruction } from "../../packages/workflows/src/runs/foreground/executor-task-prompts.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { ENV_WORKFLOW_ARTIFACT_DIR } from "../../packages/workflows/src/shared/workflow-artifacts.js";

const posix = (value: string): string => value.replaceAll("\\", "/");

test("a fresh-id workflow continuation reads a replayed producer artifact without rerunning the producer", async () => {
	const root = await mkdtemp(join(tmpdir(), "goal-artifact-workflow-resume-"));
	const previousRoot = process.env[ENV_WORKFLOW_ARTIFACT_DIR];
	process.env[ENV_WORKFLOW_ARTIFACT_DIR] = root;
	const backend = new InMemoryDurableBackend();
	let producerRuns = 0;
	let consumerRuns = 0;
	let receiptPath: string | undefined;
	const definition = workflow({
		name: "goal-artifact-resume-regression",
		description: "",
		inputs: {},
		outputs: { result: Type.String() },
		run: async (ctx) => {
			const artifactDir = await createGoalArtifactDirectory(ctx);
			receiptPath = join(artifactDir, "orchestrator-receipt.md");
			await ctx.task("artifact-producer", {
				prompt: "produce durable receipt",
				output: receiptPath,
				outputMode: "file-only",
			});
			const consumer = await ctx.task("artifact-consumer", {
				prompt: "review durable receipt",
				reads: [receiptPath],
			});
			return { result: consumer.text };
		},
	});
	try {
		const sourceStore = createStore();
		const sourceResult = await run(
			definition,
			{},
			{
				store: sourceStore,
				durableBackend: backend,
				adapters: {
					prompt: {
						prompt: async (text) => {
							if (text.includes("produce durable receipt")) {
								producerRuns += 1;
								assert.ok(receiptPath);
								await writeFile(receiptPath, "durable receipt", "utf8");
								return "durable receipt";
							}
							consumerRuns += 1;
							throw new Error("source consumer interrupted");
						},
					},
				},
			},
		);
		assert.equal(sourceResult.status, "failed");
		const source = sourceStore.runs().find((candidate) => candidate.id === sourceResult.runId);
		assert.ok(source);
		const sourceReceiptPath = receiptPath;
		assert.ok(sourceReceiptPath);
		assert.equal(await readFile(sourceReceiptPath, "utf8"), "durable receipt");

		const continuationResult = await run(
			definition,
			{},
			{
				store: createStore(),
				durableBackend: backend,
				continuation: { source, resumeFromStageId: source.failedStageId },
				adapters: {
					prompt: {
						prompt: async (text) => {
							if (text.includes("produce durable receipt")) producerRuns += 1;
							else consumerRuns += 1;
							return text;
						},
					},
				},
			},
		);

		assert.equal(continuationResult.status, "completed", continuationResult.error);
		assert.notEqual(continuationResult.runId, sourceResult.runId);
		assert.equal(receiptPath, sourceReceiptPath);
		assert.equal(producerRuns, 1);
		assert.equal(consumerRuns, 2);
		assert.equal(continuationResult.stages.find((stage) => stage.name === "artifact-producer")?.replayed, true);
		assert.match(continuationResult.result?.result ?? "", /review durable receipt/);
	} finally {
		if (previousRoot === undefined) delete process.env[ENV_WORKFLOW_ARTIFACT_DIR];
		else process.env[ENV_WORKFLOW_ARTIFACT_DIR] = previousRoot;
		await rm(root, { recursive: true, force: true });
	}
});

test("a fresh-id continuation replays the complete Goal artifact root and reads the source artifact", async () => {
	const root = await mkdtemp(join(tmpdir(), "goal-artifact-resume-"));
	const previousRoot = process.env[ENV_WORKFLOW_ARTIFACT_DIR];
	process.env[ENV_WORKFLOW_ARTIFACT_DIR] = root;
	const backend = new InMemoryDurableBackend();
	backend.registerWorkflow({ workflowId: "source-run", name: "goal", inputs: {}, createdAt: 1, status: "failed" });
	backend.registerWorkflow({
		workflowId: "continuation-run",
		name: "goal",
		inputs: {},
		createdAt: 2,
		status: "running",
	});
	try {
		const sourceTool = createToolPrimitive({
			workflowId: "source-run",
			backend,
			nextCheckpointId: createCheckpointIdGenerator(),
			throwIfCancelled: () => {},
		});
		const sourceArtifactDir = await createGoalArtifactDirectory({ runId: "source-run", tool: sourceTool });
		const restartedSourceTool = createToolPrimitive({
			workflowId: "source-run",
			backend,
			nextCheckpointId: createCheckpointIdGenerator(),
			throwIfCancelled: () => {},
		});
		const replayedInSource = await createGoalArtifactDirectory({ runId: "source-run", tool: restartedSourceTool });
		assert.equal(replayedInSource, sourceArtifactDir, "a restarted run must replay the random artifact segment");
		assert.match(posix(sourceArtifactDir), /\/runs\/source-run\/artifact-[^/]+$/);

		const stageArtifact = join(sourceArtifactDir, "orchestrator-receipt.md");
		await writeFile(stageArtifact, "durable receipt", "utf8");

		const continuationTool = createToolPrimitive({
			workflowId: "continuation-run",
			checkpointSourceWorkflowId: "source-run",
			backend,
			nextCheckpointId: createCheckpointIdGenerator(),
			throwIfCancelled: () => {},
		});
		const continuationArtifactDir = await createGoalArtifactDirectory({
			runId: "continuation-run",
			tool: continuationTool,
		});
		assert.equal(continuationArtifactDir, sourceArtifactDir);
		assert.equal(
			taskReadInstruction({ prompt: "review", reads: [stageArtifact] }),
			`[Read from: ${stageArtifact}]\n\n`,
		);
		assert.equal(await readFile(stageArtifact, "utf8"), "durable receipt");
	} finally {
		if (previousRoot === undefined) delete process.env[ENV_WORKFLOW_ARTIFACT_DIR];
		else process.env[ENV_WORKFLOW_ARTIFACT_DIR] = previousRoot;
		await rm(root, { recursive: true, force: true });
	}
});

test("Goal ledger contents and artifact paths stay inside the supplied fresh-run directory", async () => {
	const root = await mkdtemp(join(tmpdir(), "goal-ledger-directory-"));
	try {
		const artifactDir = join(root, "runs", "fresh-run", "artifact-fixed");
		await mkdir(artifactDir, { recursive: true });
		const { ledger, ledgerPath } = await createGoalLedger("literal objective", "literal criteria", artifactDir);
		assert.equal(ledgerPath, join(artifactDir, "goal-ledger.json"));
		assert.equal(ledger.objective, "literal objective");
		assert.equal(ledger.acceptance_criteria, "literal criteria");
		assert.deepEqual(ledger.receipts, []);
		const stored = JSON.parse(await readFile(ledgerPath, "utf8")) as Record<string, unknown>;
		assert.equal(stored.objective, "literal objective");
		assert.equal(stored.acceptance_criteria, "literal criteria");
		assert.equal("turns" in stored, false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
