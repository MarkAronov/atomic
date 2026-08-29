import type { Extension, RegisteredTool, ToolDefinition } from "./extensions/index.ts";

const MANDATORY_TOOL_NAMES = new Set(["intercom"]);
const TRUSTED_MANDATORY_DEFINITIONS = new WeakSet<ToolDefinition>();

/** Mark definitions loaded through Atomic's internally owned mandatory package path. */
export function markTrustedMandatoryRuntimeExtension(extension: Extension): void {
	for (const registration of extension.tools.values()) {
		if (MANDATORY_TOOL_NAMES.has(registration.definition.name)) {
			TRUSTED_MANDATORY_DEFINITIONS.add(registration.definition);
		}
	}
}

export function isTrustedMandatoryRuntimeTool(registration: RegisteredTool): boolean {
	return (
		MANDATORY_TOOL_NAMES.has(registration.definition.name) &&
		TRUSTED_MANDATORY_DEFINITIONS.has(registration.definition)
	);
}

/** Tools that every Atomic model session must keep registered and active. */
export function isMandatoryRuntimeTool(name: string): boolean {
	return MANDATORY_TOOL_NAMES.has(name);
}

export function appendRegisteredMandatoryTools<T extends { name: string }>(
	tools: T[],
	registry: ReadonlyMap<string, T>,
): T[] {
	for (const name of MANDATORY_TOOL_NAMES) {
		const tool = registry.get(name);
		if (tool && !tools.some((candidate) => candidate.name === name)) tools.push(tool);
	}
	return tools;
}
