# Workflow-stage discovery

Join a workflow invocation group (`workflow:<rootRunId>`) and call `intercom({ action: "list" })`. In addition to ordinary connected sessions, the result includes workflow stages already materialized in the workflow store:

- **PENDING** — the stage session has not initialized. Send to the listed canonical `<runId>:<stageId>` target to queue a durable FIFO message for delivery before the first model turn.
- **RUNNING** — the stage is connected to Intercom. The same canonical target delivers immediately.

Roster visibility and delivery remain group-scoped. The SDK `sessionId` shown by `workflow status` is not an Intercom session ID and must not be used as a target. Dynamic TypeScript stage calls that have not executed have not allocated a store record, so they cannot appear in the roster yet.

Pending delivery retains its existing per-stage 50-message cap, deduplication, and refusal behavior.
