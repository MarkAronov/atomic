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

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
			sessionPath: "/tmp/session.jsonl",
			outputArtifactPath: "/tmp/out.md",
		});
		assert.equal(recovered.source, "progress.md");
		assert.match(recovered.text, /Run cancelled by parent after 70 tool calls/);
		assert.match(recovered.text, /Partial findings from progress\.md/);
		assert.match(recovered.text, /Found auth middleware/);
		assert.match(recovered.text, /incomplete and has not been validated/);
		assert.match(recovered.text, /Session: \/tmp\/session\.jsonl/);
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
		sessionPath: "/tmp/session.jsonl",
	});
	assert.equal(recovered.source, "assistant");
	assert.match(recovered.text, /Partial findings from assistant history/);
	assert.match(recovered.text, /Verified the login redirect/);
	assert.match(recovered.text, /incomplete and has not been validated/);
});

test("without recoverable content, recovery returns a cancellation notice and artifact refs", () => {
	const recovered = recoverCancelledChildOutput({
		toolCount: 0,
		sessionPath: "/tmp/session.jsonl",
		outputArtifactPath: "/tmp/out.md",
		progressPath: "/tmp/progress.md",
		progressArtifactPath: "/tmp/progress.md",
	});
	assert.equal(recovered.source, "none");
	assert.match(recovered.text, /Run cancelled by parent/);
	assert.doesNotMatch(recovered.text, /after 0 tool calls/);
	assert.match(recovered.text, /Session: \/tmp\/session\.jsonl/);
	assert.doesNotMatch(recovered.text, /Output: /);
	assert.doesNotMatch(recovered.text, /Progress: /);
	assert.doesNotMatch(recovered.text, /^abort$/);
	assert.equal(isParentCancellation("abort"), true);
	assert.equal(isParentCancellation("interrupt"), false);
});

test("cancelled envelopes cite progress and output artifacts only when those files exist", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-cancel-progress-exists-"));
	try {
		const missing = recoverCancelledChildOutput({
			progressArtifactPath: join(root, "missing.md"),
			outputArtifactPath: join(root, "missing-out.md"),
		});
		assert.doesNotMatch(missing.text, /Progress: /);
		assert.doesNotMatch(missing.text, /Output: /);
		const progressArtifactPath = join(root, "progress.md");
		const outputArtifactPath = join(root, "out.md");
		writeFileSync(progressArtifactPath, "# Progress\n\n- Kept finding\n");
		writeFileSync(outputArtifactPath, "kept\n");
		const present = recoverCancelledChildOutput({
			progressPath: progressArtifactPath,
			progressArtifactPath,
			outputArtifactPath,
		});
		assert.match(present.text, new RegExp(`Progress: ${escapeRegExp(progressArtifactPath)}`));
		assert.match(present.text, new RegExp(`Output: ${escapeRegExp(outputArtifactPath)}`));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
