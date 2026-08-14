# Slice 3 terminal cleanup and restart recovery — real CLI evidence

This is a fresh rerun after the Slice 3 repair for issue #1975. It used one
real interactive Atomic CLI, this checkout's source entrypoint, a live configured
provider, and tmux. The run emitted heartbeats at one, two, and three minutes,
completed on its own at 3m20s, then emitted no heartbeat after the terminal card.
The restarted CLI also replayed no stale heartbeat.

## Environment

| Field | Value |
| --- | --- |
| Worktree | `/Users/tonystark/Documents/projects/atomic-hb-slice3` |
| Branch | `feat/workflow-heartbeat-cleanup` |
| tmux session | `hb-slice3-rerun` (created at 200×50, raised to 200×90 for the final positional captures, then killed) |
| CLI under test | `bun packages/coding-agent/src/cli.ts` from this checkout |
| Provider shown by CLI | `(anthropic) claude-opus-5 high` with configured credentials |
| Session store | `/tmp/hb3-rerun-sessions` (scratch; removed after the run) |
| Workflow | `hb-slice3-throwaway` |
| Run id | `e889dbc3-cb2e-4ea7-b54f-32e1b7702f05` |
| Date/time zone | 2026-08-14, UTC |

The provider returned some visible 429 retry notices during parent turns. Those
notices do not alter the workflow state or the heartbeat-card evidence. The CLI
still rendered all three live heartbeat cards and the terminal card.

## Throwaway workflow

The run used `.atomic/workflows/hb-slice3-throwaway.ts`. It was deleted after
the captures and is not committed. Its full definition was:

```ts
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

const PARK_MS = 200_000;

export default workflow({
	name: "hb-slice3-throwaway",
	description: "Parks past three heartbeat boundaries, then completes on its own.",
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

`PARK_MS = 200_000` crosses the 1m, 2m, and 3m cadence boundaries and
finishes before 4m. The workflow has one durable tool and no model stage. No
input was sent between launch and the terminal transition.

## Exact commands

The workflow file above was first written under `.atomic/workflows/`. The live
session and captures were then driven with these commands from the worktree:

```sh
cd /Users/tonystark/Documents/projects/atomic-hb-slice3
rm -rf research/evidence/workflow-heartbeat-cleanup /tmp/hb3-rerun-sessions
mkdir -p research/evidence/workflow-heartbeat-cleanup /tmp/hb3-rerun-sessions

tmux new-session -d -s hb-slice3-rerun -x 200 -y 50 -c "$PWD"
tmux set-option -t hb-slice3-rerun history-limit 100000

tmux send-keys -t hb-slice3-rerun:0.0 -l -- \
  "bun packages/coding-agent/src/cli.ts --approve --offline --session-dir /tmp/hb3-rerun-sessions"
tmux send-keys -t hb-slice3-rerun:0.0 Enter
tmux capture-pane -p -J -t hb-slice3-rerun:0.0 > \
  research/evidence/workflow-heartbeat-cleanup/tmux-01-cli-started.txt

tmux send-keys -t hb-slice3-rerun:0.0 -l -- "/workflow hb-slice3-throwaway"
tmux send-keys -t hb-slice3-rerun:0.0 Enter
```

The pane was polled for `started in background`, `WORKFLOW HEARTBEAT` with
`elapsed 1m`, `WORKFLOW HEARTBEAT` with `elapsed 2m`, and `WORKFLOW COMPLETE`.
At each match it was captured with the same `tmux capture-pane -p -J` command
into files 02 through 05. Nothing was typed while those transitions occurred.

```sh
# After WORKFLOW COMPLETE:
sleep 210
tmux resize-window -t hb-slice3-rerun:0 -x 200 -y 90
tmux capture-pane -p -J -t hb-slice3-rerun:0.0 > \
  research/evidence/workflow-heartbeat-cleanup/tmux-06-quiet-3min-after-terminal.txt

# Restart onto the same persisted Atomic session:
tmux send-keys -t hb-slice3-rerun:0.0 -l -- "/exit"
tmux send-keys -t hb-slice3-rerun:0.0 Enter
tmux send-keys -t hb-slice3-rerun:0.0 -l -- \
  "bun packages/coding-agent/src/cli.ts --approve --offline --session-dir /tmp/hb3-rerun-sessions --continue"
tmux send-keys -t hb-slice3-rerun:0.0 Enter
tmux capture-pane -p -J -t hb-slice3-rerun:0.0 > \
  research/evidence/workflow-heartbeat-cleanup/tmux-07-restart-continue.txt

sleep 190
tmux capture-pane -p -J -t hb-slice3-rerun:0.0 > \
  research/evidence/workflow-heartbeat-cleanup/tmux-08-restart-quiet-3min.txt

rm .atomic/workflows/hb-slice3-throwaway.ts
tmux kill-session -t hb-slice3-rerun
rm -rf /tmp/hb3-rerun-sessions
```

## Timeline

| UTC | Observed event |
| --- | --- |
| 12:10:40 | Local source CLI command sent. |
| 12:15:05 | Interactive CLI ready; file 01 captured. |
| 12:15:07 | `/workflow hb-slice3-throwaway` sent. This was the last input until exit. |
| 12:15:09 | Run dispatch observed; file 02 captured. The run card says it started at 12:15:06. |
| 12:16:08 | First heartbeat observed at `elapsed 1m`; file 03 captured. |
| 12:17:06 | Second heartbeat observed at `elapsed 2m`; file 04 captured. |
| ~12:18:06 | Third live heartbeat at `elapsed 3m`; it remains above the terminal card in files 05–08. |
| 12:18:26 | `WORKFLOW COMPLETE` observed; file 05 captured. The retained run says it ended at 12:18:26 after 3m20s. |
| 12:22:25 | File 06 captured 3m59s after terminal. No heartbeat card appears below the terminal card. |
| 12:22:45 | `/exit`, then the same source CLI with `--continue`. |
| 12:22:55 | Restart restored the completed run; file 07 captured. No heartbeat was replayed below the terminal card. |
| 12:26:14 | File 08 captured 3m19s after restart readiness. It is byte-identical to file 07. |

## What each capture proves

| File | Proof |
| --- | --- |
| `tmux-01-cli-started.txt` | A real interactive Atomic v0.0.0 CLI is open in this worktree on the slice branch with the configured provider. |
| `tmux-02-run-dispatched.txt` | The throwaway workflow is running in the background as run `e889dbc3-cb2e-4ea7-b54f-32e1b7702f05`. |
| `tmux-03-first-heartbeat.txt` | A `WORKFLOW HEARTBEAT` card arrived without input at `elapsed 1m`, with `cadence 1-minute`. |
| `tmux-04-second-heartbeat.txt` | A second live card arrived at `elapsed 2m`, proving recurring cadence across two boundaries. |
| `tmux-05-run-completed.txt` | The run completed on its own at 3m20s and `park-tool` returned `parked-until-timeout`. |
| `tmux-06-quiet-3min-after-terminal.txt` | At 3m59s after completion, the historical 3m heartbeat is above `WORKFLOW COMPLETE`; there is no heartbeat card below the terminal card. At least three post-terminal boundaries passed with no new card. |
| `tmux-07-restart-continue.txt` | The restarted CLI restored the same transcript and completed retained run. The only visible heartbeat is historical and above `WORKFLOW COMPLETE`; none was replayed below it. |
| `tmux-08-restart-quiet-3min.txt` | After 3m19s more, no stale card appeared. This capture is byte-identical to file 07. |

The final two files both have SHA-256
`f13d92ba2226dd12ce49e5caea12d66861c2c7fd57233dfef64a7e7abcba92b9`.
Their historical 3m heartbeat starts at line 2, the terminal card starts at line
36, and no heartbeat heading occurs after line 36. File 06 has the same
ordering: historical heartbeat at line 3, terminal card at line 36, none after.
This positional check matters because the TUI repaints an alternate screen and
old cards can scroll away; a card delivered after terminal would render below
the terminal card.

The text below the terminal card that says “keep it running” is the model reply
already in flight from the live 3m heartbeat. It is not a new heartbeat card.
No new `WORKFLOW HEARTBEAT` card arrived after completion or after restart.
