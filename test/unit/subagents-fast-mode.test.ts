import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	resolveSubagentCodexFastModeScope,
	resolveSubagentModelFastMode,
	resolveSubagentModelFastModeMetadata,
} from "../../packages/subagents/src/shared/fast-mode.js";

const cwd = process.cwd();

describe("subagent fast-mode scope", () => {
	test("uses chat settings for main-chat subagents only", () => {
		const settings = { chat: true, workflow: false };

		assert.equal(resolveSubagentModelFastMode({ model: "openai/gpt-5.1-codex", cwd, settings, scope: "chat" }), true);
		assert.equal(
			resolveSubagentModelFastMode({ model: "openai/gpt-5.1-codex", cwd, settings, scope: "workflow" }),
			false,
		);
	});

	test("uses workflow settings for workflow-stage subagents only", () => {
		const settings = { chat: false, workflow: true };

		assert.equal(
			resolveSubagentModelFastMode({ model: "openai/gpt-5.1-codex", cwd, settings, scope: "chat" }),
			false,
		);
		assert.equal(
			resolveSubagentModelFastMode({ model: "openai/gpt-5.1-codex", cwd, settings, scope: "workflow" }),
			true,
		);
	});

	test("supports openai-codex models with thinking suffixes", () => {
		const settings = { chat: false, workflow: true };

		assert.equal(
			resolveSubagentModelFastMode({ model: "openai-codex/gpt-5.1-codex:medium", cwd, settings, scope: "workflow" }),
			true,
		);
		assert.equal(
			resolveSubagentModelFastMode({ model: "anthropic/claude-sonnet-4:medium", cwd, settings, scope: "workflow" }),
			false,
		);
	});

	test("requires an entitled Copilot fast sibling for chat fast-mode markers", () => {
		const settings = { chat: true, workflow: false };
		const entitledCredential = {
			type: "oauth" as const,
			access: "test-access-token",
			refresh: "test-refresh-token",
			expires: Number.MAX_SAFE_INTEGER,
			fastModelIds: ["gpt-5.6-sol-fast"],
		};
		const input = { model: "github-copilot/gpt-5.6-sol", cwd, settings, scope: "chat" as const };

		assert.equal(resolveSubagentModelFastMode({ ...input, copilotCredential: entitledCredential }), true);
		assert.equal(
			resolveSubagentModelFastMode({
				...input,
				model: "github-copilot/gpt-5.6-sol:xhigh",
				copilotCredential: entitledCredential,
			}),
			true,
		);
		assert.equal(resolveSubagentModelFastMode(input), false);
		assert.equal(
			resolveSubagentModelFastMode({
				...input,
				copilotCredential: { ...entitledCredential, fastModelIds: ["different-model-fast"] },
			}),
			false,
		);
		assert.equal(
			resolveSubagentModelFastMode({
				...input,
				settings: { chat: false, workflow: true },
				copilotCredential: entitledCredential,
			}),
			false,
		);
		assert.equal(
			resolveSubagentModelFastMode({
				...input,
				copilotCredential: { type: "api_key", key: "test-api-key" },
			}),
			false,
		);
		assert.equal(
			resolveSubagentModelFastMode({
				...input,
				model: "anthropic/claude-sonnet-4",
				copilotCredential: entitledCredential,
			}),
			false,
		);
	});

	test("keeps Copilot chat and workflow fast-mode scopes separate", () => {
		const copilotCredential = {
			type: "oauth" as const,
			access: "test-access-token",
			refresh: "test-refresh-token",
			expires: Number.MAX_SAFE_INTEGER,
			fastModelIds: ["gpt-5.6-sol-fast"],
		};
		const model = "github-copilot/gpt-5.6-sol";

		assert.equal(
			resolveSubagentModelFastMode({
				model,
				cwd,
				settings: { chat: true, workflow: false },
				scope: "chat",
				copilotCredential,
			}),
			true,
		);
		assert.equal(
			resolveSubagentModelFastMode({
				model,
				cwd,
				settings: { chat: true, workflow: false },
				scope: "workflow",
				copilotCredential,
			}),
			false,
		);
		assert.equal(
			resolveSubagentModelFastMode({
				model,
				cwd,
				settings: { chat: false, workflow: true },
				scope: "chat",
				copilotCredential,
			}),
			false,
		);
		assert.equal(
			resolveSubagentModelFastMode({
				model,
				cwd,
				settings: { chat: false, workflow: true },
				scope: "workflow",
				copilotCredential,
			}),
			true,
		);
	});

	test("builds scoped metadata for primary and fallback candidates", () => {
		const metadata = resolveSubagentModelFastModeMetadata({
			model: "openai/gpt-5.1-codex",
			modelCandidates: ["openai/gpt-5.1-codex", "anthropic/claude-sonnet-4"],
			cwd,
			settings: { chat: false, workflow: true },
			scope: "workflow",
		});

		assert.equal(metadata.fastMode, true);
		assert.deepEqual(metadata.modelFastModes, {
			"openai/gpt-5.1-codex": true,
			"anthropic/claude-sonnet-4": false,
		});
	});

	test("derives scope only from workflow-stage orchestration context", () => {
		assert.equal(resolveSubagentCodexFastModeScope(undefined), "chat");
		assert.equal(resolveSubagentCodexFastModeScope({ kind: "other-context" }), "chat");
		assert.equal(resolveSubagentCodexFastModeScope({ kind: "workflow-stage" }), "workflow");
	});
});
