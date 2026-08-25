import { expect, test } from "vitest";
import { allToolNames, defaultToolNames } from "../src/core/tools/index.ts";
import { createLocalPowerShellOperations } from "../src/core/tools/powershell.ts";
import { isPowerShellAvailable } from "../src/utils/shell.ts";

test("omits PowerShell from default and registered tools when no executable is available", () => {
	expect(allToolNames.has("powershell")).toBe(isPowerShellAvailable());
	expect(defaultToolNames.includes("powershell")).toBe(isPowerShellAvailable());
});

test("pre-aborted signals reject without running a command", async () => {
	const ops = createLocalPowerShellOperations();
	const controller = new AbortController();
	controller.abort();
	await expect(
		ops.exec("Write-Output hi", process.cwd(), {
			onData: () => {},
			signal: controller.signal,
		}),
	).rejects.toThrow(/aborted|only available on Windows|No PowerShell executable found/);
});

test("abort settles promptly instead of waiting on descendant-held streams", async () => {
	if (!isPowerShellAvailable()) return;

	const ops = createLocalPowerShellOperations();
	const controller = new AbortController();
	const started = Date.now();
	const run = ops.exec("Start-Sleep -Seconds 20", process.cwd(), {
		onData: () => {},
		signal: controller.signal,
	});
	controller.abort();
	await expect(run).rejects.toThrow(/aborted/);
	expect(Date.now() - started).toBeLessThan(2000);
});
