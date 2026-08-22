#!/usr/bin/env node

import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(repoRoot, "packages", "ai");
const destDir = join(repoRoot, "node_modules", "@earendil-works");
const dest = join(destDir, "pi-ai");

if (!existsSync(target)) {
	console.error("alias-pi-ai: packages/ai is missing");
	process.exit(1);
}

mkdirSync(destDir, { recursive: true });
if (existsSync(dest) || lstatSync(dest, { throwIfNoEntry: false })?.isSymbolicLink()) {
	rmSync(dest, { recursive: true, force: true });
}

const link = relative(destDir, target);
symlinkSync(link, dest, "dir");
console.log(`aliased @earendil-works/pi-ai -> ${link}`);
