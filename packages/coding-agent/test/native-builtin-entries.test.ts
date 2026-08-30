import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, test } from "vitest";
import {
	BUILTIN_PACKAGE_DIR_NAMES,
	INSTALLED_EXTENSION_ENTRIES,
	SOURCE_EXTENSION_ENTRIES,
} from "../src/core/builtin-install-layout.ts";
import {
	getNativeBuiltinExtensionEntries,
	isNativeBuiltinExtensionPath,
	resetNativeBuiltinExtensionEntriesForTest,
} from "../src/core/extensions/native-builtin-entries.ts";

const roots: string[] = [];
const originalPackageDir = process.env.ATOMIC_PACKAGE_DIR;

function createInstall(options: { spoof?: "workflows" } = {}): string {
	const packageDir = mkdtempSync(join(tmpdir(), "atomic-native-builtins-"));
	roots.push(packageDir);
	for (const dirName of BUILTIN_PACKAGE_DIR_NAMES) {
		const builtinDir = join(packageDir, "builtin", dirName);
		const installedEntry = join(builtinDir, INSTALLED_EXTENSION_ENTRIES[dirName]);
		mkdirSync(dirname(installedEntry), { recursive: true });
		writeFileSync(
			join(builtinDir, "package.json"),
			JSON.stringify({
				name: options.spoof === dirName ? "user-controlled-package" : `@bastani/${dirName}`,
				atomic: { extensions: ["manifest-only.bundle.mjs"] },
			}),
		);
		writeFileSync(installedEntry, "export default function register() {}\n");
		writeFileSync(join(builtinDir, "manifest-only.bundle.mjs"), "export default function register() {}\n");
		const sourceEntry = join(builtinDir, SOURCE_EXTENSION_ENTRIES[dirName]);
		mkdirSync(dirname(sourceEntry), { recursive: true });
		if (!existsSync(sourceEntry)) writeFileSync(sourceEntry, "export default function register() {}\n");
	}
	process.env.ATOMIC_PACKAGE_DIR = packageDir;
	resetNativeBuiltinExtensionEntriesForTest();
	return packageDir;
}

afterEach(() => {
	if (originalPackageDir === undefined) delete process.env.ATOMIC_PACKAGE_DIR;
	else process.env.ATOMIC_PACKAGE_DIR = originalPackageDir;
	resetNativeBuiltinExtensionEntriesForTest();
	while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

test("trusts exactly the five identity-verified installed builtin entries", () => {
	const packageDir = createInstall();
	const expected = BUILTIN_PACKAGE_DIR_NAMES.map((dirName) =>
		resolve(packageDir, "builtin", dirName, INSTALLED_EXTENSION_ENTRIES[dirName]),
	);

	assert.deepEqual([...getNativeBuiltinExtensionEntries()], expected);
});

test("does not infer builtin trust from suffixes, filenames, manifests, or source entries", () => {
	const packageDir = createInstall();
	const arbitrary = join(packageDir, "arbitrary.mjs");
	writeFileSync(arbitrary, "export default function register() {}\n");
	const workflowsDir = join(packageDir, "builtin", "workflows");
	const sibling = join(workflowsDir, "sibling.mjs");
	writeFileSync(sibling, "export default function register() {}\n");

	assert.equal(isNativeBuiltinExtensionPath(arbitrary), false);
	assert.equal(isNativeBuiltinExtensionPath(join(workflowsDir, "manifest-only.bundle.mjs")), false);
	assert.equal(isNativeBuiltinExtensionPath(sibling), false);
	assert.equal(isNativeBuiltinExtensionPath(join(workflowsDir, SOURCE_EXTENSION_ENTRIES.workflows)), false);
});

test("rejects an installed-looking entry when the package identity is not Atomic-owned", () => {
	const packageDir = createInstall({ spoof: "workflows" });
	const spoofedEntry = resolve(packageDir, "builtin", "workflows", INSTALLED_EXTENSION_ENTRIES.workflows);

	assert.equal(isNativeBuiltinExtensionPath(spoofedEntry), false);
	assert.equal(getNativeBuiltinExtensionEntries().size, 4);
});
