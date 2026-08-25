import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.ts";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.ts";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.ts";
import {
	INITIAL_PROGRESS_CONTENT,
	isParentCancellation,
	readModifiedProgress,
	recoverCancelledChildOutput,
} from "../../packages/subagents/src/runs/shared/cancellation-recovery.ts";
import { DEFAULT_ARTIFACT_CONFIG } from "../../packages/subagents/src/shared/types.ts";
import { compactForegroundDetails } from "../../packages/subagents/src/shared/utils.ts";
import { resultStatusLine } from "../../packages/subagents/src/tui/render-status-progress.ts";
import { sleep } from "../helpers/runtime.ts";

function abortSession(root: string, gate: Promise<void>) {
	return {
		output: "must not complete",
		promptGate: gate,
		abortResolvesPrompt: true as const,
		promptLogPath: join(root, "prompt.log"),
	};
}

async function waitForPrompt(root: string): Promise<void> {
	const promptLogPath = join(root, "prompt.log");
	for (let attempt = 0; attempt < 200 && !existsSync(promptLogPath); attempt++) await sleep(5);
	assert.equal(existsSync(promptLogPath), true, "child prompt should start before abort");
}

function sampleAgent(): AgentConfig {
	return {
		name: "analysis",
		description: "analysis agent",
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: "/tmp/analysis.md",
	};
}

test("an untouched progress template is not treated as recoverable findings", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-cancel-progress-empty-"));
	try {
		const progressPath = join(root, "progress.md");
		writeFileSync(progressPath, INITIAL_PROGRESS_CONTENT);
		assert.equal(readModifiedProgress(progressPath), undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a modified progress.md is recovered as bounded labelled partial output", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-cancel-progress-"));
	try {
		const progressPath = join(root, "progress.md");
		writeFileSync(progressPath, "# Progress\n\n- Found auth middleware\n- Still unresolved: token refresh\n");
		const recovered = recoverCancelledChildOutput({
			progressPath,
			assistantText: "later unused assistant text",
			toolCount: 70,
			sessionPath: join(root, "session.jsonl"),
			outputArtifactPath: join(root, "out.md"),
		});
		assert.equal(recovered.source, "progress.md");
		assert.match(recovered.text, /Run cancelled by parent after 70 tool calls/);
		assert.match(recovered.text, /Partial findings from progress\.md/);
		assert.match(recovered.text, /Found auth middleware/);
		assert.match(recovered.text, /incomplete and has not been validated/);
		assert.doesNotMatch(recovered.text, /Session: /);
		assert.doesNotMatch(recovered.text, /Progress: /);
		assert.doesNotMatch(recovered.text, /Output: /);
		assert.doesNotMatch(recovered.text, /\bcompleted\b/i);
		assert.doesNotMatch(recovered.text, /^abort$/m);
		assert.doesNotMatch(recovered.text, /full output at /);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("oversized ephemeral progress truncates without citing the deleted path", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-cancel-progress-truncate-"));
	try {
		const progressPath = join(root, "progress.md");
		writeFileSync(
			progressPath,
			`${Array.from({ length: 201 }, (_, index) => `- finding ${index + 1}`).join("\n")}\n`,
		);
		const recovered = recoverCancelledChildOutput({
			progressPath,
			toolCount: 70,
		});
		assert.equal(recovered.source, "progress.md");
		assert.match(recovered.text, /Partial findings from progress\.md/);
		assert.match(recovered.text, /TRUNCATED:/);
		assert.doesNotMatch(recovered.text, /full output at /);
		assert.doesNotMatch(recovered.text, /Progress: /);
		assert.ok(!recovered.text.includes(progressPath));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("oversized persisted progress cites the artifact path in the truncation marker", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-cancel-progress-truncate-kept-"));
	try {
		const progressPath = join(root, "progress.md");
		const progressArtifactPath = join(root, "kept", "progress.md");
		writeFileSync(
			progressPath,
			`${Array.from({ length: 201 }, (_, index) => `- finding ${index + 1}`).join("\n")}\n`,
		);
		mkdirSync(join(root, "kept"), { recursive: true });
		writeFileSync(progressArtifactPath, "kept\n");
		const recovered = recoverCancelledChildOutput({
			progressPath,
			progressArtifactPath,
			toolCount: 4,
		});
		assert.equal(recovered.source, "progress.md");
		assert.match(recovered.text, /TRUNCATED:/);
		assert.match(recovered.text, new RegExp(`full output at ${progressArtifactPath.replaceAll("/", "\\/")}`));
		assert.match(recovered.text, new RegExp(`Progress: ${progressArtifactPath.replaceAll("/", "\\/")}`));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("without progress updates, recovery uses the last non-empty assistant text", () => {
	const recovered = recoverCancelledChildOutput({
		assistantText: "Verified the login redirect.",
		toolCount: 23,
		sessionPath: join(tmpdir(), "atomic-cancel-absent", "session.jsonl"),
	});
	assert.equal(recovered.source, "assistant");
	assert.match(recovered.text, /Partial findings from assistant history/);
	assert.match(recovered.text, /Verified the login redirect/);
	assert.match(recovered.text, /incomplete and has not been validated/);
});

test("without recoverable content, recovery returns a cancellation notice and artifact refs", () => {
	const recovered = recoverCancelledChildOutput({
		toolCount: 0,
		sessionPath: join(tmpdir(), "atomic-cancel-absent", "session.jsonl"),
		outputArtifactPath: join(tmpdir(), "atomic-cancel-absent", "out.md"),
		progressPath: join(tmpdir(), "atomic-cancel-absent", "progress.md"),
		progressArtifactPath: join(tmpdir(), "atomic-cancel-absent", "progress.md"),
	});
	assert.equal(recovered.source, "none");
	assert.match(recovered.text, /Run cancelled by parent/);
	assert.doesNotMatch(recovered.text, /after 0 tool calls/);
	assert.doesNotMatch(recovered.text, /Session: /);
	assert.doesNotMatch(recovered.text, /Output: /);
	assert.doesNotMatch(recovered.text, /Progress: /);
	assert.doesNotMatch(recovered.text, /^abort$/);
	assert.equal(isParentCancellation("abort"), true);
	assert.equal(isParentCancellation("interrupt"), false);
});

test("cancelled envelopes cite each artifact path only when that file exists", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-cancel-refs-"));
	try {
		const rows = [
			["Session", "sessionPath", join(root, "session.jsonl")],
			["Progress", "progressArtifactPath", join(root, "progress.md")],
			["Output", "outputArtifactPath", join(root, "out.md")],
		] as const;
		for (const [label, key, pathValue] of rows) {
			assert.doesNotMatch(recoverCancelledChildOutput({ [key]: pathValue }).text, new RegExp(`${label}: `));
			writeFileSync(pathValue, "kept\n");
			const present = recoverCancelledChildOutput({
				[key]: pathValue,
				...(key === "progressArtifactPath" ? { progressPath: pathValue } : {}),
			});
			assert.ok(present.text.includes(`${label}: ${pathValue}`));
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("parent abort is an interrupted cancellation, not a failed error", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-cancel-status-"));
	const gate = Promise.withResolvers<void>();
	const controller = new AbortController();
	clearSubagentControls();
	try {
		const pending = runSingleInProcess(root, sampleAgent(), "inspect fixture", {
			cwd: root,
			runId: "cancel-status-parent",
			sessionDir: join(root, "sessions"),
			signal: controller.signal,
			testSession: abortSession(root, gate.promise),
		});
		await waitForPrompt(root);
		controller.abort();
		const result = await pending;
		assert.equal(result.status, "interrupted");
		assert.equal(result.interrupted, true);
		assert.equal(result.cause, "abort");
		assert.equal(result.error, undefined);
		assert.equal(result.progress?.status, "interrupted");
		assert.equal(result.progress?.cause, "abort");
		assert.equal(result.progress?.error, undefined);
		assert.match(result.envelope ?? "", /Run cancelled by parent/);
		assert.doesNotMatch(result.envelope ?? "", /^abort$/);
		assert.notEqual(resultStatusLine(result, result.envelope ?? ""), "Interrupted");
		assert.match(resultStatusLine(result, result.envelope ?? ""), /Cancelled/i);
	} finally {
		gate.resolve();
		clearSubagentControls();
		rmSync(root, { recursive: true, force: true });
	}
});

test("ordinary user interrupt still reports progress as failed", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-cancel-user-interrupt-"));
	const gate = Promise.withResolvers<void>();
	const controller = new AbortController();
	clearSubagentControls();
	try {
		const pending = runSingleInProcess(root, sampleAgent(), "inspect fixture", {
			cwd: root,
			runId: "cancel-user-interrupt",
			sessionDir: join(root, "sessions"),
			interruptSignal: controller.signal,
			testSession: abortSession(root, gate.promise),
		});
		await waitForPrompt(root);
		controller.abort();
		const result = await pending;
		assert.equal(result.status, "interrupted");
		assert.equal(result.interrupted, true);
		assert.equal(result.cause, undefined);
		assert.equal(result.progress?.status, "failed");
		assert.equal(result.progress?.cause, undefined);
	} finally {
		gate.resolve();
		clearSubagentControls();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a thinking-only aborted final message recovers earlier assistant text", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-cancel-thinking-"));
	const gate = Promise.withResolvers<void>();
	const controller = new AbortController();
	clearSubagentControls();
	try {
		const pending = runSingleInProcess(root, sampleAgent(), "inspect fixture", {
			cwd: root,
			runId: "cancel-thinking-parent",
			sessionDir: join(root, "sessions"),
			signal: controller.signal,
			testSession: {
				...abortSession(root, gate.promise),
				seededAssistantText: "Found the retry loop in runner.ts.",
				thinkingOnlyOnAbort: true,
			},
		});
		await waitForPrompt(root);
		controller.abort();
		const result = await pending;
		assert.equal(result.status, "interrupted");
		assert.equal(result.cause, "abort");
		assert.match(result.envelope ?? "", /Partial findings from assistant history/);
		assert.match(result.envelope ?? "", /Found the retry loop in runner\.ts/);
		assert.doesNotMatch(result.envelope ?? "", /^abort$/);
	} finally {
		gate.resolve();
		clearSubagentControls();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a populated run-scoped progress.md wins over earlier assistant text", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-cancel-progress-win-"));
	const progressPath = join(root, "progress.md");
	writeFileSync(progressPath, "# Progress\n\n- Verified the abort listener fires.\n");
	const gate = Promise.withResolvers<void>();
	const controller = new AbortController();
	clearSubagentControls();
	try {
		const pending = runSingleInProcess(root, sampleAgent(), "inspect fixture", {
			cwd: root,
			runId: "cancel-progress-parent",
			sessionDir: join(root, "sessions"),
			signal: controller.signal,
			progressPath,
			testSession: {
				...abortSession(root, gate.promise),
				seededAssistantText: "older assistant note",
			},
		});
		await waitForPrompt(root);
		controller.abort();
		const result = await pending;
		assert.equal(result.status, "interrupted");
		assert.match(result.envelope ?? "", /Partial findings from progress\.md/);
		assert.match(result.envelope ?? "", /Verified the abort listener fires/);
		assert.doesNotMatch(result.envelope ?? "", /older assistant note/);
		assert.doesNotMatch(result.envelope ?? "", /Progress: /);
	} finally {
		gate.resolve();
		clearSubagentControls();
		rmSync(root, { recursive: true, force: true });
	}
});

test("parent abort keeps pre-cancel fallback metadata and does not start another fallback", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-cancel-no-fallback-"));
	const gate = Promise.withResolvers<void>();
	const controller = new AbortController();
	const sawFallback = Promise.withResolvers<void>();
	clearSubagentControls();
	try {
		const pending = runSingleInProcess(
			root,
			{ ...sampleAgent(), model: "provider/primary", fallbackModels: ["provider/fallback"] },
			"inspect fixture",
			{
				cwd: root,
				runId: "cancel-no-fallback",
				sessionDir: join(root, "sessions"),
				signal: controller.signal,
				onUpdate: (update) => {
					if (update.details?.results[0]?.model === "provider/fallback") sawFallback.resolve();
				},
				testSession: {
					...abortSession(root, gate.promise),
					fallbackModel: "provider/fallback",
					fallbackBeforeGate: true,
					sessionModel: "provider/primary",
					events: [
						{
							type: "model_fallback_start",
							from: "provider/fallback",
							to: "provider/would-be-next",
							reason: "post-abort",
							attempt: 2,
						},
					],
				},
			},
		);
		await Promise.race([
			sawFallback.promise,
			sleep(2000).then(() => {
				throw new Error("fallback model was not observed before abort");
			}),
		]);
		controller.abort();
		const result = await pending;
		assert.equal(result.status, "interrupted");
		assert.equal(result.cause, "abort");
		assert.deepEqual(result.attemptedModels, ["provider/primary", "provider/fallback"]);
		assert.equal(result.model, "provider/fallback");
		assert.ok(!(result.attemptedModels ?? []).includes("provider/would-be-next"));
		assert.match(result.envelope ?? "", /Run cancelled by parent/);
	} finally {
		gate.resolve();
		clearSubagentControls();
		rmSync(root, { recursive: true, force: true });
	}
});

test("parent abort before any fallback does not emit a fallback model", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-cancel-no-fallback-start-"));
	const gate = Promise.withResolvers<void>();
	const controller = new AbortController();
	clearSubagentControls();
	try {
		const pending = runSingleInProcess(
			root,
			{ ...sampleAgent(), model: "provider/primary", fallbackModels: ["provider/fallback"] },
			"inspect fixture",
			{
				cwd: root,
				runId: "cancel-no-fallback-start",
				sessionDir: join(root, "sessions"),
				signal: controller.signal,
				testSession: {
					...abortSession(root, gate.promise),
					fallbackModel: "provider/fallback",
					sessionModel: "provider/primary",
				},
			},
		);
		await waitForPrompt(root);
		controller.abort();
		const result = await pending;
		assert.equal(result.status, "interrupted");
		assert.equal(result.cause, "abort");
		assert.equal(result.attemptedModels, undefined);
		assert.equal(result.model, "provider/primary");
	} finally {
		gate.resolve();
		clearSubagentControls();
		rmSync(root, { recursive: true, force: true });
	}
});

test("parent abort without findings cites persisted output and progress artifacts", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-cancel-artifact-refs-"));
	const artifactsDir = join(root, "artifacts");
	const progressPath = join(root, "progress.md");
	writeFileSync(progressPath, INITIAL_PROGRESS_CONTENT);
	const gate = Promise.withResolvers<void>();
	const controller = new AbortController();
	clearSubagentControls();
	try {
		const pending = runSingleInProcess(root, sampleAgent(), "inspect fixture", {
			cwd: root,
			runId: "cancel-artifact-refs",
			sessionDir: join(root, "sessions"),
			sessionFile: join(root, "sessions", "session.jsonl"),
			signal: controller.signal,
			progressPath,
			artifactsDir,
			artifactConfig: DEFAULT_ARTIFACT_CONFIG,
			testSession: abortSession(root, gate.promise),
		});
		await waitForPrompt(root);
		controller.abort();
		const result = await pending;
		assert.equal(result.status, "interrupted");
		assert.equal(result.cause, "abort");
		assert.match(result.envelope ?? "", /Run cancelled by parent/);
		assert.match(result.envelope ?? "", /Session: /);
		assert.match(result.envelope ?? "", /Progress: /);
		assert.match(result.envelope ?? "", /Output: /);
		assert.ok(result.artifactPaths?.outputPath);
		assert.match(
			result.envelope ?? "",
			new RegExp(`Output: ${result.artifactPaths.outputPath.replaceAll("/", "\\/")}`),
		);
		const artifactText = readFileSync(result.artifactPaths.outputPath, "utf8");
		assert.match(artifactText, /Run cancelled by parent/);
		assert.notEqual(artifactText.trim(), "abort");
		assert.doesNotMatch(artifactText, /^abort$/);
	} finally {
		gate.resolve();
		clearSubagentControls();
		rmSync(root, { recursive: true, force: true });
	}
});

test("compacted terminal progress keeps the parent-cancel cause", () => {
	const compacted = compactForegroundDetails({
		mode: "single",
		results: [],
		progress: [
			{
				index: 0,
				agent: "analysis",
				status: "interrupted",
				cause: "abort",
				task: "inspect fixture",
				recentTools: [{ tool: "read", args: "foo", endMs: 1 }],
				recentOutput: ["scratch"],
				toolCount: 1,
				tokens: 0,
				durationMs: 10,
			},
		],
	});
	assert.equal(compacted.progress?.[0]?.status, "interrupted");
	assert.equal(compacted.progress?.[0]?.cause, "abort");
	assert.deepEqual(compacted.progress?.[0]?.recentTools, []);
});
