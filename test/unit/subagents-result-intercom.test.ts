import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	buildSubagentResultIntercomPayload,
	resolveSubagentResultStatus,
} from "../../packages/subagents/src/intercom/result-intercom.js";
import type { SubagentResultIntercomChild } from "../../packages/subagents/src/shared/types.js";

describe("subagent result intercom helpers", () => {
	test("resolves result status from typed statuses and legacy state projections", () => {
		assert.equal(resolveSubagentResultStatus({ detached: true, success: true }), "detached");
		assert.equal(resolveSubagentResultStatus({ status: "interrupted" }), "interrupted");
		assert.equal(resolveSubagentResultStatus({ state: "interrupted" }), "interrupted");
		assert.equal(resolveSubagentResultStatus({ status: "ok" }), "completed");
		assert.equal(resolveSubagentResultStatus({ status: "error" }), "failed");
		assert.equal(resolveSubagentResultStatus({ status: "skipped" }), "failed");
	});

	test("a result payload reports the parent's direct children and nothing below them", () => {
		const children: SubagentResultIntercomChild[] = [
			{ agent: "worker-a", status: "completed", index: 0, summary: "done a" },
			{ agent: "worker-b", status: "failed", index: 1, summary: "  " },
		];

		const payload = buildSubagentResultIntercomPayload({
			to: "orchestrator",
			runId: "root",
			mode: "parallel",
			children,
		});

		assert.deepEqual(
			payload.children.map((child) => child.agent),
			["worker-a", "worker-b"],
		);
		// Delegation is one level deep, so no child can carry descendants of its own.
		for (const child of payload.children) {
			assert.equal("children" in child, false);
		}
		assert.equal(payload.status, "failed");
		assert.equal(payload.children[1]?.summary, "(no output)", "an empty summary falls back rather than vanishing");
		assert.match(payload.message, /Children: 1 completed, 1 failed/);
		assert.doesNotMatch(payload.message, /Nested subagents:/);
	});
});
