import { resolve } from "node:path";

import { getMandatoryBuiltinExtensionPaths } from "./builtin-packages.ts";
import { getExtensionRuntimeEventBus, loadExtensions } from "./extensions/loader.ts";
import type { Extension, LoadExtensionsResult } from "./extensions/types.ts";
import { isTrustedMandatoryRuntimeTool, markTrustedMandatoryRuntimeExtension } from "./mandatory-runtime-tools.ts";
import type { ResourceExtensionPaths, ResourceLoader, ResourceLoaderReloadOptions } from "./resource-loader-types.ts";
import { buildSkillCatalog } from "./skill-catalog.ts";

function hasTrustedIntercom(extension: Extension): boolean {
	const registration = extension.tools.get("intercom");
	return registration !== undefined && isTrustedMandatoryRuntimeTool(registration);
}
function trustMandatoryExtension(extension: Extension): void {
	extension.sourceInfo = { ...extension.sourceInfo, configurationOrigin: "bundled" };
	for (const registration of extension.tools.values()) registration.sourceInfo = extension.sourceInfo;
	for (const command of extension.commands.values()) command.sourceInfo = extension.sourceInfo;
	markTrustedMandatoryRuntimeExtension(extension);
}

async function restoreMandatoryExtensions(loader: ResourceLoader, cwd: string): Promise<void> {
	const target = loader.getExtensions();
	if (target.extensions.some(hasTrustedIntercom)) return;

	const mandatoryPaths = getMandatoryBuiltinExtensionPaths();
	const mandatoryPathSet = new Set(mandatoryPaths.map((path) => resolve(path)));
	const alreadyLoaded = target.extensions.find((extension) => mandatoryPathSet.has(resolve(extension.resolvedPath)));
	if (alreadyLoaded) {
		trustMandatoryExtension(alreadyLoaded);
		return;
	}

	const loaded = await loadExtensions(
		mandatoryPaths,
		cwd,
		getExtensionRuntimeEventBus(target.runtime),
		undefined,
		target.runtime,
	);
	for (const extension of loaded.extensions) trustMandatoryExtension(extension);
	target.extensions.push(...loaded.extensions);
	target.errors.push(...loaded.errors);
	if (!target.extensions.some(hasTrustedIntercom)) {
		const detail = loaded.errors.map(({ error }) => error).join("; ") || "extension did not register intercom";
		throw new Error(`Mandatory bundled Intercom is unavailable: ${detail}`);
	}
}

class MandatoryResourceLoader implements ResourceLoader {
	private readonly delegate: ResourceLoader;
	private readonly cwd: string;
	private toolOnly = false;

	constructor(delegate: ResourceLoader, cwd: string) {
		this.delegate = delegate;
		this.cwd = cwd;
	}

	limitToTool(): void {
		this.toolOnly = true;
		this.removeLocalInteractionSurfaces();
	}

	private removeLocalInteractionSurfaces(): void {
		const extension = this.delegate.getExtensions().extensions.find(hasTrustedIntercom);
		extension?.commands.delete("intercom");
		extension?.shortcuts.delete("alt+m");
	}

	getExtensions(): LoadExtensionsResult {
		return this.delegate.getExtensions();
	}

	getSkills(): ReturnType<ResourceLoader["getSkills"]> {
		return this.delegate.getSkills();
	}

	getSkillCatalog(): ReturnType<NonNullable<ResourceLoader["getSkillCatalog"]>> {
		return this.delegate.getSkillCatalog?.() ?? buildSkillCatalog(this.delegate.getSkills().skills);
	}

	getPrompts(): ReturnType<ResourceLoader["getPrompts"]> {
		return this.delegate.getPrompts();
	}

	getThemes(): ReturnType<ResourceLoader["getThemes"]> {
		return this.delegate.getThemes();
	}

	getAgentsFiles(): ReturnType<ResourceLoader["getAgentsFiles"]> {
		return this.delegate.getAgentsFiles();
	}

	getSystemPrompt(): ReturnType<ResourceLoader["getSystemPrompt"]> {
		return this.delegate.getSystemPrompt();
	}

	getSystemPromptSource(): ReturnType<ResourceLoader["getSystemPromptSource"]> {
		return this.delegate.getSystemPromptSource();
	}

	getAppendSystemPrompt(): ReturnType<ResourceLoader["getAppendSystemPrompt"]> {
		return this.delegate.getAppendSystemPrompt();
	}

	getAppendSystemPromptSources(): ReturnType<ResourceLoader["getAppendSystemPromptSources"]> {
		return this.delegate.getAppendSystemPromptSources();
	}

	extendResources(paths: ResourceExtensionPaths): Promise<void> {
		return this.delegate.extendResources(paths);
	}

	async reload(options?: ResourceLoaderReloadOptions): Promise<void> {
		await this.delegate.reload(options);
		await restoreMandatoryExtensions(this.delegate, this.cwd);
		if (this.toolOnly) this.removeLocalInteractionSurfaces();
	}
}

/** Preserve caller-owned resources while restoring Atomic's mandatory bundled extension. */
export async function withMandatoryResourceLoader(loader: ResourceLoader, cwd: string): Promise<ResourceLoader> {
	if (loader instanceof MandatoryResourceLoader) return loader;
	await restoreMandatoryExtensions(loader, cwd);
	return new MandatoryResourceLoader(loader, cwd);
}

/** Keep a non-model interactive host from shadowing the engine's command and shortcut proxies. */
export function limitMandatoryIntercomToTool(loader: ResourceLoader): void {
	if (loader instanceof MandatoryResourceLoader) loader.limitToTool();
}
