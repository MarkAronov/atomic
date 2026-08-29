import {
	type CodexFastModeResolvedSettings,
	type CodexFastModeScope,
	SettingsManager,
	shouldApplyCodexFastModeForScope,
} from "@bastani/atomic";
import type { Credential } from "@bastani/pi-ai";
import { splitKnownThinkingSuffix } from "./model-info.js";

export interface ResolveSubagentModelFastModeInput {
	model?: string;
	cwd: string;
	settings?: CodexFastModeResolvedSettings;
	scope?: CodexFastModeScope;
	copilotCredential?: Credential;
}

export interface ResolveSubagentModelFastModeMapInput {
	models: readonly (string | undefined)[];
	cwd: string;
	settings?: CodexFastModeResolvedSettings;
	scope?: CodexFastModeScope;
	copilotCredential?: Credential;
}

export interface ResolveSubagentModelFastModeMetadataInput {
	model?: string;
	modelCandidates: readonly (string | undefined)[];
	cwd: string;
	settings?: CodexFastModeResolvedSettings;
	scope?: CodexFastModeScope;
	copilotCredential?: Credential;
}

export interface SubagentModelFastModeMetadata {
	fastMode?: true;
	modelFastModes: Record<string, boolean>;
}

export function getSubagentCodexFastModeSettings(cwd: string): CodexFastModeResolvedSettings {
	try {
		return SettingsManager.create(cwd).getCodexFastModeSettings();
	} catch {
		return { chat: false, workflow: false };
	}
}

function modelIdentityFromModelId(model: string | undefined): { provider: string; id: string } | undefined {
	if (!model) return undefined;
	const { baseModel } = splitKnownThinkingSuffix(model);
	const slash = baseModel.indexOf("/");
	if (slash <= 0 || slash === baseModel.length - 1) return undefined;
	return { provider: baseModel.slice(0, slash), id: baseModel.slice(slash + 1) };
}

export function resolveSubagentCodexFastModeScope(
	orchestrationContext: { kind?: string } | undefined,
): CodexFastModeScope {
	return orchestrationContext?.kind === "workflow-stage" ? "workflow" : "chat";
}

export function resolveSubagentModelFastMode(input: ResolveSubagentModelFastModeInput): boolean {
	const model = modelIdentityFromModelId(input.model);
	if (!model) return false;
	const settings = input.settings ?? getSubagentCodexFastModeSettings(input.cwd);
	return shouldApplyCodexFastModeForScope(model, settings, input.scope ?? "chat", input.copilotCredential);
}

export function resolveSubagentModelFastModeMap(input: ResolveSubagentModelFastModeMapInput): Record<string, boolean> {
	const settings = input.settings ?? getSubagentCodexFastModeSettings(input.cwd);
	const fastModes: Record<string, boolean> = {};
	for (const model of input.models) {
		if (!model || Object.hasOwn(fastModes, model)) continue;
		fastModes[model] = resolveSubagentModelFastMode({
			model,
			cwd: input.cwd,
			settings,
			scope: input.scope,
			copilotCredential: input.copilotCredential,
		});
	}
	return fastModes;
}

export function resolveSubagentModelFastModeMetadata(
	input: ResolveSubagentModelFastModeMetadataInput,
): SubagentModelFastModeMetadata {
	const settings = input.settings ?? getSubagentCodexFastModeSettings(input.cwd);
	const fastMode = resolveSubagentModelFastMode({
		model: input.model,
		cwd: input.cwd,
		settings,
		scope: input.scope,
		copilotCredential: input.copilotCredential,
	});
	return {
		...(fastMode ? { fastMode: true as const } : {}),
		modelFastModes: resolveSubagentModelFastModeMap({
			models: input.modelCandidates,
			cwd: input.cwd,
			settings,
			scope: input.scope,
			copilotCredential: input.copilotCredential,
		}),
	};
}
