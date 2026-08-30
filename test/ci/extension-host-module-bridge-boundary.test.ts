import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
	bunExecutable,
	copyFileSync,
	makeDirectorySync,
	removeTempDirectory,
	spawnSyncCollect,
	writeTextSync,
} from "../helpers/runtime.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
/** Two real Bun builds plus execution across the compiled launcher/sidecar boundary. */
const COMPILED_HOST_MODULE_BRIDGE_TIMEOUT_MS = 120_000;

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function formatCommand(command: readonly string[]): string {
	return command.map((part) => JSON.stringify(part)).join(" ");
}

test(
	"compiled launcher exposes exact live host modules to an external ESM bundle",
	() => {
		const fixture = mkdtempSync(join(root, ".tmp-host-module-bridge-boundary."));
		const runtimeDir = join(fixture, "runtime");
		const executablePath = join(runtimeDir, process.platform === "win32" ? "atomic.exe" : "atomic");
		const appPath = join(runtimeDir, "app.js");
		const extensionPath = join(fixture, "extension.mjs");
		makeDirectorySync(runtimeDir, { recursive: true });

		try {
			writeTextSync(
				join(fixture, "extension-entry.ts"),
				'import lockfile, { lock } from "proper-lockfile";\n' +
					"export const importedDefault = lockfile;\n" +
					"export const importedNamed = lock;\n" +
					"export const namedType = typeof lock;\n" +
					'export function readHostMutation(): string { return (lockfile as { bridgeMarker?: string }).bridgeMarker ?? ""; }\n' +
					'export function mutateNamed(): void { (lock as { bridgeMarker?: string }).bridgeMarker = "external-mutated"; }\n',
			);
			writeTextSync(
				join(fixture, "app-entry.ts"),
				`import { installHostModuleBridge } from ${JSON.stringify(join(root, "packages/coding-agent/src/core/extensions/host-module-bridge.ts"))};\n` +
					`import { getVirtualModules } from ${JSON.stringify(join(root, "packages/coding-agent/src/core/extensions/loader-virtual-modules.ts"))};\n` +
					"void (async () => {\n" +
					'  const extensionPath = process.argv[2];\n  if (!extensionPath) throw new Error("missing extension path");\n' +
					"  const firstInstall = await installHostModuleBridge();\n" +
					"  const secondInstall = await installHostModuleBridge();\n" +
					'  if (!firstInstall.installed || secondInstall !== firstInstall || !firstInstall.specifiers.includes("proper-lockfile")) throw new Error("host bridge did not install exactly once");\n' +
					"  const modules = await getVirtualModules();\n" +
					'  const host = modules["proper-lockfile"] as { default: { bridgeMarker?: string }; lock: { bridgeMarker?: string } };\n' +
					"  const extension = await import(extensionPath);\n" +
					'  if (extension.namedType !== "function") throw new Error("named export missing");\n' +
					'  if (!Object.is(extension.importedDefault, host.default)) throw new Error("default export identity changed");\n' +
					'  if (!Object.is(extension.importedNamed, host.lock)) throw new Error("named export identity changed");\n' +
					'  host.default.bridgeMarker = "host-mutated";\n' +
					'  if (extension.readHostMutation() !== "host-mutated") throw new Error("host mutation was not shared");\n' +
					"  extension.mutateNamed();\n" +
					'  if (host.lock.bridgeMarker !== "external-mutated") throw new Error("extension mutation was not shared");\n' +
					'  console.log("compiled host-module bridge probe: OK");\n' +
					"})().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });\n",
			);
			writeTextSync(
				join(fixture, "split-loader.ts"),
				'process.env.ATOMIC_CODING_AGENT = "true";\n' +
					'import { dirname, join } from "node:path";\n' +
					'import { pathToFileURL } from "node:url";\n' +
					'void import(pathToFileURL(join(dirname(process.execPath), "app.js")).href);\n',
			);

			const extensionBuildCommand = [
				bunExecutable(),
				"build",
				"--target=bun",
				"--format=esm",
				"--external=proper-lockfile",
				join(fixture, "extension-entry.ts"),
				"--outfile",
				extensionPath,
			] as const;
			const extensionBuild = spawnSyncCollect(extensionBuildCommand, { cwd: root });
			assert.equal(extensionBuild.exitCode, 0, extensionBuild.stderr.toString());
			assert.match(readFileSync(extensionPath, "utf8"), /from\s+["']proper-lockfile["']/);

			const nativeFiles = readdirSync(join(root, "packages/natives/native")).filter((name) =>
				name.endsWith(".node"),
			);
			assert.ok(nativeFiles.length > 0, "Atomic native binding must be built before the binary-boundary test");
			cpSync(join(root, "packages/natives"), join(runtimeDir, "node_modules/@bastani/atomic-natives"), {
				recursive: true,
			});

			const appBuildCommand = [
				bunExecutable(),
				"build",
				"--target=bun",
				"--format=cjs",
				"--minify-syntax",
				"--external=mupdf",
				"--external=*native-modifiers.js",
				join(fixture, "app-entry.ts"),
				"--outfile",
				appPath,
			] as const;
			const appBuild = spawnSyncCollect(appBuildCommand, { cwd: root });
			assert.equal(appBuild.exitCode, 0, appBuild.stderr.toString());
			copyFileSync(
				join(root, "node_modules/@earendil-works/pi-tui/dist/native-modifiers.js"),
				join(runtimeDir, "native-modifiers.js"),
			);
			copyFileSync(
				join(root, "node_modules/@earendil-works/pi-tui/dist/native-module-path.js"),
				join(runtimeDir, "native-module-path.js"),
			);

			const launcherBuildCommand = [
				bunExecutable(),
				"build",
				"--compile",
				"--bytecode",
				"--format=cjs",
				"--external=mupdf",
				"--no-compile-autoload-dotenv",
				"--no-compile-autoload-bunfig",
				join(fixture, "split-loader.ts"),
				"--outfile",
				executablePath,
			] as const;
			const launcherBuild = spawnSyncCollect(launcherBuildCommand, { cwd: root });
			assert.equal(launcherBuild.exitCode, 0, launcherBuild.stderr.toString());

			console.log(`extension build: ${formatCommand(extensionBuildCommand)}`);
			console.log(`app build: ${formatCommand(appBuildCommand)}`);
			console.log(`launcher build: ${formatCommand(launcherBuildCommand)}`);
			console.log(`extension.mjs sha256: ${sha256(extensionPath)}`);
			console.log(`app.js sha256: ${sha256(appPath)}`);
			console.log(`atomic sha256: ${sha256(executablePath)}`);

			const startupCommand = [executablePath, extensionPath] as const;
			console.log(`startup: ${formatCommand(startupCommand)}`);
			const startup = spawnSyncCollect(startupCommand, { cwd: fixture });
			assert.equal(startup.exitCode, 0, startup.stderr.toString());
			assert.equal(startup.stdout.toString().trim(), "compiled host-module bridge probe: OK");
		} finally {
			removeTempDirectory(fixture);
		}
	},
	COMPILED_HOST_MODULE_BRIDGE_TIMEOUT_MS,
);
