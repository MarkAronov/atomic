# Windows startup benchmark

This benchmark measures the ordinary interactive `atomic` command through a real Windows ConPTY. It keeps bundled workflows, subagents, MCP, web access, Intercom, and normal tools enabled. Runs that use `--no-extensions`, `--no-tools`, RPC, print/JSON mode, piped input, a positional prompt, or `ATOMIC_STARTUP_BENCHMARK` are diagnostic controls and are not valid headline evidence.

The two measured intervals use monotonic `process.hrtime.bigint()` marks:

- `startupCompleteMs`: process launch to the complete settled TUI paint.
- `dispatchMs`: writing Enter to the first TCP request byte received by the loopback provider.
- `spawnToDispatchMs`: process launch to that first TCP byte.

`screen.ts` feeds ordered ConPTY output into `@xterm/headless` at 120 columns by 40 rows. A coherent frame must show the exact installed version, an editor line beginning with `❯ `, and the cursor in that editor. Completion also requires the final three-line manifesto and two identical qualifying frames at least 80 ms apart. The older `time-to-first-frame` product mark is not used.

`collector.ts` uses a raw `net.Server`, timestamps the first socket byte before HTTP parsing, validates the per-run nonce and the complete required tool set, then returns a fixed OpenAI-compatible streaming response. Every successful sample runs `/workflow list` after the timed request and requires a bundled workflow name on screen.

## Prepare artifacts

Build and install the baseline and candidate before a timed batch. Do not build, install, alter antivirus settings, or perform source operations while samples run. Put each wrapper directory on its own immutable path:

- Release archive: reproduce the installer `atomic.cmd` and `atomic-current` junction layout. Pass the directory containing `atomic.cmd`.
- Node package: on a versionless base, pack `@bastani/atomic-natives`, `@bastani/pi-ai`, and `@bastani/atomic`, then install all three `0.0.0` tarballs together under one prefix. Installing only the Atomic tarball cannot resolve its unpublished placeholder dependencies. Pass the prefix's `node_modules\.bin` directory. The benchmark invokes that directory's `atomic.cmd`, not `node dist/cli.js`.

```powershell
npm pack --workspace=@bastani/atomic-natives --pack-destination C:\atomic-perf\packs
npm pack --workspace=@bastani/pi-ai --pack-destination C:\atomic-perf\packs
npm pack --workspace=@bastani/atomic --pack-destination C:\atomic-perf\packs
npm install --prefix C:\atomic-perf\node-baseline --ignore-scripts `
  C:\atomic-perf\packs\bastani-atomic-natives-0.0.0.tgz `
  C:\atomic-perf\packs\bastani-pi-ai-0.0.0.tgz `
  C:\atomic-perf\packs\bastani-atomic-0.0.0.tgz
```

Create one metadata JSON file per build. Hash the ZIP or package tarball, executable, `app.js`, and wrapper before timing.

```json
{
  "artifactHashes": {
    "archive": "sha256:...",
    "atomic.exe": "sha256:...",
    "app.js": "sha256:...",
    "atomic.cmd": "sha256:..."
  },
  "runtime": {
    "productSha": "...",
    "atomic": "0.0.0",
    "bun": "1.4.0",
    "node": "22.19.0",
    "vm": "cbx_..."
  }
}
```

## Run

Run the harness from one pinned harness commit for both products. The command inside ConPTY is always:

```text
atomic --session-dir <fresh-per-run-directory> --provider benchmark-loopback --model benchmark-model
```

Release warm, balanced baseline/candidate:

```powershell
bun run scripts/perf/windows-startup/benchmark.ts `
  --output C:\atomic-perf\evidence\release-warm `
  --state-root C:\atomic-perf\state\release-warm `
  --lane release --profile warm --version 0.0.0 --repeats 30 `
  --baseline-bin C:\atomic-perf\artifacts\baseline\bin `
  --baseline-metadata C:\atomic-perf\metadata\baseline-release.json `
  --candidate-bin C:\atomic-perf\artifacts\candidate\bin `
  --candidate-metadata C:\atomic-perf\metadata\candidate-release.json `
  --cwd C:\atomic-perf\benchmark-cwd --port 43171 --seed 1096044365
```

Run the release `atomic-state-cold` profile with the same arguments except `--profile atomic-state-cold` and a separate output directory. Run the Node lane with `--lane node --profile warm` and each installed `node_modules\.bin` directory. For a baseline-only checkpoint, omit the candidate arguments. `--repeats 30` means 30 samples per build when both builds are supplied.

Warm runs reuse one initialized agent directory for that lane/build/profile while every process receives a fresh session directory. Use the same explicit `--state-root` for untimed priming and the measured batch so priming reaches the measured warm-agent trees without mixing its JSONL records into headline evidence. Atomic-state-cold runs copy the same seeded agent template for each sample while leaving the OS filesystem cache warm. Filesystem-cold startup is not implied by either profile.

The harness forces `CI=0` and animated startup, and removes `ATOMIC_STARTUP_BENCHMARK` and `ATOMIC_TIMING` from the child. This prevents an ambient controller environment from selecting the non-fullscreen fallback or a diagnostic path. The sanitized environment hash normalizes the required artifact and agent-directory differences so baseline and candidate hashes remain comparable.

The seeded AB/BA order and seed are saved in `order.json`. Runs are serial. A slow launch, timeout, crash, missing tool, malformed provider request, duplicate request, or failed workflow command is a retained `product-failure`, not an invalid sample. `invalid` is reserved for mechanical setup failures before product launch. The CLI exits nonzero after persisting all requested records if any sample is not successful.

## Evidence and summary

Each output directory contains:

```text
order.json
samples.jsonl
raw/<lane>/<build>/<profile>/<sample-id>/
  sample.json
  pty-output.txt
  pty-chunks.json
  screens.json
  provider-requests.json
```

Every sample stores wall-clock start time, monotonic marks, command, sanitized environment hash, artifact/runtime metadata, cursor coordinates, raw output/chunks, provider request body, validation results, workflow postcondition, state, and exact failure reasons.

Summarize a batch with:

```powershell
bun run scripts/perf/windows-startup/summarize.ts `
  C:\atomic-perf\evidence\release-warm\samples.jsonl `
  C:\atomic-perf\evidence\release-warm\summary.json
```

The summary reports successful sample count, product failures, invalid records, excluded sample IDs, median, nearest-rank p95, MAD, and raw values. `bootstrapMedianRatio()` provides deterministic 10,000-resample confidence intervals for baseline/candidate median ratios. Do not combine release and Node results or warm and atomic-state-cold results.
