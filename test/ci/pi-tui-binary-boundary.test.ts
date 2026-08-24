import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { readJson, readText } from "../helpers/runtime.js";

interface PackageManifest {
	scripts: Record<string, string>;
}

const root = fileURLToPath(new URL("../..", import.meta.url));
const piTuiExternal = "--external @earendil-works/pi-tui";

function appBundleCommand(source: string): string {
	const command = source
		.split(/&&|\r?\n/u)
		.find((candidate) => candidate.includes("bun build") && candidate.includes("dist/bun/cli.js"));
	assert.ok(command, "missing shared app bundle command");
	return command;
}

test("standalone app builds leave pi-tui runtime-relative", async () => {
	const manifest = await readJson<PackageManifest>(`${root}/packages/coding-agent/package.json`);
	const releaseBuild = await readText(`${root}/scripts/build-binaries.sh`);

	for (const [site, command] of [
		["packages/coding-agent/package.json build:binary", appBundleCommand(manifest.scripts["build:binary"] ?? "")],
		["scripts/build-binaries.sh", appBundleCommand(releaseBuild)],
	] as const) {
		assert.ok(
			command.includes(piTuiExternal),
			`${site} must externalize pi-tui so a cross-compiled Windows archive does not freeze the build host's import.meta.url`,
		);
	}
});

test("release archives stage external pi-tui and its Windows native helper", async () => {
	const releaseBuild = await readText(`${root}/scripts/build-binaries.sh`);
	assert.ok(releaseBuild.includes('cp -r "$runtime_deps_dir" "binaries/$platform/node_modules"'));
	assert.ok(
		releaseBuild.includes(
			'console_src="../../node_modules/@earendil-works/pi-tui/native/win32/prebuilds/win32-$console_arch/win32-console-mode.node"',
		),
	);
	assert.ok(releaseBuild.includes('cp "$console_src" "$console_dst/"'));
});
