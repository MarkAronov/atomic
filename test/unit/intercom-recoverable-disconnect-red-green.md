# Intercom recoverable-disconnect red/green evidence

Base under test: `origin/main` at `c20dbb41923b8c60bbcb706d12b88882fc130536`.

Observed during Goal run `16a9f7ed-e55a-44b4-b89f-3b63ef9197a2`: a transient Intercom
broker disconnect surfaced in the workflow-stage UI while the stage kept running and
lazy re-initialization kept recovering.

## The two boundaries that reached the UI

1. **Host extension-error boundary.** `packages/intercom/index.ts` eagerly awaited
   `loadHeavy(ctx)` inside its `session_start` handler for a stage carrying a
   `pendingStageDelivery`. The rejection escaped the handler, so the host's
   `runGenericHandlers` caught it and pushed it through `ExtensionRunner.emitError`
   to `showExtensionError` (interactive) and `console.error("Extension error …")`
   (print).
2. **Lazy event-relay boundary.** The `subagent:*` and pending-stage relays logged
   `Intercom event relay failed (<event>): Client disconnected` straight into the
   stage output for work the user never initiated.

`d3910c0818` silenced only Intercom's own `Intercom heavy initialization failed …`
log, which is neither channel, so the message kept reaching the UI.

## Negative control

The typed classification module (`packages/intercom/recoverable-disconnect.ts`) and
the broker client change were kept in place; only the two behavioral guards were
reverted to their `origin/main` form:

- `reportRelayFailure` restored to an unconditional `console.error`.
- The `session_start` warm-up restored to a bare `await loadHeavy(ctx);`.

```sh
npx vitest --run --project unit test/unit/intercom-recoverable-disconnect-ui.test.ts
```

### Red — guards reverted

```text
 Test Files  1 failed (1)
      Tests  5 failed | 5 passed (10)
```

The host boundary received exactly the record that `showExtensionError` renders:

```text
+   {
+     error: 'Client disconnected',
+     event: 'session_start',
+     extensionPath: '<intercom>',
+     stack: 'IntercomClientDisconnectedError: Client disconnected\n …'
+   }
```

and the relay boundary logged:

```text
+     'Intercom event relay failed (subagent:result-intercom):',
```

The five failures are the four suppression/recovery expectations plus the healthy
lifecycle check. The five that still passed are the actionability controls — a
non-recoverable import failure, a same-worded plain `Error`, a terminal relay
failure, a terminal pending-stage relay failure, and a user-initiated tool call —
confirming the red run fails only for the intended reason.

### Green — with the guards

```text
 Test Files  1 passed (1)
      Tests  10 passed (10)
```

Run three consecutive times together with `test/unit/intercom-heavy-init-diagnostics.test.ts`
(15 tests) with no flake.

Captured red output: `/tmp/red-before.txt`.

## Live-broker check

The unit tests stub heavy initialization, so the typed classification was also
checked against a real broker process in a tmux pane. A disposable
`ATOMIC_CODING_AGENT_DIR` gives the probe its own socket and its own broker, so
the machine's live broker is never touched:

```text
isolated agent dir: /var/folders/.../intercom-e2e-dAS0m6/agent
connected to isolated broker: true
connected after killing that broker: false
observed error class:                    IntercomClientDisconnectedError
observed error message:                  Client disconnected
instanceof IntercomClientDisconnectedError: true
isRecoverableIntercomDisconnect:         true
same error wrapped as a cause:           true
plain look-alike stays actionable:       true
```

The probe issues a `send`, kills the broker while that request is in flight, and
inspects the rejection. That in-flight window is the production shape: the client
fails pending requests from `onClose`. A *fresh* call made after the socket has
already closed observes `Not connected` instead, which is deliberately left
actionable.

## Review round 1 — the observed channel, and the missing retry owner

Review found that the two boundaries above are real but were **not** the channel
that leaked in run `16a9f7ed-e55a-44b4-b89f-3b63ef9197a2`. In that stage
transcript the only `Client disconnected` occurrences are `subagent` **tool
results** at steps 32/36/38/40 — the tool returned the bare string as its whole
result four times while the stage kept running. `grep -c "Extension error"` on
that transcript is 0.

The observed path is the advisory supervisor-authorization request:
`broker/client.ts` `failPending` rejects it, `packages/intercom/index.ts` set
`request.completion` with no classification and no catch,
`packages/subagents/src/intercom/supervisor-authorization.ts` rethrows every
non-stale error, and `subagent-executor-single.ts:192` awaits it inside the run
`try`. Review also found that swallowing the warm-up failure left no retry
owner, so a stage holding queued pending messages parks on
`pendingStageDelivery.ready()` — which `stage-runner-controller.ts:1218` awaits
with no timeout — with no signal at all.

Both are covered by tests driving the real production entry points:
`requestSupervisorAuthorization` itself, and a `pendingStageDelivery` modeled on
the real `ready`/`deliverPending` contract.

### Red — the two new guards reverted

Only `.catch` on the authorization completion and the `scheduleWarmUpRetry` call
were removed; everything else was left in place.

```sh
npx vitest --run --project unit test/unit/intercom-recoverable-disconnect-ui.test.ts
```

```text
 Test Files  1 failed (1)
      Tests  3 failed | 14 passed (17)
```

Each failure is the finding itself, not a proxy for it:

```text
× resolves undefined so a recoverable disconnect never becomes the subagent run result
  IntercomClientDisconnectedError: Client disconnected

× retries after a recoverable warm-up disconnect and unparks the stage
  Error: Test timed out in 30000ms.

× reports once when the bounded attempts run out
  Error: timed out waiting for the expected condition
```

The first is the exact rejection that became the subagent run result. The second
is the stage parked on `ready()` for the full 30 s budget with nothing to unpark
it. The third is the missing diagnostic: no report is ever emitted.

### Green — with the guards

```text
 Test Files  1 passed (1)
      Tests  17 passed (17)
```

Run three consecutive times with no flake. Captured red output:
`/tmp/red-round2.txt`.

## Review round 3 — the broker-side stale socket, and the raw transport error

Two findings, both reproduced on this branch's own code before anything was changed.

**Broker.** `~/.atomic/agent/intercom/broker.log` was sitting at exactly its 8 KiB
cap, 15 of its lines `ERR_STREAM_WRITE_AFTER_END` raised in `writeMessage` from
`IntercomBroker.broadcastToMemberships`. The broker removed a session only on the
socket `'close'` event, so a peer that half-closes — or one the broker itself ended
after refusing a registration — stayed in the routing table and every later
broadcast wrote into a socket whose writable side was gone. Node destroys the
socket synchronously for such a write, so one departure cascaded.

**Client.** `onSocketError` stored a raw post-registration transport error, and
`onClose` then rejected pending work and emitted `disconnected` with it. The
classifier recognizes only `IntercomClientDisconnectedError`, so an established
socket reset bypassed the bounded recovery a clean close already got.

### Red — the three fix files reverted, the new tests kept

`packages/intercom/broker/{broker,send-handler,client}.ts` stashed;
`socket-writes.ts` and the new suites left in place.

```sh
npx vitest --run --project unit \
  test/unit/intercom-broker-stale-session.test.ts \
  test/unit/intercom-broker-socket-writes.test.ts \
  test/unit/intercom-client-transport-disconnect.test.ts
```

```text
 Test Files  3 failed (3)
      Tests  6 failed | 7 passed (13)
```

Each failure is the finding, not a proxy for it:

```text
× fails truthfully, records nothing, and leaves the message id retryable
  AssertionError: expected [{ type: 'delivery_failed', reason: 'Session not found' }]
                  received [{ type: 'delivered' }]

× a broker-ended session is retired, and healthy peers keep working without write-after-end
  AssertionError: session_left arrived after the broadcast:
  ["registered","session_joined","session_joined","session_left"]

× a send to a broker-ended session fails truthfully and keeps the message id retryable
  Error: Timed out waiting for broker frame delivery_failed

× a real post-registration transport error becomes a recoverable disconnect that keeps its cause
  AssertionError: expected the typed error, got Error: write EPIPE

× an ECONNRESET on an established socket enters the recoverable path with its code intact
  AssertionError: ok(error instanceof IntercomClientDisconnectedError)

× a protocol error stays non-recoverable even when a socket error follows it
  AssertionError: /^Intercom protocol error: /u did not match 'read ECONNRESET'
```

The second failure is the sharp one: `session_left` for the refused peer arrived
*after* the `session_joined` broadcast, which is only possible because the
retirement was a side effect of the failing write destroying the socket rather
than a deliberate retirement at the refusal. The third shows the broker answering
`delivered` for a peer that received nothing. The last shows the clobber hazard was
real: a socket error arriving after `onReaderError` overwrote the protocol
diagnosis.

The broker's own log confirms the production stack, byte for byte, from a
throwaway probe against the reverted broker (`/tmp/red-broker-log.mjs`):

```text
ERR_STREAM_WRITE_AFTER_END occurrences: 2
Socket error: Error [ERR_STREAM_WRITE_AFTER_END]: write after end
    at writeMessage (packages/intercom/broker/framing.ts:12:10)
    at IntercomBroker.broadcastToMemberships (packages/intercom/broker/broker.ts:1324:35)
    at IntercomBroker.handleMessage (packages/intercom/broker/broker.ts:971:16)
zombie received the message frame: false
```

### Green — with the lifecycle retirement, the checked write, and the typed reset

```text
 Test Files  3 passed (3)
      Tests  13 passed (13)
```

and the pre-existing evidence is unchanged:

```sh
npx vitest --run --project unit test/unit/intercom-*.test.ts
 Test Files  52 passed (52)
      Tests  467 passed (467)
```

Captured red output: `/tmp/red-round3.txt`.

## Review round 4 — the exhausted warm-up: raw console text, and the stage that never unparks

Round 2 gave the warm-up a retry owner and made the terminal case *visible* with a
`console.error`. The user then hit that terminal case: `Intercom could not reconnect
for workflow stage "…" after 5 attempts` was rendered into the root session's main
chat area. Round 2's own disclosed limitation had come true, and it is two defects,
not one wording problem.

1. **The console channel.** `packages/coding-agent/src/core/output-guard.ts` leaves
   `console.error` writing raw bytes to the TTY the TUI paints, and a workflow stage
   runs inside the root session's process — so extension stderr lands in the user's
   transcript.
2. **The stage still never unparks.** `stage-runner-controller.ts` awaits
   `pendingStageDelivery.ready()` with no timeout, and
   `pending-stage-delivery.ts` only ever resolved that promise from a *successful*
   drain or rejected it from a *failed* drain. Warm-up exhaustion produced neither,
   so the report was emitted and the stage stayed `running` forever.

The repair is a typed terminal signal rather than a timeout: the wrapper hands the
delivery an `IntercomWarmUpExhaustedError` through the new optional `fail(reason)`
member of `WorkflowPendingStageDelivery`, and the workflows side settles `ready()`
exactly once with a stage-scoped `WorkflowPendingStageDeliveryFailedError`.

### Red — only the four production files reverted, the tests kept

`packages/intercom/index.ts`, `packages/workflows/src/runs/foreground/pending-stage-delivery.ts`,
`packages/workflows/src/runs/foreground/stage-runner-controller.ts`, and
`packages/coding-agent/src/core/extensions/context-types.ts` stashed; the new
`warm-up-exhaustion.ts` and the three suites left in place.

```sh
npx vitest --run --project unit \
  test/unit/intercom-recoverable-disconnect-ui.test.ts \
  test/unit/workflow-pending-stage-delivery-terminal.test.ts
```

```text
 Test Files  2 failed (2)
      Tests  6 failed | 19 passed (25)
```

Each failure is the defect itself:

```text
× hands the stage a terminal signal when the bounded attempts run out, with no console diagnostic
  Error: timed out waiting for the expected condition        (no fail() is ever called)

× stays silent when the stage delivery offers no terminal signal
  AssertionError: expected [] to deeply equal
  [[ 'Intercom could not reconnect for workflow stage "implementation" after 2 attempts; …' ]]

× rejects a ready() that was already awaited when the delivery owner gives up
  Error: Test timed out in 30000ms.                          (the parked stage, exactly)

× rejects a ready() requested after the failure was already latched
  Error: Test timed out in 30000ms.

× settles exactly once: the first reason wins and a duplicate fail() is a no-op
  Error: Test timed out in 30000ms.

× a late deliverPending() after the failure leaves the queued steering untouched
  AssertionError: a failed-closed stage never consumes the entries it was refused
```

The three 30 s timeouts are the production bug reproduced literally: `ready()` never
settles, so the test burns its whole budget the way the stage burned the run. The
second failure is the raw transcript text, captured verbatim.

At the integration boundary the same revert parks a real executor run:

```sh
npx vitest --run --project integration \
  test/integration/workflow-stage-pending-delivery-terminal-failure.test.ts
```

```text
 Test Files  1 failed (1)
      Tests  1 failed (1)
  Error: Test timed out in 30000ms.
```

### Green — with the typed terminal signal

```sh
npx vitest --run --project unit \
  test/unit/intercom-recoverable-disconnect-ui.test.ts \
  test/unit/workflow-pending-stage-delivery-terminal.test.ts \
  test/unit/intercom-heavy-init-diagnostics.test.ts
```

```text
 Test Files  3 passed (3)
      Tests  30 passed (30)
```

```sh
npx vitest --run --project integration \
  test/integration/workflow-stage-pending-delivery-terminal-failure.test.ts \
  test/integration/workflow-pending-stage-delivery.test.ts
```

```text
 Test Files  2 passed (2)
      Tests  12 passed (12)
```

The integration run that timed out at 30 s now completes in ~10 ms with the stage at
`status: "failed"`, `failureKind: "unknown"`, `failureDisposition: "terminal_failed"`,
a `stage.error` naming the stage, and the queued entry still `queued`.

Round 2's controls are unchanged and still green: late retry success unparks the
stage, shutdown cancels the retry silently, and a non-recoverable warm-up failure is
still reported to the host and not retried.

Also green with the fix (`--project unit`): `stage-runner.test.ts`,
`stage-runner-errors.test.ts`, `stage-runner-lazy-attach.test.ts`,
`stage-runner-thrown-retry.test.ts`, `stage-runner-session-shutdown.test.ts`,
`durable-resume-runtime.test.ts` (171 tests); `workflow-sticky-pending-stage-delivery.test.ts`,
`workflow-pending-stage-delivery-lifecycle.test.ts`,
`workflows-pending-stage-delivery-store.test.ts`,
`durable-nested-pending-stage-delivery.test.ts`; and (`--project integration`)
`intercom-reconnect-recovery.test.ts` (5 tests).

## Review round 5 — the terminal failure was still a retryable *model* failure

Round 4 made the stage fail deterministically at its own lifecycle boundary. Review
then found that the failure, on the shape production actually builds, was classified
as a retryable model failure — so the "deterministic non-retryable" claim was true
only for the bare `Error` the integration test happened to inject.

**The defect.** `WorkflowPendingStageDeliveryFailedError` passed `{ cause: reason }`
to `super(...)`. Production's reason is
`IntercomWarmUpExhaustedError` ← `IntercomClientDisconnectedError` ← the raw
`ECONNRESET` transport error, and `structuredSignal`'s cause walk latches the nested
`code: "ECONNRESET"`, which `kindFromCode` maps to `network_timeout` — a kind that is
both same-model retryable and fallback-eligible. The message's careful token
avoidance never ran, because a structured code outranks message text.

**Two barriers, each independently falsifiable:**

1. `reason` instead of `cause`. The delivery owner's failure is kept on a `reason`
   property, which the classifier does not inspect; the reason text is still in
   `message`.
2. A workflows-local type guard, `isWorkflowPendingStageDeliveryFailure`, consulted at
   both decision sites — the same-model retry at `createSessionWithThrownErrorRetry`
   and the fallback walk in `handleCandidateFailure`. This holds regardless of what
   the classifier concludes, which is the point: it is by type, not by wording.

**The test could not have caught it either.** The round-4 integration test injected a
bare `Error`, which already classifies `unknown`, and configured no model, no
fallbacks, and no retry settings — so neither decision site was reachable. It now
builds the real production chain, declares `model: "anthropic/primary"` with
`fallbackModels: ["openai/fallback"]`, and gives the mock session real retry settings.

### Red — cause restored, guard removed

```sh
npx vitest --run --project integration \
  test/integration/workflow-stage-pending-delivery-terminal-failure.test.ts
```

```text
 Test Files  1 failed (1)
      Tests  1 failed (1)

AssertionError: no same-model retry and no fallback candidate is spent
+ actual - expected
+   'anthropic/primary',
+   'anthropic/primary',
+   'openai/fallback',
+   'openai/fallback',
+   'openai/fallback'
```

Five session creations across two models for a stage that could never receive its
instructions — the finding reproduced literally, not by proxy.

### Red — cause restored, guard kept

```text
 Test Files  1 passed (1)
```

The integration test passes, which is the guard doing its job independently of the
classifier. The *classifier* barrier is what fails in that state, at its own
assertion:

```sh
npx vitest --run --project unit test/unit/workflow-pending-stage-delivery-terminal.test.ts
```

```text
 Tests  2 failed | 7 passed (9)

× rejects a ready() that was already awaited when the delivery owner gives up
  AssertionError: the reason is deliberately not chained as `cause`
× is refused by the shared model-failure classifier even on the production reason chain
  AssertionError: no same-model retry is spent
```

Each barrier therefore has its own red, and neither hides the other.

### Red — the required `fail` contract

`fail` was optional, and one unit case blessed a delivery that omitted it — a
permanently parked stage the contract explicitly permitted. `fail` is now required on
`WorkflowPendingStageDelivery`; the three structural test literals gained it, and the
blessing case was replaced by a hostile-implementer control. Removing the wrapper's
`try/catch` around the now-unconditional call:

```text
× contains a delivery whose fail() throws instead of letting it escape the process
  AssertionError: the contract violation stays inside the extension
 Tests  1 failed | 17 passed (18)
```

Worth recording: the first draft of that control watched only `uncaughtException` and
passed with the `try/catch` removed. The exhaustion branch runs from the retry
chain's promise rejection handler, so an escaping throw is an *unhandled rejection*.
The committed control watches both.

### Green — with both barriers and the required contract

```text
unit  (7 files: the two new suites + heavy-init diagnostics + the four
       pending-stage-delivery suites)                       95 passed
unit  (8 files: stage-runner{,-errors,-lazy-attach,-thrown-retry,
       -session-shutdown,-model-fallback-1,-model-fallback-2},
       durable-resume-runtime)                             187 passed
integration (terminal-failure + workflow-pending-stage-delivery
       + intercom-reconnect-recovery)                       17 passed
```

`npx tsc --noEmit -p tsconfig.json` and `packages/coding-agent` `tsgo -p
tsconfig.build.json --noEmit` both exit 0; Biome reports no findings on the eight
changed files.

### Deferred, recorded rather than silently covered

A *non-recoverable* failure partway through the retry chain
(`packages/intercom/index.ts`) still exits via `clearOwner(); return;` without calling
`fail`, and `loadHeavy`'s own handler still writes `Intercom heavy initialization
failed; a later call will retry: …` to the console. That is a different failure class
from the one the criteria name ("after five failed retries"), and it also touches the
separate `loadHeavy` console channel. No doc or changelog sentence claims that branch
is covered.

## Review round 6 — the fixture module graph, and one doc sentence that promised too much

Two findings, neither in production code.

**The lazy-tool fixture never learned about `warm-up-exhaustion.ts`.**
`runIntercomFixture` (`packages/coding-agent/test/suite/regressions/lazy-tool-fixtures.ts`)
materializes a throwaway extension directory from a hand-enumerated module list. Round 4
added `packages/intercom/warm-up-exhaustion.ts` and the wrapper imports it, but the list
was not updated, so every Intercom case in both `#1704` regression files died at import.

Red, from `packages/coding-agent`:

```sh
npx --no-install vitest --run test/suite/regressions/1704-lazy-tool-initialization.test.ts \
  -t 'replays a failed Intercom lifecycle before a retry executes'
```

```text
Error: error: Cannot find module './warm-up-exhaustion.js' from
  '…/.atomic-test-fixtures/intercom-lazy-hardening-tL5gQU/index.ts'
 Tests  1 failed | 13 skipped (14)
```

This is the exact failure mode of `dc34574522`, which did the same for
`./recoverable-disconnect.js` and `./reconnect-backoff.js` and took down `agent-suite
(linux-x64)` with 9 failures. So: a CI-blocking class, twice now.

Green — the copy, plus a guard so there is no third time:

```sh
npx --no-install vitest --run \
  test/suite/regressions/1704-lazy-tool-initialization.test.ts \
  test/suite/regressions/1704-lazy-tool-lifecycle-round2.test.ts
```

```text
 Test Files  2 passed (2)
      Tests  26 passed (26)
```

The guard scans the copied `index.ts` for relative specifiers and asserts each was
materialized. Verified to fire by deleting only the new copy:

```text
Error: lazy-tool Intercom fixture is missing packages/intercom/warm-up-exhaustion.ts
```

A named, self-explaining failure at fixture-build time instead of a Bun resolution error
surfacing through `parseFixtureResult` out of a spawned subprocess.

**`workflow-stage-discovery.md` promised queue survival it cannot deliver.** The
round-4 sentence said a failed stage's queued entries "stay queued for a later run".
`failed` is in `TERMINAL_STATUSES` (`packages/workflows/src/shared/store-internal.ts`),
and `registerPendingStageIntercomBridge` chains
`settleUndeliverablePendingStageMessages` on every store invalidation, so once the run
ends `failed`, `pendingStageUndeliverableReason` returns `Workflow run <id> terminated
with status failed before stage <key> started` and the entry is marked `undeliverable`
with the sender notified. A later run has a new run id and could not consume the entry
anyway — the sentence was wrong twice over. Rewritten to state what actually holds: the
entries are not recorded as delivered, they stay queued while the run is live, and they
follow the normal undeliverable settlement once the run terminates.

The four sibling sentences in `packages/coding-agent/docs/intercom.md`,
`packages/intercom/README.md`, and the two changelogs are scoped to the delivery
boundary ("not marked delivered to a stage that will not read it") and are accurate as
written; they were deliberately left alone.

No production file changed this round, so every round-5 assertion still stands
unmodified. Re-run as a no-regression pass: root unit `27 passed`, root integration
`12 passed`, `npx tsc --noEmit -p tsconfig.json` exit 0.
