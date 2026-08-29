# Intercom always-enabled implementation notes

## Goal

Keep the ordinary `intercom` tool loaded, registered, active, and usable in the main chat and every workflow model stage through every existing restriction, mutation, and reload path. Preserve every restriction on other tools, `contact_supervisor` policy, lazy broker initialization, and workflow invocation-group isolation and delivery.

## Interface and state decisions

- The public tool identity remains exactly `intercom`. The `contact_supervisor` identity and subagent-only admission policy remain unchanged.
- Existing required and optional fields keep their current definitions. The change adds no new public fields or validation.
- Where the contract leaves behavior open, preserve input ordering, duplicates, and raw text. Do not normalize or reject additional input beyond preserving the mandatory Intercom invariant.
- The Intercom state invariant is `loaded -> registered -> active -> usable`. Initial selection and extension restrictions must preserve the full state. Runtime mutation and reload must restore or preserve it. Illegal or unexpected restriction inputs retain existing behavior for every other tool.

## Acceptance matrix

| ID | Requirement or invariant | Current-checkout evidence |
| --- | --- | --- |
| A1 | Work only in the designated checkout on `feat/intercom-always-enabled`, based on `origin/main`. | `pwd`; `git branch --show-current`; `git merge-base --is-ancestor origin/main HEAD`; base recorded in the E2E evidence. |
| A2a | `intercom.enabled: false` cannot disable ordinary Intercom. | Focused bundled-extension loader/config regression test plus restrictive main-chat tmux E2E. |
| A2b | CLI/session `--tools`, `--exclude-tools`, and `--no-tools` cannot remove Intercom. | Focused CLI/session construction tests and separate technically valid main-chat tmux invocations. |
| A2c | `--no-extensions` and explicit extension allowlists cannot unload bundled Intercom. | Focused bundled-extension loading tests and restrictive main-chat tmux E2E. |
| A2d | Persisted/default tool settings cannot remove Intercom. | Focused session construction/reload tests using settings-backed defaults. |
| A2e | SDK `tools`, `excludedTools`, and `noTools` cannot remove Intercom. | Focused SDK construction tests. |
| A2f | Runtime `setActiveTools` cannot deactivate Intercom. | Focused runtime mutation test. |
| A2g | Workflow stage `tools`, `excludedTools`, and `noTools` cannot remove Intercom. | Focused workflow option-normalization/model-stage test plus restrictive real-workflow tmux E2E. |
| A2h | Reload and equivalent existing selection/filter paths preserve Intercom. | Focused reload and tool-selection regression tests. |
| A3 | No restriction on any other tool is weakened. | Every focused restriction test asserts the requested restriction still applies to a non-Intercom tool; broader unit/integration suites. |
| A4 | `contact_supervisor` stays subagent-only. | Existing admission-policy tests plus focused negative assertions in prompt/tool metadata coverage. |
| A5 | Broker/heavy initialization remains lazy. | Existing Intercom lazy-loading tests and source assertion that mandatory extension registration does not start/connect the broker. |
| A6 | Workflow invocation-group isolation and delivery semantics remain unchanged. | Focused workflow group-assignment tests and existing Intercom/workflow group suites; real stage `intercom status` output identifies its workflow invocation group. |
| A7a | Behavior-first tests cover main-session and SDK construction, mutation, and reload. | Focused coding-agent tests; each former failing path is documented in the final evidence. |
| A7b | Behavior-first tests cover bundled-extension loading restrictions. | Focused bundled-extension loader tests. |
| A7c | Behavior-first tests cover workflow option normalization and group assignment. | Focused workflow unit tests. |
| A7d | Behavior-first tests cover affected prompt/tool metadata. | Focused prompt/tool metadata tests. |
| A8 | Relevant coding-agent docs and Intercom/workflow README/docs describe mandatory availability, with advertised disable mechanisms removed or revised; relevant linked docs are read completely. | Documentation diff plus repository-wide searches for stale disable claims; reading log below. |
| A9 | Each affected package changelog is updated only under its existing Unreleased section. | `git diff origin/main -- packages/*/CHANGELOG.md` and Unreleased-section inspection. |
| A10 | Narrow tests, then `npm run check`, then relevant broader unit/integration suites pass with no skips or bypasses. | Exact commands and exit outcomes recorded below and in the final evidence. |
| A11a | Freshly built Atomic CLI runs real credentialed main-chat E2E in tmux with isolated `ATOMIC_CODING_AGENT_DIR` and technically representable restrictive inputs. | Safe pane captures and exact commands in `test/evidence/intercom-always-enabled/`. |
| A11b | A real workflow stage with strongest restrictions calls `intercom status` in its invocation group. | Safe workflow fixture, pane capture, and status result in the stable E2E evidence. |
| A12 | Stable evidence contains safe exact commands, genuine tmux pane text, built CLI path, branch, implementation commit SHA, observed results, and a PR-comment-ready artifact. | Artifact inspection under `test/evidence/intercom-always-enabled/`; secret scan before commit. |
| A13 | Signed conventional commits include `Assistant-model: GPT-5.6 Sol`; hooks stay enabled; `0.0.0` manifests remain unchanged; final tree is clean. | `git log --show-signature`; commit message inspection; `git diff origin/main -- '*package.json' package-lock.json Cargo.toml Cargo.lock`; `git status --porcelain`. |
| A14 | This stage performs no push, PR creation, or PR comment. | Local repository state and handoff; no external write command is run. |

## Documentation reading log

- Read in full: `AGENTS.md`, `packages/coding-agent/docs/intercom.md`, `packages/coding-agent/docs/workflows.md`, `packages/coding-agent/docs/extensions.md`, `packages/coding-agent/docs/sdk.md`, `packages/coding-agent/docs/usage.md`, `packages/intercom/README.md`, `packages/intercom/skills/intercom/SKILL.md`, `packages/workflows/README.md`, and the relevant linked workflow authoring sections used by the implementation and E2E fixture.
- Inspected relevant current source, tests, build/package manifests, and recent repository history for bundled extension loading, session construction/mutation/reload, workflow stage option/group assignment, Intercom config/lifecycle, and signed commit conventions.

## Validation log

- Setup: `npm ci --ignore-scripts` and `npm run hooks:install` completed successfully before source edits.
- Focused coding-agent regressions: `npx vitest --run test/mandatory-intercom-extension.test.ts test/suite/regressions/sdk-tool-exclusions.test.ts` passed (13 tests).
- Focused root behavior: Intercom config/laziness, workflow group assignment, invocation groups, bundled stage resources, and default-tools tests passed (50 tests).
- `npm run check` passed, including Biome, both TypeScript checks, and shrinkwrap verification.
- `npm run build` and `npm --workspace=@bastani/atomic run build` passed; the latter emitted the changed CLI and bundled Intercom at `packages/coding-agent/dist/`.
- `npm run test:integration` passed (40 files, 506 tests) after updating the pending-stage delivery expectation for mandatory Intercom.
- Follow-up `npm run test:unit` passed with exit 0 on the current built checkout: 716 files passed, 7,216 tests passed, and 23 existing tests were skipped (7,239 total); duration 165.59 s. The four real-engine areas and the affected workflow-stage resource suite pass without skips, retries, serialization, timeout inflation, or bypasses.
- Real credentialed tmux E2E passed for two restrictive main-chat invocations and one restrictive workflow stage; exact commands and genuine pane captures are in this directory. The workflow stage returned its non-default `workflow:<runId>` group.
- Signed implementation commit: `acda760220`; a final signed evidence commit follows.
