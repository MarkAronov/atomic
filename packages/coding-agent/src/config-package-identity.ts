import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { BUILTIN_PACKAGE_DIR_NAMES } from "./core/builtin-install-layout.ts";

export const COMPANION_BUILTIN_PACKAGE_NAMES: readonly string[] = BUILTIN_PACKAGE_DIR_NAMES.map(
	(dirName) => `@bastani/${dirName}`,
);

type PackageIdentityJson = {
	readonly name?: string;
	readonly atomicConfig?: unknown;
	readonly piConfig?: unknown;
};

export function isCompanionBuiltinPackageName(name: string | undefined): boolean {
	return name !== undefined && COMPANION_BUILTIN_PACKAGE_NAMES.includes(name);
}

export function packageJsonDefinesAppIdentity(pkg: PackageIdentityJson): boolean {
	if (pkg.name === "@bastani/atomic" || pkg.name === "@mariozechner/pi") return true;
	return hasObjectField(pkg.atomicConfig) || hasObjectField(pkg.piConfig);
}

/**
 * Walk from a bundled or compiled module directory to the Atomic app package.
 *
 * Prebundled companion extensions live under `dist/builtin/<name>/` with their
 * own `package.json`. The first package.json from those bundles is
 * `@bastani/workflows` (or another companion), which must not become APP_NAME.
 */
export function resolvePackageDirFrom(startDir: string): string {
	let dir = startDir;
	let firstPackageDir: string | undefined;
	while (dir !== dirname(dir)) {
		const packageJsonPath = join(dir, "package.json");
		if (existsSync(packageJsonPath)) {
			firstPackageDir ??= dir;
			if (shouldUsePackageDir(readPackageIdentity(packageJsonPath))) {
				return dir;
			}
		}
		dir = dirname(dir);
	}
	return firstPackageDir ?? startDir;
}

function shouldUsePackageDir(pkg: PackageIdentityJson): boolean {
	if (packageJsonDefinesAppIdentity(pkg)) return true;
	return !isCompanionBuiltinPackageName(pkg.name);
}

function hasObjectField(value: unknown): boolean {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readPackageIdentity(packageJsonPath: string): PackageIdentityJson {
	try {
		const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as PackageIdentityJson;
		}
	} catch {
		// Unreadable or invalid JSON is not an app identity package.
	}
	return {};
}
