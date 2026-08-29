## Mandatory Intercom verification

Implemented ordinary `intercom` as a mandatory Atomic runtime tool while leaving every other tool restriction unchanged. `contact_supervisor` remains subagent-only, and broker/heavy initialization remains lazy.

Validation:
- `npm run check` passed.
- Focused SDK/resource-loader/workflow/Intercom tests passed.
- Fresh built CLI, real credentialed tmux E2E, isolated agent dir with `intercom/config.json` containing `enabled:false`:
  - `--no-tools --no-extensions` → `MAIN_NO_TOOLS_OK default`
  - `--tools read --exclude-tools intercom,bash --no-extensions` → `MAIN_ALLOWLIST_OK default`
  - Workflow stage with `noTools:"all"`, `tools:["read"]`, and `excludedTools` containing `intercom` → `WORKFLOW_INTERCOM_OK workflow:<runId>`

Exact commands and genuine pane captures: `test/evidence/intercom-always-enabled/`.
