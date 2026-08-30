# Native builtin routing validation

## Environment

- Bun: `1.4.0`
- OS/architecture: `Darwin arm64` (`uname -sm` => `Darwin arm64`)
- Repository branch: `perf/native-builtin-loader`
- Implementation commits under test:
  - `1e93c4a0d025566cc81a5689445e47fa84ac39fa` — `feat(extensions): native-load installed builtins`
  - `c74aa5f5c0fabc943b7857bf8cf0954245d8f8c8` — `test(extensions): cover native builtin routing`
  - `6d49ed2f66a70422ee9c2d5d0cf7ccc63bcc1914` — `docs(extensions): document native builtin reloads`
- Additional validation commits:
  - `ab4aa85f7989c3374f9e7adb9684e23be469b3a4` — `test(extensions): verify Node skips native builtin cache`
  - `docs(evidence): record native builtin routing validation` — the signed commit containing this document; its hash is reported by `git log` after creation because a commit cannot embed its own hash.

## Result table

| Area | Result | Evidence |
|---|---|---|
| Trusted entry classification | **PASS** | The original focused run passed 4 files and 26 tests. After adding the Node cache guard regression, the same command passed 4 files and 27 tests. The tests cover exactly five identity-verified installed entries and reject arbitrary, sibling, manifest-only, source, and spoofed-package paths. |
| Editable reload behavior | **PASS** | Focused graph-manifest tests observed both direct entry edits and transitive dependency edits. Editable TypeScript extensions remain on the jiti/content-hash path. |
| Compiled production route | **PASS** | The CI boundary test passed after building a real external extension bundle, a bundled app sidecar, and a `--compile --bytecode` launcher, then executing that launcher. It checked exact live host export identity, bidirectional shared-object mutation, factory reuse across `clearExtensionCache()`, absence of a jiti source read, and absence of a jiti cache directory. |
| Node/npm route | **PASS** | Under Node, the new focused test loads an identity-verified installed entry through the real loader and proves that the persistent native-builtin factory cache remains unpopulated. The full coding-agent, root unit, and root integration suites also passed under Node. |
| Static checks | **PASS** | `npm run check` passed Biome, root `tsc --noEmit`, coding-agent tsgo build and typetests, and shrinkwrap verification. |

## Commands and observed results

### Focused loader tests

```sh
npx vitest --run --root packages/coding-agent \
  test/native-builtin-entries.test.ts \
  test/extensions-graph-manifest-reuse.test.ts \
  test/extensions-loader-virtual-modules.test.ts \
  test/extensions-host-module-bridge.test.ts
```

Before the Node cache guard regression was added, the result was 4 files passed and 26 tests passed. With the new regression, the result was 4 files passed and 27 tests passed.

The new test alone also passed:

```text
Test Files  1 passed (1)
     Tests  4 passed (4)
```

### Compiled boundary

```sh
npm run test:ci-contracts -- test/ci/extension-host-module-bridge-boundary.test.ts
```

Observed result: 1 file passed and 1 test passed. Verbose output showed three real Bun builds:

1. An ESM extension bundle with its host imports externalized.
2. The CJS application sidecar containing the production loader.
3. A `--compile --bytecode` launcher.

The test then executed the compiled launcher, which printed:

```text
compiled native-builtin production loader probe: OK
```

### Repository checks and suites

```sh
npm run check
npm run test --workspace=@bastani/atomic
npm run test:unit
npm run test:integration
```

Observed results:

- `npm run check`: passed, including Biome, `tsc --noEmit`, coding-agent tsgo build and typetests, and shrinkwrap verification.
- Coding-agent suite: 499 files passed, 4 files skipped; 4113 tests passed, 40 tests skipped.
- Root unit suite: 723 files passed; 7265 tests passed, 23 tests skipped.
- Root integration suite: 40 files passed; 506 tests passed.

An initial root-unit invocation reported 4 failed tests because `packages/coding-agent/dist/builtin` did not exist: the coding-agent workspace build had not yet run. After:

```sh
npm --workspace=@bastani/atomic run build
```

the affected focused tests passed (2 files, 47 tests), and the subsequent full unit run passed with the totals above. This was missing setup, not a loader regression.

## Negative controls

### Compiled builtin bypass

The native branch was temporarily gated with `false &&`, then the compiled-boundary test was run. It failed with:

```text
AssertionError: jiti read builtin source
```

The source was restored before the passing run. This proves that the compiled test's jiti-bypass assertion is load-bearing rather than vacuous.

### Node single-file guard

The `isSingleFileBuild && ` term was temporarily removed from the production guard, leaving:

```ts
if (isNativeBuiltinExtensionPath(extensionPath)) {
```

Running the new focused test produced this exact failure output:

```text
 RUN  v4.1.10 /Users/tonystark/Documents/projects/atomic-native-builtin-loader/packages/coding-agent

 ❯ |agent| test/native-builtin-entries.test.ts (4 tests | 1 failed) 19ms
   × does not retain installed builtin factories in the native cache under Node 7ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |agent| test/native-builtin-entries.test.ts > does not retain installed builtin factories in the native cache under Node
AssertionError: Expected values to be strictly equal:

true !== false


- Expected
+ Received

- false
+ true

 ❯ test/native-builtin-entries.test.ts:96:9
     94|  // Under Node both .mjs routes converge behaviorally, so cache popula…
     95|  // the faithful observable that the single-file-build guard remained …
     96|  assert.equal(extensionLoaderTestHooks.hasNativeBuiltinFactory(entry),…
       |         ^
     97| });
     98|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 3 passed (4)
```

The original guard was then restored. The same command passed 1 file and all 4 tests. This proves that the cache-population assertion detects removal of the Node/single-file boundary.

## Pre-existing behavior, not a regression

A separate diagnostic used an untrusted plain `.mjs` file in a temporary directory. `isNativeBuiltinExtensionPath()` returned `false`, so none of this slice's native-builtin routing could execute. The first load returned `"first"`; after rewriting the file and calling `clearExtensionCache()`, the second load still returned `"first"`. A `.ts` file in the same diagnostic returned `"first"` before its edit and `"edited"` afterward.

That `.mjs` behavior comes from jiti's native-import route plus Node's ESM cache and predates this slice. It is not evidence that the persistent native-builtin cache leaked into Node. In this slice, the new production branch is guarded by `isSingleFileBuild &&`; with both `isBunBinary` and `isBundledBuild` false, the branch is inert and the remaining Node control flow is unchanged from the base commit.

Installed `.bundle.mjs` files in an npm installation are shipped artifacts, not editable user source. Editable user, project, and package extensions and user workflows retain the jiti/content-hash behavior, including re-evaluation after direct or transitive TypeScript source edits.

## What this does not prove

- The local compiled-boundary evidence covers only Darwin arm64 with Bun 1.4.0. Windows and Linux compiled behavior is covered by CI, not by a local run recorded here.
- There is no robust behavioral discriminator between the two `.mjs` routes under vitest: its module runner resolves bare specifiers for either route, while Node's ESM cache makes edit/reload behavior converge. The Node boundary is therefore evidenced structurally by the inert production guard, the falsifiable persistent-cache-population invariant, and the green Node test suites.
- Exact exported-object identity and mutation were tested. This does not claim that reassigning a host ESM binding after bridge registration becomes a live binding in the external bundle.
- The validation proves routing and reload semantics; it does not claim a cross-platform startup-time measurement or quantify a production speedup.

## Verdict

The tested implementation native-imports only exact installed entries of identity-verified Atomic builtin packages in Bun compiled or bundled single-file builds. Those fixed factories survive reload without jiti source reads, transforms, hashing, or graph-manifest work. The Node guard is load-bearing, source-checkout entries remain untrusted, and editable TypeScript extension graphs continue to re-evaluate after direct and transitive edits.
