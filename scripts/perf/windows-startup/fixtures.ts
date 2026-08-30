import { createHash } from "node:crypto";
import { access, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { CacheProfile } from "./samples.js";

export interface RunDirectories {
	readonly agentDir: string;
	readonly sessionDir: string;
}

export async function createAgentTemplate(directory: string, port: number): Promise<void> {
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, "models.json"),
		`${JSON.stringify(
			{
				providers: {
					"benchmark-loopback": {
						baseUrl: `http://127.0.0.1:${port}/v1`,
						api: "openai-completions",
						apiKey: "benchmark",
						models: [
							{
								id: "benchmark-model",
								name: "benchmark-model",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 16_000,
								maxTokens: 1024,
							},
						],
					},
				},
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	await writeFile(
		join(directory, "settings.json"),
		`${JSON.stringify(
			{
				defaultProvider: "benchmark-loopback",
				defaultModel: "benchmark-model",
				lastChangelogVersion: "0.0.0",
				firstRunOnboardingStartedVersion: "0.0.0",
				onboardedVersion: "0.0.0",
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
}

export async function prepareRunDirectories(
	stateRoot: string,
	templateDirectory: string,
	runId: string,
	profile: CacheProfile,
): Promise<RunDirectories> {
	const runRoot = join(stateRoot, "runs", runId);
	const sessionDir = join(runRoot, "sessions");
	const agentDir = profile === "warm" ? join(stateRoot, "warm-agent") : join(runRoot, "agent");
	await rm(runRoot, { recursive: true, force: true });
	await mkdir(sessionDir, { recursive: true });
	if (profile === "warm") {
		try {
			await access(agentDir);
		} catch {
			await cp(templateDirectory, agentDir, { recursive: true });
		}
	} else {
		await cp(templateDirectory, agentDir, { recursive: true });
	}
	return { agentDir, sessionDir };
}

export function benchmarkEnvironment(
	agentDir: string,
	executableDirectory: string,
	baseEnvironment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const environment: Record<string, string> = {
		...Object.fromEntries(
			Object.entries(baseEnvironment).filter((entry): entry is [string, string] => entry[1] !== undefined),
		),
		ATOMIC_CODING_AGENT_DIR: agentDir,
		ATOMIC_OFFLINE: "1",
		ATOMIC_REDUCED_MOTION: "0",
		ATOMIC_SKIP_VERSION_CHECK: "1",
		ATOMIC_TELEMETRY: "0",
		CI: "0",
		NO_COLOR: "1",
		TERM: "xterm-256color",
		PATH: `${executableDirectory}${delimiter}${baseEnvironment.PATH ?? ""}`,
	};
	delete environment.ATOMIC_STARTUP_BENCHMARK;
	delete environment.ATOMIC_TIMING;
	return environment;
}

export function environmentHash(environment: Readonly<Record<string, string>>): string {
	const pathEntries = (environment.PATH ?? "").split(delimiter);
	if (pathEntries.length > 0) pathEntries[0] = "<executable-dir>";
	const deterministic = [
		`ATOMIC_CODING_AGENT_DIR=<agent-dir>`,
		`ATOMIC_OFFLINE=${environment.ATOMIC_OFFLINE ?? ""}`,
		`ATOMIC_REDUCED_MOTION=${environment.ATOMIC_REDUCED_MOTION ?? ""}`,
		`ATOMIC_SKIP_VERSION_CHECK=${environment.ATOMIC_SKIP_VERSION_CHECK ?? ""}`,
		`ATOMIC_TELEMETRY=${environment.ATOMIC_TELEMETRY ?? ""}`,
		`CI=${environment.CI ?? ""}`,
		`NO_COLOR=${environment.NO_COLOR ?? ""}`,
		`TERM=${environment.TERM ?? ""}`,
		`PATH=${pathEntries.join(delimiter)}`,
	].join("\n");
	return createHash("sha256").update(deterministic).digest("hex");
}
