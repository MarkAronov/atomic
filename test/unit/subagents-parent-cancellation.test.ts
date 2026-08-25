import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
	INITIAL_PROGRESS_CONTENT,
	isParentCancellation,
	readModifiedProgress,
	recoverCancelledChildOutput,
} from "../../packages/subagents/src/runs/shared/cancellation-recovery.ts";

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
