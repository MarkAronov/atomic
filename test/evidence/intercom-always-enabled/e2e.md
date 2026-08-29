# Mandatory Intercom tmux E2E

- Branch: `feat/intercom-always-enabled`
- Base: `8789f2088892c8c7847298be8a5267b103a96ff6` (`origin/main` at branch creation)
- Implementation commit used for the build: `acda760220`
- Built CLI: `packages/coding-agent/dist/cli.js`
- Runtime: Node with real configured `openai-codex/gpt-5.6-sol` credentials copied only into isolated `/tmp/atomic-intercom-e2e`; no credential contents are recorded here.
- Isolated agent directory: `/tmp/atomic-intercom-e2e`
- Intercom config used in every invocation: `{"enabled":false,"confirmSend":false}`. The removed `enabled` key is intentionally ignored.
- tmux session: `atomic-intercom-e2e`; captures below were produced by `tmux capture-pane -p -S - -J` and are genuine pane text.

## Build

```sh
npm run build
npm --workspace=@bastani/atomic run build
```

## Restrictive main-chat invocations

The CLI accepts these as separate valid invocations. It was not necessary to claim that every flag can be combined in one invocation.

```sh
ATOMIC_CODING_AGENT_DIR=/tmp/atomic-intercom-e2e node packages/coding-agent/dist/cli.js \
  --provider openai-codex --model gpt-5.6-sol --print --no-session \
  --no-tools --no-extensions \
  "Call the ordinary intercom tool with action status. Do not use any other tool. Then respond with exactly MAIN_NO_TOOLS_OK and include the group reported by the tool."
```

Observed pane result: `MAIN_NO_TOOLS_OK default`.

```sh
ATOMIC_CODING_AGENT_DIR=/tmp/atomic-intercom-e2e node packages/coding-agent/dist/cli.js \
  --provider openai-codex --model gpt-5.6-sol --print --no-session \
  --tools read --exclude-tools intercom,bash --no-extensions \
  "Call the ordinary intercom tool with action status. Do not use read. Then respond with exactly MAIN_ALLOWLIST_OK and include the group reported by the tool."
```

Observed pane result: `MAIN_ALLOWLIST_OK default`. Thus an allowlist omitting Intercom, an explicit Intercom exclusion, optional-extension suppression, and `enabled:false` did not prevent the real model from calling `intercom status`.

## Restrictive workflow-stage invocation

The fixture is saved as `intercom-restrictive-e2e.ts`. Its only stage combines `noTools: "all"`, `tools: ["read"]`, and exclusions containing `intercom`, `bash`, `workflow`, and `subagent`.

```sh
ATOMIC_CODING_AGENT_DIR=/tmp/atomic-intercom-e2e node packages/coding-agent/dist/cli.js \
  --provider openai-codex --model gpt-5.6-sol --print --no-session \
  "/workflow intercom-restrictive-e2e"
```

Observed pane result: the workflow completed and returned `WORKFLOW_INTERCOM_OK workflow:3fa43491-5c0a-4b2e-b1a2-addf110ad171`. This proves the real restricted stage called `intercom status` inside its non-default workflow invocation group. The pane also logged a post-result `Client disconnected` lazy-initialization retry notice during process teardown; it did not prevent the successful status result or workflow completion.

## Captures

- `tmux-main-no-tools.txt`
- `tmux-main-allowlist.txt`
- `tmux-workflow-stage.txt`

The captures contain commands, ordinary model markers, group names, and workflow IDs only. Credentials, tokens, socket secrets, home configuration, and unrelated content are excluded.
