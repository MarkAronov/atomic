# Workflow-stage discovery

Join a workflow invocation group (`workflow:<rootRunId>`) and call `intercom({ action: "list" })`. In addition to ordinary connected sessions, the result includes workflow stages already materialized in the workflow store:

- **PENDING** — the stage session has not initialized. Send to the listed canonical `<runId>:<stageId>` target to queue a durable FIFO message for delivery before the first model turn.
- **RUNNING** — the stage is connected to Intercom. The same canonical target delivers immediately.

Roster visibility and delivery follow an asymmetric invocation-control invariant. A session in `workflow:<rootRunId>` can list and exactly target stages in owned `workflow:<rootRunId>/...` subgroups; subgroup members retain only their own subgroup visibility and cannot reach siblings, other root runs, or unrelated sessions. Each row reports the stage's actual subgroup. Explicit `group: "default"` is not owned. The SDK `sessionId` shown by `workflow status` is not an Intercom target.

Pending delivery retains its 50-message cap and accepts queued `send` only; pre-start `ask` remains unsupported. A live stage accepts immediate `send` and `ask`, and its exact correlated reply crosses back only to the invocation asker.
