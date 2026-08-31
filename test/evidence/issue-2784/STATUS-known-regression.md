# Issue #2784 — known live regression at branch HEAD (READ THIS FIRST)

**Status: the workflow-stage roster does NOT work in a real CLI run at this branch head.**
The passing transcript in `e2e-tmux.txt` was captured at commit `81c738e970` (with a rendering
addendum at `9ae154f798`) and is **superseded**. Do not read it as the current state.

## What was observed live, twice, at HEAD

Driven against the real development CLI in tmux from this worktree
(`node packages/coding-agent/dist/cli.js`), with the fixture
`test/evidence/issue-2784/issue-2784-e2e.ts` copied into `.atomic/workflows/` for discovery.

Run 1 — root run `91593bee-6511-47f9-b916-529a6c836285`
(running-isolated `f7cc708d-aa0b-4bc9-b4b9-a4492b690f90`,
future-isolated `80e58489-821e-4b15-bd99-2c0647f9c23c`):

```text
 intercom status
 ✓ Groups: default, workflow:91593bee-6511-47f9-b916-529a6c836285

 intercom list
 ✓ Current session (groups: default, workflow:91593bee-6511-47f9-b916-529a6c836285):
 • subagent-chat-01a05993-... (1b55103f-...) — ... [self, tool:intercom]
 Other visible sessions and workflow stages:
 • Unnamed session (03c98931-...) — ... [same cwd, tool:workflow, group:
 workflow:91593bee-6511-47f9-b916-529a6c836285]

 intercom send 91593bee-...:f7cc708d-aa0b-4bc9-b4b9-a4492b690f90
 ✗ Message to "91593bee-...:f7cc708d-..." was not delivered: Session not found (606d73aa-...)

 intercom send 91593bee-...:80e58489-821e-4b15-bd99-2c0647f9c23c
 ✓ Message queued for 91593bee-...:80e58489-... (e90c49c0-...)
```

Run 2, on a freshly reset broker — root run `d8446321-9f43-4f84-8dfb-5302f050d2be` — reproduced
the same empty roster: `intercom list` returned only ordinary sessions, with no `[RUNNING]` and no
`[PENDING]` workflow-stage rows.

Both runs also logged, at CLI startup:
`Intercom heavy initialization failed; a later call will retry: Client disconnected`
(`packages/intercom/broker/client.ts:243`).

## Symptoms

1. `intercom list` shows **no workflow-stage rows at all** — neither RUNNING nor PENDING.
2. A send to a live stage by its canonical `<runId>:<stageId>` target fails with
   **`Session not found`** — the original #2784 symptom.
3. Pending queueing still works: the send to the not-yet-started stage returned
   `✓ Message queued`.

Symptom 3 is the diagnostic clue: `pendingStageRoutes` is registered while `workflowRosters` is
not, even though both are written by the same `register_pending_stage_route` handler.

## Leading hypothesis (NOT yet proven)

`packages/intercom/broker/broker.ts:844-849`:

```ts
if (activeExisting !== undefined && activeExisting.sessionId !== currentId) {
  // A stage replays the process-shared owner announcement before
  // registering its live aliases. Authenticate it without replacing
  // the workflow owner that handles pending delivery.
  break;
}
```

This `break` returns before the roster is stored. The owner announcement is published twice: an
initial one without `stages`, then a refresh carrying the materialized stages (added in
`81c738e970` to fix an initial-empty-roster race). If the refresh arrives on a different session
id than the one that registered the route, this guard skips it, so `pendingStageRoutes` stays
registered from the first call while `workflowRosters` is never populated — exactly the observed
split.

`test/integration/workflow-pending-stage-delivery.test.ts` does not cover this: it drives a single
owner session, so the two-session replay path is never exercised. That is why the in-process
integration suite passes (506/506) while the live CLI fails.

## Ruled out this session

- **Not** caused by the orderly-rejection change in `6e92d0a766`. That edit only alters the
  failure path; the success path is semantically identical, `broker.log` is empty, and no
  `registration_failed` frame was observed.
- **Not** a roster-validation refusal: `invocationOwnsGroup` (`broker.ts:133-137`) accepts both an
  exact group match and a `<owner>/...` subgroup, and `pending-stage-intercom.ts:104` already
  normalizes `lifecycle` to `pending`/`running`, so a legitimate announcement passes
  `isWorkflowStageRosterAnnouncements`.

## Required next action

Prove or disprove the hypothesis above, fix the roster registration path, add integration
coverage that exercises the two-session owner-announcement replay, then re-run this live tmux
scenario and replace `e2e-tmux.txt` with a transcript bound to the fixed commit. The GitHub issue
comment must not be updated with a passing claim until that transcript exists.

## Reproduction

```sh
cp test/evidence/issue-2784/issue-2784-e2e.ts .atomic/workflows/
cd packages/coding-agent && npm run build && cd ../..
tmux new-session -d -s i2784 -x 200 -y 60 \
  'cd "$PWD" && node packages/coding-agent/dist/cli.js'
# start the issue-2784-e2e workflow, join workflow:<rootRunId>, then run intercom list
rm .atomic/workflows/issue-2784-e2e.ts   # do not leave the fixture in workflow discovery
```
