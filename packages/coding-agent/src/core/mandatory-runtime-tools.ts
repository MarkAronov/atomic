const MANDATORY_TOOL_NAMES = new Set(["intercom"]);

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
