#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LoopbackProviderCollector } from "./collector.js";
import { type ConptyProcess, startConpty } from "./conpty.js";
import { benchmarkEnvironment, createAgentTemplate, environmentHash, prepareRunDirectories } from "./fixtures.js";
import {
	type BenchmarkBuild,
	type BenchmarkLane,
	type BenchmarkSample,
	type CacheProfile,
	elapsedMs,
	persistSample,
} from "./samples.js";
import { type ScreenObservation, type ScreenSnapshot, StartupScreenTracker } from "./screen.js";

interface ArtifactMetadata {
	readonly artifactHashes?: Readonly<Record<string, string>>;
	readonly runtime?: Readonly<Record<string, string>>;
}

interface BuildTarget {
	readonly build: BenchmarkBuild;
	readonly executableDirectory: string;
	readonly metadata: ArtifactMetadata;
}

interface BenchmarkOptions {
	readonly outputDirectory: string;
	readonly lane: BenchmarkLane;
	readonly profile: CacheProfile;
	readonly version: string;
	readonly repeats: number;
	readonly port: number;
	readonly timeoutMs: number;
	readonly cwd: string;
	readonly targets: readonly BuildTarget[];
	readonly seed: number;
}

function quoteArgument(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function timeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
	return Promise.race([
		promise,
		delay(milliseconds).then(() => {
			throw new Error(`${label} timed out after ${milliseconds} ms`);
		}),
	]);
}

async function waitForScreen(
	tracker: StartupScreenTracker,
	flush: () => Promise<void>,
	predicate: (observation: ScreenObservation) => boolean,
	timeoutMs: number,
	label: string,
): Promise<ScreenObservation> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await flush();
		const observation = tracker.observe(process.hrtime.bigint());
		if (predicate(observation)) return observation;
		await delay(10);
	}
	throw new Error(`${label} timed out after ${timeoutMs} ms`);
}

function shuffleBit(seed: number): number {
	let state = seed >>> 0;
	state ^= state << 13;
	state ^= state >>> 17;
	state ^= state << 5;
	return state & 1;
}

export function createBalancedOrder(
	targets: readonly BenchmarkBuild[],
	repeats: number,
	seed: number,
): BenchmarkBuild[] {
	if (targets.length === 0) throw new Error("at least one benchmark target is required");
	if (targets.length === 1) return Array.from({ length: repeats }, () => targets[0]!);
	if (targets.length !== 2) throw new Error("balanced startup order supports exactly baseline and candidate");
	const [first, second] = shuffleBit(seed) === 0 ? targets : [targets[1]!, targets[0]!];
	const order: BenchmarkBuild[] = [];
	for (let pair = 0; pair < repeats; pair += 1) {
		if (pair % 2 === 0) order.push(first!, second!);
		else order.push(second!, first!);
	}
	return order;
}

async function loadMetadata(path: string, build: BenchmarkBuild): Promise<ArtifactMetadata> {
	const metadata = JSON.parse(await readFile(path, "utf8")) as ArtifactMetadata;
	if (!metadata.artifactHashes || Object.keys(metadata.artifactHashes).length === 0) {
		throw new Error(`${build} metadata must contain artifactHashes`);
	}
	if (!metadata.runtime || Object.keys(metadata.runtime).length === 0) {
		throw new Error(`${build} metadata must contain runtime identity`);
	}
	return metadata;
}

function parseInteger(value: string | undefined, name: string, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
	return parsed;
}

async function parseOptions(argv: readonly string[]): Promise<BenchmarkOptions> {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (!flag?.startsWith("--") || value === undefined) throw new Error(`invalid argument near ${flag ?? "<end>"}`);
		values.set(flag.slice(2), value);
	}
	const outputDirectory = values.get("output");
	const lane = values.get("lane");
	const profile = values.get("profile");
	const version = values.get("version");
	if (
		!outputDirectory ||
		(lane !== "release" && lane !== "node") ||
		(profile !== "warm" && profile !== "atomic-state-cold") ||
		!version
	) {
		throw new Error("required: --output DIR --lane release|node --profile warm|atomic-state-cold --version VERSION");
	}
	if (lane === "node" && profile !== "warm") throw new Error("the Node lane supports the warm profile only");
	const targets: BuildTarget[] = [];
	for (const build of ["baseline", "candidate"] as const) {
		const executableDirectory = values.get(`${build}-bin`);
		if (!executableDirectory) continue;
		const metadataPath = values.get(`${build}-metadata`);
		if (!metadataPath) throw new Error(`--${build}-metadata is required with --${build}-bin`);
		targets.push({
			build,
			executableDirectory: resolve(executableDirectory),
			metadata: await loadMetadata(metadataPath, build),
		});
	}
	if (targets.length === 0) throw new Error("provide --baseline-bin and optionally --candidate-bin");
	return {
		outputDirectory: resolve(outputDirectory),
		lane,
		profile,
		version,
		repeats: parseInteger(values.get("repeats"), "repeats", 30),
		port: parseInteger(values.get("port"), "port", 43_171),
		timeoutMs: parseInteger(values.get("timeout-ms"), "timeout-ms", 60_000),
		cwd: resolve(values.get("cwd") ?? process.cwd()),
		targets,
		seed: parseInteger(values.get("seed"), "seed", 0x41544f4d),
	};
}

async function settleProcess(process: ConptyProcess | undefined): Promise<void> {
	if (!process) return;
	try {
		await timeout(process.exited, 5_000, "atomic exit");
	} catch {
		process.kill();
		await process.exited.catch(() => undefined);
	}
}

async function runSample(options: BenchmarkOptions, target: BuildTarget, ordinal: number): Promise<BenchmarkSample> {
	const id = `${String(ordinal).padStart(3, "0")}-${target.build}-${randomUUID()}`;
	const nonce = `atomic-startup-${randomUUID()}`;
	const stateRoot = join(options.outputDirectory, "state", `${options.lane}-${target.build}-${options.profile}`);
	const templateDirectory = join(options.outputDirectory, "state", "agent-template");
	const collector = new LoopbackProviderCollector(nonce, { port: options.port });
	const tracker = new StartupScreenTracker(options.version, { cols: 120, rows: 40 });
	const chunks: Array<{ atNs: string; data: string }> = [];
	let ptyOutput = "";
	let coherentSnapshot: ScreenSnapshot | undefined;
	let completeSnapshot: ScreenSnapshot | undefined;
	let screenQueue = Promise.resolve();
	let child: ConptyProcess | undefined;
	let chunkError: Error | undefined;
	let launchStarted = false;
	let state: BenchmarkSample["state"] = "success";
	const failures: string[] = [];
	const marks: Record<string, string> = {};
	let workflowListSucceeded = false;
	let environmentDigest: string | undefined;
	let commandLine = "";
	const startedAt = new Date().toISOString();
	const rawArtifactDirectory = join("raw", options.lane, target.build, options.profile, id);
	try {
		await collector.start();
		await createAgentTemplate(templateDirectory, collector.port);
		const directories = await prepareRunDirectories(stateRoot, templateDirectory, id, options.profile);
		const environment = benchmarkEnvironment(directories.agentDir, target.executableDirectory);
		environmentDigest = environmentHash(environment);
		commandLine = `atomic --session-dir ${quoteArgument(directories.sessionDir)} --provider benchmark-loopback --model benchmark-model`;
		marks.processLaunch = process.hrtime.bigint().toString();
		child = startConpty({
			command: commandLine,
			cwd: options.cwd,
			env: environment,
			timeoutMs: options.timeoutMs * 3,
			onChunk: (chunk, atNs) => {
				marks.firstTerminalOutput ??= atNs.toString();
				chunks.push({ atNs: atNs.toString(), data: chunk });
				ptyOutput += chunk;
				screenQueue = screenQueue.then(async () => {
					const observation = await tracker.write(chunk, atNs);
					if (!coherentSnapshot && observation.coherent) {
						coherentSnapshot = observation;
						marks.startupCoherent = observation.atNs;
					}
				});
			},
			onChunkError: (error) => {
				chunkError = error;
			},
		});
		launchStarted = true;
		const completed = await waitForScreen(
			tracker,
			() => screenQueue,
			(observation) => observation.complete,
			options.timeoutMs,
			"strict startup paint",
		);
		completeSnapshot = completed;
		marks.startupComplete = completed.atNs;
		child.write(nonce);
		await waitForScreen(
			tracker,
			() => screenQueue,
			(observation) => observation.text.includes(nonce),
			5_000,
			"nonce echo",
		);
		const enterAt = process.hrtime.bigint();
		marks.enter = enterAt.toString();
		child.write("\r");
		const request = await timeout(collector.waitForRequest(), options.timeoutMs, "provider dispatch");
		marks.providerFirstByte = request.firstByteNs;
		await waitForScreen(
			tracker,
			() => screenQueue,
			(observation) => observation.text.includes("benchmark-ok") && observation.coherent,
			options.timeoutMs,
			"provider response",
		);
		child.write("/workflow list\r");
		await waitForScreen(
			tracker,
			() => screenQueue,
			(observation) =>
				observation.text.includes("adversarial-verification") || observation.text.includes("classify-and-act"),
			options.timeoutMs,
			"/workflow list",
		);
		workflowListSucceeded = true;
		await delay(100);
		collector.assertSingleValidRequest();
		if (chunkError) throw new Error(`ConPTY output callback failed: ${chunkError.message}`);
		child.write("/quit\r");
		const exit = await timeout(child.exited, 5_000, "atomic exit");
		if (exit.timedOut || exit.cancelled || exit.exitCode !== 0) {
			throw new Error(
				`atomic did not exit cleanly: exit=${exit.exitCode ?? "null"}, timedOut=${exit.timedOut}, cancelled=${exit.cancelled}`,
			);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		failures.push(message);
		state = launchStarted ? "product-failure" : "invalid";
		try {
			child?.write("/quit\r");
		} catch {}
		await settleProcess(child);
	} finally {
		await screenQueue.catch((error) => failures.push(error instanceof Error ? error.message : String(error)));
		await collector.stop().catch((error) => failures.push(error instanceof Error ? error.message : String(error)));
		tracker.dispose();
	}
	if (state === "success" && failures.length > 0) state = "invalid";
	const processLaunch = marks.processLaunch ? BigInt(marks.processLaunch) : undefined;
	const startupComplete = marks.startupComplete ? BigInt(marks.startupComplete) : undefined;
	const enter = marks.enter ? BigInt(marks.enter) : undefined;
	const providerFirstByte = marks.providerFirstByte ? BigInt(marks.providerFirstByte) : undefined;
	const metricsMs =
		state === "success" && processLaunch && startupComplete && enter && providerFirstByte
			? {
					startupCompleteMs: elapsedMs(processLaunch, startupComplete),
					dispatchMs: elapsedMs(enter, providerFirstByte),
					spawnToDispatchMs: elapsedMs(processLaunch, providerFirstByte),
				}
			: undefined;
	const command =
		commandLine || "atomic --session-dir <uncreated> --provider benchmark-loopback --model benchmark-model";
	const sample: BenchmarkSample = {
		schemaVersion: 1,
		id,
		lane: options.lane,
		build: target.build,
		profile: options.profile,
		state,
		command,
		startedAt,
		marksNs: marks,
		...(metricsMs ? { metricsMs } : {}),
		artifactHashes: target.metadata.artifactHashes ?? {},
		...(environmentDigest ? { environmentHash: environmentDigest } : {}),
		...(target.metadata.runtime ? { runtime: target.metadata.runtime } : {}),
		rawArtifactDirectory,
		failures,
		providerValidation: {
			nonceFound: collector.requests[0]?.nonceFound ?? false,
			toolNames: collector.requests[0]?.toolNames ?? [],
			requestCount: collector.requests.length,
		},
		workflowListSucceeded,
	};
	await persistSample(options.outputDirectory, sample, {
		ptyOutput,
		receivedChunks: chunks,
		coherentSnapshot,
		completeSnapshot,
		providerRequests: collector.requests,
	});
	return sample;
}

export async function runBenchmark(options: BenchmarkOptions): Promise<readonly BenchmarkSample[]> {
	await mkdir(options.outputDirectory, { recursive: true });
	const order = createBalancedOrder(
		options.targets.map((target) => target.build),
		options.repeats,
		options.seed,
	);
	await writeFile(
		join(options.outputDirectory, "order.json"),
		`${JSON.stringify({ seed: options.seed, order }, null, 2)}\n`,
		"utf8",
	);
	const targets = new Map(options.targets.map((target) => [target.build, target]));
	const samples: BenchmarkSample[] = [];
	for (const [index, build] of order.entries()) {
		const target = targets.get(build);
		if (!target) throw new Error(`execution order references missing build: ${build}`);
		const sample = await runSample(options, target, index + 1);
		samples.push(sample);
		process.stdout.write(
			`${sample.id} ${sample.state}${sample.metricsMs ? ` startup=${sample.metricsMs.startupCompleteMs.toFixed(1)}ms dispatch=${sample.metricsMs.dispatchMs.toFixed(1)}ms` : ""}\n`,
		);
	}
	return samples;
}

if (import.meta.main) {
	const options = await parseOptions(process.argv.slice(2));
	await runBenchmark(options);
}
