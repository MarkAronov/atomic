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
