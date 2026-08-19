import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import { test } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const workflowsSourceRoot = join(root, "packages", "workflows", "src");

function inside(parent: string, path: string): boolean {
	const fromParent = relative(parent, path);
	return fromParent !== ".." && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent);
}

function relativeImports(path: string): string[] {
	const imports = new Set<string>();
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (value === null || typeof value !== "object") return;
		const node = value as Record<string, unknown>;
		const type = node.type;
		if (type === "ImportDeclaration" || type === "ExportNamedDeclaration" || type === "ExportAllDeclaration") {
			const specifier = (node.source as { value?: unknown } | undefined)?.value;
			if (typeof specifier === "string" && specifier.startsWith(".")) imports.add(specifier);
		} else if (type === "TSImportType") {
			const specifier = (node.argument as { value?: unknown } | undefined)?.value;
			if (typeof specifier === "string" && specifier.startsWith(".")) imports.add(specifier);
		} else if (type === "ImportExpression") {
			const specifier = (node.source as { value?: unknown } | undefined)?.value;
			if (typeof specifier === "string" && specifier.startsWith(".")) imports.add(specifier);
		}
		for (const [key, child] of Object.entries(node)) {
			if (key !== "loc" && key !== "extra") visit(child);
		}
	};
	visit(parse(readFileSync(path, "utf8"), { sourceType: "module", plugins: ["typescript"] }));
	return [...imports];
}

function resolveTypeScriptImport(importer: string, specifier: string): string | undefined {
	const emittedPath = resolve(dirname(importer), specifier);
	const sourcePath = emittedPath
		.replace(/\.mjs$/u, ".mts")
		.replace(/\.cjs$/u, ".cts")
		.replace(/\.jsx$/u, ".tsx")
		.replace(/\.js$/u, ".ts");
	return [sourcePath, `${emittedPath}.ts`, join(emittedPath, "index.ts")].find(existsSync);
}

test("workflows authoring declaration surface stays inside packages/workflows/src", () => {
	const configPath = join(root, "packages", "coding-agent", "tsconfig.workflows-types.json");
	const config = JSON.parse(readFileSync(configPath, "utf8")) as {
		compilerOptions?: { rootDir?: string };
		include?: string[];
	};
	const configDir = dirname(configPath);
	assert.equal(
		resolve(configDir, config.compilerOptions?.rootDir ?? ""),
		workflowsSourceRoot,
		"authoring rootDir widened",
	);
	assert.ok(config.include?.length, "authoring config must name an entrypoint");

	const pending = config.include.map((entry) => resolve(configDir, entry));
	const visited = new Set<string>();
	const outsideSourceRoot = new Set<string>();
	while (pending.length > 0) {
		const path = pending.pop() as string;
		assert.ok(existsSync(path), `authoring entry or import does not exist: ${path}`);
		if (visited.has(path)) continue;
		visited.add(path);
		for (const specifier of relativeImports(path)) {
			const dependency = resolveTypeScriptImport(path, specifier);
			if (dependency === undefined) continue;
			if (inside(workflowsSourceRoot, dependency)) pending.push(dependency);
			else outsideSourceRoot.add(dependency);
		}
	}

	assert.ok(
		visited.has(join(workflowsSourceRoot, "shared", "budget.ts")),
		"budget.ts must remain on the authoring contract",
	);
	assert.deepEqual(
		[...outsideSourceRoot],
		[],
		`authoring source graph escaped packages/workflows/src:\n${[...outsideSourceRoot].join("\n")}`,
	);
});
