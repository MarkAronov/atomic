import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveWorkflow } from "../../packages/web-access/web-search-workflow.js";

test("resolveWorkflow defaults to none without an explicit summary-review opt-in", () => {
	assert.equal(resolveWorkflow(undefined, true), "none");
	assert.equal(resolveWorkflow(undefined, false), "none");
	assert.equal(resolveWorkflow("none", true), "none");
	assert.equal(resolveWorkflow("NONE", true), "none");
	assert.equal(resolveWorkflow("", true), "none");
	assert.equal(resolveWorkflow("result-review", true), "none");
	assert.equal(resolveWorkflow(1, true), "none");
});

test("resolveWorkflow enables the curator only for explicit summary-review when a UI is present", () => {
	assert.equal(resolveWorkflow("summary-review", true), "summary-review");
	assert.equal(resolveWorkflow("  Summary-Review  ", true), "summary-review");
	assert.equal(resolveWorkflow("summary-review", false), "none");
});
