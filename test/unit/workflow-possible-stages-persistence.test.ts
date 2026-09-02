import assert from "node:assert/strict";
import { join } from "node:path";
import { Type } from "typebox";
import { afterAll, describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import {
	encodeMetadata,
	metadataStepName,
	parseCurrentMetadataRecord,
} from "../../packages/workflows/src/durable/dbos-metadata.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { discoverWorkflows } from "../../packages/workflows/src/extension/discovery.js";
import { coercePossibleStages } from "../../packages/workflows/src/shared/possible-stages.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { makeDirectorySync, makeTempDirectory, removeTempDirectory, writeTextSync } from "../helpers/runtime.js";

const SCANNED = ["orchestrator-*", "pull-request", "reviewer-error"] as const;

const plain = workflow({
	name: "possible-stages-plain",
	description: "",
	inputs: {},
	outputs: { value: Type.String() },
	run: async () => ({ value: "ok" }),
});

// ---------------------------------------------------------------------------
// D10 — the scan persists with the run and survives resume/replay
// ---------------------------------------------------------------------------

describe("possible-stages persistence (D10)", () => {
	test("a launch-time scan persists onto the root snapshot and the durable handle", async () => {
		const backend = new InMemoryDurableBackend();
		const store = createStore();
		await run(
			plain,
			{},
			{
				runId: "ps-run-1",
				store,
				durableBackend: backend,
				durableRootBackend: backend,
				possibleStages: [...SCANNED],
			},
		);
		assert.deepEqual(store.runs().find((candidate) => candidate.id === "ps-run-1")?.possibleStages, [...SCANNED]);
		assert.deepEqual(backend.getWorkflow("ps-run-1")?.possibleStages, [...SCANNED]);
	});

	test("resume hydrates the persisted scan instead of recomputing it", async () => {
		const backend = new InMemoryDurableBackend();
		const first = createStore();
		await run(
			plain,
			{},
			{
				runId: "ps-run-2",
				store: first,
				durableBackend: backend,
				durableRootBackend: backend,
				possibleStages: [...SCANNED],
			},
		);
		// A later resume in a fresh session: no scan is supplied, the durable
		// value wins so mid-run definition edits cannot change advertised targets.
		const second = createStore();
		await run(
			plain,
			{},
			{
				runId: "ps-run-2",
				store: second,
				durableBackend: backend,
				durableRootBackend: backend,
			},
		);
		assert.deepEqual(second.runs().find((candidate) => candidate.id === "ps-run-2")?.possibleStages, [...SCANNED]);
	});

	test("a missing or corrupt scan hydrates as an empty set", async () => {
		const backend = new InMemoryDurableBackend();
		const store = createStore();
		await run(
			plain,
			{},
			{
				runId: "ps-run-3",
				store,
				durableBackend: backend,
				durableRootBackend: backend,
			},
		);
		const snapshot = store.runs().find((candidate) => candidate.id === "ps-run-3");
		assert.deepEqual(snapshot?.possibleStages, []);

		const storeWithoutHandle = createStore();
		await run(
			plain,
			{},
			{
				runId: "ps-run-4",
				store: storeWithoutHandle,
			},
		);
		assert.deepEqual(storeWithoutHandle.runs().find((candidate) => candidate.id === "ps-run-4")?.possibleStages, []);
	});

	test("continuations inherit the source run's persisted scan", async () => {
		const backend = new InMemoryDurableBackend();
		const store = createStore();
		await run(
			plain,
			{},
			{
				runId: "ps-run-src",
				store,
				durableBackend: backend,
				durableRootBackend: backend,
				possibleStages: [...SCANNED],
			},
		);
		const sourceSnapshot = store.runs().find((candidate) => candidate.id === "ps-run-src");
		assert.ok(sourceSnapshot !== undefined);
		await run(
			plain,
			{},
			{
				runId: "ps-run-cont",
				store,
				durableBackend: backend,
				durableRootBackend: backend,
				continuation: { source: sourceSnapshot },
			},
		);
		const continuation = store.runs().find((candidate) => candidate.id === "ps-run-cont");
		assert.deepEqual(continuation?.possibleStages, [...SCANNED]);
		assert.deepEqual(backend.getWorkflow("ps-run-cont")?.possibleStages, [...SCANNED]);
	});

	test("child runs do not carry the root scan", async () => {
		const backend = new InMemoryDurableBackend();
		const store = createStore();
		const child = workflow({
			name: "possible-stages-child",
			description: "",
			inputs: {},
			outputs: { value: Type.String() },
			run: async () => ({ value: "ok" }),
		});
		await run(
			child,
			{},
			{
				runId: "ps-child-1",
				store,
				durableBackend: backend,
				durableRootBackend: backend,
				parentRun: { runId: "ps-root-1", stageId: "boundary", rootRunId: "ps-root-1" },
				possibleStages: [...SCANNED],
			},
		);
		const snapshot = store.runs().find((candidate) => candidate.id === "ps-child-1");
		assert.equal(snapshot?.parentRunId, "ps-root-1");
		assert.equal(snapshot?.possibleStages, undefined);
	});

	test("corrupt persisted values are dropped, not fatal", () => {
		assert.equal(coercePossibleStages("not-an-array"), undefined);
		assert.equal(coercePossibleStages({ stages: [] }), undefined);
		assert.equal(coercePossibleStages(["ok", 42]), undefined);
		assert.deepEqual(coercePossibleStages(["a-*", "b"]), ["a-*", "b"]);

		const metadata = {
			workflowId: "ps-meta",
			name: "possible-stages-meta",
			inputs: {},
			status: "running" as const,
			completedCheckpoints: 0,
			pendingPrompts: 0,
			createdAt: 1,
			promptReservationEpoch: "epoch",
			updatedAt: 2,
		};
		const healthy = parseCurrentMetadataRecord(
			{
				stepName: metadataStepName(2),
				output: encodeMetadata({ ...metadata, possibleStages: [...SCANNED] }),
				completedAt: 3,
			},
			"ps-meta",
		);
		assert.deepEqual(healthy?.possibleStages, [...SCANNED]);

		// A corrupt value drops the field but keeps the record loadable: resume
		// must never fail because the scan metadata is malformed.
		const corrupted = parseCurrentMetadataRecord(
			{
				stepName: metadataStepName(3),
				output: encodeMetadata({ ...metadata, possibleStages: "garbage" as unknown as readonly string[] }),
				completedAt: 4,
			},
			"ps-meta",
		);
		assert.ok(corrupted !== undefined, "corrupt possibleStages must not reject the record");
		assert.equal(corrupted.possibleStages, undefined);
	});
});

// ---------------------------------------------------------------------------
// D10 — discovery/reload lint: zero-stage definitions warn
// ---------------------------------------------------------------------------

describe("possible-stages discovery lint (D10)", () => {
	const TEST_DIR = makeTempDirectory("possible-stages-lint");
	afterAll(() => {
		removeTempDirectory(TEST_DIR);
	});

	function writeWorkflow(relativeName: string, body: string): void {
		const workflowsDir = join(TEST_DIR, ".atomic", "workflows");
		makeDirectorySync(workflowsDir, { recursive: true });
		writeTextSync(
			join(workflowsDir, relativeName),
			[
				`import { workflow } from "@bastani/workflows";`,
				`export default workflow({`,
				`  name: ${JSON.stringify(relativeName.replace(/\.ts$/, ""))},`,
				`  description: "",`,
				`  inputs: {},`,
				`  outputs: {},`,
				`  run: async (ctx) => {`,
				body,
				`  },`,
				`});`,
			].join("\n"),
			"utf-8",
		);
	}

	test("a definition yielding zero stages logs a ZERO_STAGES warning", async () => {
		writeWorkflow("lint-empty.ts", "\t\t\treturn {};");
		writeWorkflow("lint-busy.ts", '\t\t\tawait ctx.stage("real-stage");\n\t\t\treturn {};');
		const result = await discoverWorkflows({
			cwd: TEST_DIR,
			homeDir: join(TEST_DIR, "home"),
			includeBundled: false,
		});
		const zeroStages = result.errors.filter((diagnostic) => diagnostic.code === "ZERO_STAGES");
		assert.equal(zeroStages.length, 1, JSON.stringify(result.errors, null, 1));
		assert.equal(zeroStages[0]?.level, "warn");
		assert.match(zeroStages[0]?.message ?? "", /lint-empty/);
		assert.equal(result.registry.has("lint-empty"), true, "the lint never blocks registration");
		assert.equal(result.registry.has("lint-busy"), true);
	});
});
