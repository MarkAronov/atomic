import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { parse } from "acorn";
import { simple } from "acorn-walk";
import { test } from "vitest";
import { INSTALLED_EXTENSION_ENTRIES } from "../../packages/coding-agent/src/core/builtin-install-layout.js";
import { getVirtualModules } from "../../packages/coding-agent/src/core/extensions/loader-host-modules.js";
import { moduleDir, spawnSyncCollect } from "../helpers/runtime.js";

const root = join(moduleDir(import.meta.url), "../..");
const BUILTIN_BUNDLE_BUILD_TIMEOUT_MS = 120_000;
const nodeBuiltinSpecifiers = new Set(builtinModules.flatMap((specifier) => [specifier, `node:${specifier}`]));

function isBareSpecifier(specifier: string): boolean {
	return !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("file:");
}

function collectImportSpecifiers(source: string): Set<string> {
	const specifiers = new Set<string>();
	const program = parse(source, { ecmaVersion: "latest", sourceType: "module" });
	const addLiteral = (value: string | number | bigint | boolean | RegExp | null | undefined): void => {
		if (typeof value === "string") specifiers.add(value);
	};
	simple(program, {
		ImportDeclaration: (node) => addLiteral(node.source.value),
		ExportNamedDeclaration: (node) => addLiteral(node.source?.value),
		ExportAllDeclaration: (node) => addLiteral(node.source.value),
		ImportExpression: (node) => {
			if (node.source.type === "Literal") addLiteral(node.source.value);
		},
	});
	return specifiers;
}

test(
	"installed builtin entry bundles retain only node builtins and registered host imports",
	async () => {
		const build = spawnSyncCollect(["npm", "run", "build", "--workspace=@bastani/atomic"], { cwd: root });
		assert.equal(build.exitCode, 0, `${build.stdout.toString()}\n${build.stderr.toString()}`);

		const hostSpecifiers = new Set(Object.keys(await getVirtualModules()));
		const unexpected: string[] = [];

		for (const [dirName, relativeEntry] of Object.entries(INSTALLED_EXTENSION_ENTRIES)) {
			const entryPath = join(root, "packages/coding-agent/dist/builtin", dirName, relativeEntry);
			const source = readFileSync(entryPath, "utf8");
			for (const specifier of collectImportSpecifiers(source)) {
				if (isBareSpecifier(specifier) && !nodeBuiltinSpecifiers.has(specifier) && !hostSpecifiers.has(specifier)) {
					unexpected.push(`${dirName}: ${specifier}`);
				}
			}
		}

		assert.deepEqual(unexpected, []);
	},
	BUILTIN_BUNDLE_BUILD_TIMEOUT_MS,
);
