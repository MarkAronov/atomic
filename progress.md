# Progress

## Status
Complete

## Tasks
- [x] Read repository instructions and inspect diagnosed paths
- [x] Add #2784 regression tests and record red evidence
- [x] Implement goal reviewer grouping and workflow-stage roster
- [x] Update docs and changelogs
- [x] Run required validation
- [x] Commit changes and write implementation report

## Files Changed
- packages/workflows/builtin/goal-runner.ts — Goal reviewers inherit the invocation group.
- packages/workflows/src/extension/pending-stage-intercom.ts — owner announcements publish materialized stage snapshots.
- packages/intercom/types.ts — discriminated workflow-stage roster protocol types.
- packages/intercom/broker/{broker,client}.ts — group-owned roster registration, filtering, lifecycle reconciliation, and directory client API.
- packages/intercom/index-heavy.ts — forwards roster snapshots with pending-route registration.
- packages/intercom/{intercom-tool,overlay}.ts and ui/session-list.ts — list and overlay render pending/running stages with canonical targets.
- Intercom/workflow docs, skills, and changelogs — discovery and targeting guidance.
- Four unit test files — #2784 regressions for Goal grouping, publication, broker lifecycle/scoping, and overlay labels.

## Notes
- RED: targeted run failed both new assertions: Goal supplied `goal-reviewers-turn-1`; route payload had no `stages`.
- GREEN: targeted regression run passed 29/29; expanded touched-suite run passed 70/70; full unit passed 7,263 with 23 skipped; full integration passed 506/506.
- `npm run check` passed. Biome emitted one pre-existing informational `noUselessStringRaw` diagnostic in `test/ci/ci-workflow-contracts.test.ts:891`.
