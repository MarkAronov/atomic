import { getPowerShellConfig } from "../../utils/shell.ts";
import {
	type BashOperations,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashToolDefinition,
} from "./bash.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const UTF8_OUTPUT_PREFIX = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";
export const powershellToolSystemPromptContribution = {
	snippet: "Execute PowerShell commands.",
	guidelines: ["You can inspect ATOMIC_* or PI_* environment variables for current model and session details."],
} as const;
export type PowerShellOperations = BashOperations;
export type PowerShellToolDetails = BashToolDetails;
export type PowerShellToolInput = BashToolInput;
export interface PowerShellToolOptions extends Pick<BashToolOptions, "exposeSessionEnvironment" | "spawnHook"> {
	operations?: BashOperations;
}
export function createLocalPowerShellOperations(): PowerShellOperations {
	return {
		exec: async (command, cwd, options) => {
			const { shell, args } = getPowerShellConfig();
			const { spawn } = await import("node:child_process");
			if (options.signal?.aborted) throw new Error("aborted");
			return new Promise((resolve, reject) => {
				const child = spawn(shell, [...args, `${UTF8_OUTPUT_PREFIX}${command}`], {
					cwd,
					env: options.env,
					windowsHide: true,
				});
				let timedOut = false;
				let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
				const onAbort = () => {
					child.kill();
				};
				if (options.timeout !== undefined && options.timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						child.kill();
					}, options.timeout * 1000);
				}
				const finish = (handler: () => void) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					options.signal?.removeEventListener("abort", onAbort);
					handler();
				};
				child.stdout.on("data", (data: Buffer) => options.onData(data, "stdout"));
				child.stderr.on("data", (data: Buffer) => options.onData(data, "stderr"));
				child.once("error", (error) => finish(() => reject(error)));
				child.once("close", (exitCode) => {
					finish(() => {
						if (options.signal?.aborted) {
							reject(new Error("aborted"));
							return;
						}
						if (timedOut) {
							reject(new Error(`timeout:${options.timeout}`));
							return;
						}
						resolve({ exitCode });
					});
				});
				if (options.signal) {
					if (options.signal.aborted) onAbort();
					else options.signal.addEventListener("abort", onAbort, { once: true });
				}
			});
		},
	};
}
export function createPowerShellToolDefinition(cwd: string, options: PowerShellToolOptions = {}) {
	const definition = createBashToolDefinition(cwd, {
		...options,
		operations: options.operations ?? createLocalPowerShellOperations(),
	});
	return {
		...definition,
		name: "powershell",
		label: "powershell",
		description: "Execute a PowerShell command in the session workspace.",
		promptSnippet: powershellToolSystemPromptContribution.snippet,
		promptGuidelines: [...powershellToolSystemPromptContribution.guidelines],
	};
}
export function createPowerShellTool(cwd: string, options?: PowerShellToolOptions) {
	return wrapToolDefinition(createPowerShellToolDefinition(cwd, options));
}
export type PowerShellSpawnContext = never;
export type PowerShellSpawnHook = NonNullable<BashToolOptions["spawnHook"]>;
