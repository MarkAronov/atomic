# Slice 3 terminal cleanup and restart recovery — real CLI evidence

This is a fresh rerun after the Slice 3 repair for issue #1975. It used one real
interactive Atomic CLI, this checkout's source entrypoint, a live configured
provider, and tmux. The run emitted heartbeats at the one- and two-minute
boundaries, completed on its own at 2m10s, then emitted no heartbeat during a
3m23s post-terminal wait. The restarted CLI also replayed no stale heartbeat,
and its pane stayed unchanged for another 3m18s.

## Environment

| Field | Value |
| --- | --- |
| Worktree | `/Users/tonystark/Documents/projects/atomic-hb-slice3` |
| Branch | `feat/workflow-heartbeat-cleanup` |
| tmux session | `hb-slice3-repair-rerun2` (created at 200×90, then killed) |
| CLI under test | `bun packages/coding-agent/src/cli.ts` from this checkout |
| Provider shown by CLI | `(anthropic) claude-opus-5 high` with configured credentials |
| Session store | `/tmp/hb3-repair-rerun2-sessions` (scratch; removed after the run) |
| Workflow | `hb-slice3-throwaway` |
| Run id | `67b756e9-3da6-4544-aaf6-aad58246d97f` |
| Date/time zone | 2026-08-14, UTC |

The provider returned visible 429 retry notices during some parent turns. Those
notices did not change workflow state or card delivery. The CLI rendered both
live heartbeat cards, the terminal card, and the retained completed run.

## Throwaway workflow

The run used `.atomic/workflows/hb-slice3-throwaway.ts`. It was deleted after
the captures and is not committed. Its full definition was:

```ts
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

const PARK_MS = 130_000;

export default workflow({
	name: "hb-slice3-throwaway",
	description: "Parks past two heartbeat boundaries, then completes on its own.",
	heartbeatIntervalMinutes: 1,
	inputs: {},
	outputs: { parked: Type.String() },
	run: async (ctx) => {
		const parked = await ctx.tool("park-tool", {}, async (toolContext) => {
			const signal: AbortSignal | undefined = toolContext?.signal;
			return await new Promise<string>((resolve) => {
				const timer = setTimeout(() => resolve("parked-until-timeout"), PARK_MS);
				if (signal === undefined) return;
				const cancel = (): void => {
					clearTimeout(timer);
					resolve("parked-until-abort");
				};
				if (signal.aborted) {
					cancel();
					return;
				}
				signal.addEventListener("abort", cancel, { once: true });
			});
		});
		return { parked };
	},
});
```

`PARK_MS = 130_000` crosses the 1m and 2m cadence boundaries, then
finishes before 3m. The workflow has one durable tool and no model stage. No
input was sent between launch and the terminal transition.

## Exact commands

The workflow file above was written under `.atomic/workflows/`. The live session
and captures were then driven from the worktree with these commands:

```sh
cd /Users/tonystark/Documents/projects/atomic-hb-slice3
rm -rf research/evidence/workflow-heartbeat-cleanup /tmp/hb3-repair-rerun2-sessions
mkdir -p research/evidence/workflow-heartbeat-cleanup /tmp/hb3-repair-rerun2-sessions

SESSION=hb-slice3-repair-rerun2
EVIDENCE=research/evidence/workflow-heartbeat-cleanup

tmux new-session -d -s "$SESSION" -x 200 -y 90 -c "$PWD"
tmux set-option -t "$SESSION" history-limit 100000
tmux set-option -t "$SESSION" remain-on-exit on

tmux send-keys -t "$SESSION":0.0 -l -- \
  "bun packages/coding-agent/src/cli.ts --approve --offline --session-dir /tmp/hb3-repair-rerun2-sessions"
tmux send-keys -t "$SESSION":0.0 Enter

tmux capture-pane -p -J -S -1000 -t "$SESSION":0.0 > \
  "$EVIDENCE/tmux-01-cli-started.txt"

tmux send-keys -t "$SESSION":0.0 -l -- "/workflow hb-slice3-throwaway"
tmux send-keys -t "$SESSION":0.0 Enter
```

The pane was polled with `tmux capture-pane -p -J -S -1000` for `started in
background`, `WORKFLOW HEARTBEAT` with `elapsed 1m`, `WORKFLOW HEARTBEAT` with
`elapsed 2m`, and `WORKFLOW COMPLETE`. At each match the same capture command
saved files 02 through 05. Nothing was typed while those transitions occurred.

```sh
# After WORKFLOW COMPLETE:
sleep 195
tmux capture-pane -p -J -S -1000 -t "$SESSION":0.0 > \
  "$EVIDENCE/tmux-06-quiet-3min-after-terminal.txt"

# Restart onto the same persisted Atomic session:
tmux send-keys -t "$SESSION":0.0 -l -- "/exit"
tmux send-keys -t "$SESSION":0.0 Enter

tmux send-keys -t "$SESSION":0.0 -l -- \
  "bun packages/coding-agent/src/cli.ts --approve --offline --session-dir /tmp/hb3-repair-rerun2-sessions --continue"
tmux send-keys -t "$SESSION":0.0 Enter
sleep 8
tmux capture-pane -p -J -S -1000 -t "$SESSION":0.0 > \
  "$EVIDENCE/tmux-07-restart-continue.txt"

sleep 190
tmux capture-pane -p -J -S -1000 -t "$SESSION":0.0 > \
  "$EVIDENCE/tmux-08-restart-quiet-3min.txt"

rm .atomic/workflows/hb-slice3-throwaway.ts
tmux kill-session -t "$SESSION"
rm -rf /tmp/hb3-repair-rerun2-sessions
```

## Timeline

| UTC | Observed event |
| --- | --- |
| 13:41:37 | Local source CLI command sent. |
| 13:41:38 | Interactive CLI ready; file 01 captured. |
| 13:41:44 | `/workflow hb-slice3-throwaway` sent. This was the last input until exit. |
| 13:41:47 | Run dispatch observed; file 02 captured. The retained run says it started at 13:41:45. |
| 13:42:45 | First live heartbeat observed at `elapsed 1m`; file 03 captured. |
| 13:43:45 | Second live heartbeat observed at `elapsed 2m`; file 04 captured. |
| 13:43:55 | `WORKFLOW COMPLETE` observed; file 05 captured. The run ended at 13:43:55 after 2m10s. |
| 13:47:18 | File 06 captured 3m23s after terminal. No heartbeat card occurs below the terminal card. |
| 13:47:32 | `/exit` sent. |
| 13:47:33 | The same source CLI started with `--continue`. |
| 13:47:42 | Restart restored the completed run; file 07 captured. No stale heartbeat was replayed. |
| 13:51:00 | File 08 captured 3m18s after file 07 and 3m27s after restart. It is byte-identical to file 07. |
| 13:51:07 | Throwaway workflow and scratch session store removed; tmux session killed. |

## What each capture proves

| File | Proof |
| --- | --- |
| `tmux-01-cli-started.txt` | A real interactive Atomic CLI is open in this worktree on the slice branch with the configured provider. |
| `tmux-02-run-dispatched.txt` | The throwaway workflow is running in the background as run `67b756e9-3da6-4544-aaf6-aad58246d97f`. |
| `tmux-03-first-heartbeat.txt` | A `WORKFLOW HEARTBEAT` card arrived without input at `elapsed 1m`, with `cadence 1-minute`. |
| `tmux-04-second-heartbeat.txt` | A second live card arrived at `elapsed 2m`, proving recurring cadence across two boundaries. |
| `tmux-05-run-completed.txt` | The run completed on its own at 2m10s. |
| `tmux-06-quiet-3min-after-terminal.txt` | At 3m23s after completion, the historical 2m heartbeat starts at line 30 and `WORKFLOW COMPLETE` starts at line 45. No heartbeat heading occurs after line 45. The retained state below it says `✓ completed`, ended `13:43:55`, and returned `parked-until-timeout`. |
| `tmux-07-restart-continue.txt` | The restarted CLI restored the same transcript and completed retained run. Its historical 2m heartbeat starts at line 29 and the terminal card at line 45; none was replayed below the terminal card. |
| `tmux-08-restart-quiet-3min.txt` | After another 3m18s, no stale card appeared. This capture is byte-identical to file 07. |

The final two files both have SHA-256
`427277aaa67bad6df5fd41de6e94b2dc196cd468b6284948ff2e81dcaef40451`.
Their sole visible heartbeat is historical and above `WORKFLOW COMPLETE`; no
heartbeat heading occurs after the terminal card. A heartbeat delivered after
completion or restart would render below that card.
