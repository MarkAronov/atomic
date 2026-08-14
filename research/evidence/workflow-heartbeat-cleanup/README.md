# Terminal cleanup and restart recovery — interactive evidence (#1975, slice 3)

Eight captures from one real interactive Atomic CLI session, driven through
tmux. A throwaway workflow authored at `heartbeatIntervalMinutes: 1` parks,
heartbeats twice, completes on its own, stays silent for nearly four minutes,
and is then reopened in a restarted CLI that replays no stale heartbeat.

Nothing is typed between the launch and the restart, so no card below is a side
effect of a keystroke, and no keystroke ends the run.

## Environment

| | |
| --- | --- |
| tmux session | `hb-slice3-live` (200×50), killed afterwards |
| worktree / branch | `atomic-hb-slice3` on `feat/workflow-heartbeat-cleanup` |
| CLI under test | `bun packages/coding-agent/src/cli.ts` — this checkout's source, not an installed build |
| provider | `(anthropic) claude-opus-5 high`, the real configured credentials |
| session dir | `/tmp/hb3-sessions` (scratch, removed afterwards) |
| workflow | `hb-slice3-throwaway`, run id `42316462-0b19-40b1-b9c1-12a0aa8723f9` |
| date | 2026-08-14, timestamps below in UTC |

## The throwaway workflow

Written to `.atomic/workflows/hb-slice3-throwaway.ts` for the run and **deleted
afterwards**, so it is not part of the slice. It was one parked `ctx.tool` call
and nothing else — no model call of its own:

```ts
export default workflow({
	name: "hb-slice3-throwaway",
	heartbeatIntervalMinutes: 1,
	inputs: {},
	outputs: { parked: Type.String() },
	run: async (ctx) => {
		const parked = await ctx.tool("park-tool", {}, async (toolContext) => {
			/* resolves after PARK_MS = 200_000, or on abort */
		});
		return { parked };
	},
});
```

200 s is past boundary 3 (180 s) and well short of boundary 4 (240 s), so the
run becomes terminal with nothing due at that instant and the count of cards
that belong above the terminal card is unambiguous.

## Exact commands

```sh
cd /Users/tonystark/Documents/projects/atomic-hb-slice3
tmux new-session -d -s hb-slice3-live -x 200 -y 50 -c "$PWD"

# 1. the real CLI, from this checkout's source
tmux send-keys -t hb-slice3-live -l \
  "bun packages/coding-agent/src/cli.ts --approve --offline --session-dir /tmp/hb3-sessions"
tmux send-keys -t hb-slice3-live Enter
tmux capture-pane -p -t hb-slice3-live > tmux-01-cli-started.txt

# 2. launch the parked run — the last thing typed until the restart
tmux send-keys -t hb-slice3-live -l "/workflow hb-slice3-throwaway"
tmux send-keys -t hb-slice3-live Enter
tmux capture-pane -p -t hb-slice3-live > tmux-02-run-dispatched.txt

# 3-5. poll the pane for what the CLI rendered, capturing at each transition
#      (WORKFLOW HEARTBEAT, "elapsed 2m", WORKFLOW COMPLETE)
tmux capture-pane -p -t hb-slice3-live > tmux-03-first-heartbeat.txt
tmux capture-pane -p -t hb-slice3-live > tmux-04-second-heartbeat.txt
tmux capture-pane -p -t hb-slice3-live > tmux-05-run-completed.txt

# 6. silence, nothing typed
sleep 210
tmux capture-pane -p -t hb-slice3-live > tmux-06-quiet-3min-after-terminal.txt

# 7-8. restart the CLI onto the same persisted session
tmux send-keys -t hb-slice3-live -l "/exit" ; tmux send-keys -t hb-slice3-live Enter
tmux send-keys -t hb-slice3-live -l \
  "bun packages/coding-agent/src/cli.ts --approve --offline --session-dir /tmp/hb3-sessions --continue"
tmux send-keys -t hb-slice3-live Enter
tmux capture-pane -p -t hb-slice3-live > tmux-07-restart-continue.txt
sleep 220
tmux capture-pane -p -t hb-slice3-live > tmux-08-restart-quiet-3min.txt

tmux kill-session -t hb-slice3-live
rm .atomic/workflows/hb-slice3-throwaway.ts
```

Each wait polled the pane for text the CLI had rendered rather than sleeping
blindly; only the two quiet windows are deliberate fixed sleeps, because there
the whole claim is that nothing arrives.

## Timeline

| UTC | Event |
| --- | --- |
| 11:04:39 | `/workflow hb-slice3-throwaway` typed — the last keystroke until 11:12:10 |
| 11:04:41 | run `42316462` starts in background |
| 11:05:42 | **heartbeat 1**, `elapsed 1m` |
| 11:06:42 | **heartbeat 2**, `elapsed 2m` — one interval later |
| ~11:07:41 | a third heartbeat, still while the run is alive. Its card had scrolled off the alternate screen before the next capture, so what the captures hold is the parent's reply to it — *"Run 42316462 at 3m: unchanged … On goal, continuing."* |
| 11:08:01 | run completes on its own, `duration 3m 20s` |
| 11:11:49 | 3m 48s of silence — no card below the terminal card |
| 11:12:10 | `/exit` |
| 11:12:51 | CLI restarted with `--continue` |
| 11:17:24 | 4m 33s after the restart — still no card below the terminal card |

A cadence that had survived the terminal state would have raised boundaries at
4m, 5m, 6m and 7m before 11:11:49, and four more before 11:17:24. None appears.

## Why the final assertion is positional

The claim checked is *"no `WORKFLOW HEARTBEAT` card appears below the
`WORKFLOW COMPLETE` card"*, not *"the card count did not grow"*. The CLI draws
on the terminal's alternate screen, which has no scrollback: the number of cards
a capture can see **falls** as older ones scroll off the top, so two counts taken
minutes apart are not comparable — an earlier pass of this scenario read a
count of zero purely because the cards had scrolled away. A heartbeat is
appended below whatever is already in the transcript, so "nothing below the
terminal card" is exactly the claim and is immune to that truncation.

For the same reason the two heartbeats are each captured at the moment they
landed, rather than counted at the end.

## Captures

| File | What it proves |
| --- | --- |
| `tmux-01-cli-started.txt` | A real interactive session on this checkout's source, with a live provider, accepting input. |
| `tmux-02-run-dispatched.txt` | The 1-minute-cadence workflow is running in the background as run `42316462`. The last thing typed. |
| `tmux-03-first-heartbeat.txt` | The first `WORKFLOW HEARTBEAT` card lands on its own at `elapsed 1m`, naming the workflow, run, and `cadence 1-minute`. |
| `tmux-04-second-heartbeat.txt` | A second card at `elapsed 2m` — a live recurring cadence, not a one-shot notice. Above it, the parent's own reply to the first: *"I'll report at the next heartbeat or on completion."* |
| `tmux-05-run-completed.txt` | The run reaches `completed` by itself — `WORKFLOW COMPLETE`, `duration 3m 20s`, `park-tool completed`. No keystroke ended it. |
| `tmux-06-quiet-3min-after-terminal.txt` | 3m 48s past the terminal transition: the `WORKFLOW COMPLETE` card is still the last card, with zero heartbeat cards below it. Terminal cleanup held. |
| `tmux-07-restart-continue.txt` | A restarted CLI resumes the same persisted session. The completed run and its history are restored; no heartbeat is replayed below the terminal card. |
| `tmux-08-restart-quiet-3min.txt` | 4m 33s after the restart, still nothing new — this file is byte-identical to `tmux-07`. No stale schedule survived the process boundary. |

The restart leg matters because the persisted session genuinely carried
heartbeat state to reload: its JSONL held three `workflows:workflow-heartbeat`
entries alongside `workflow.run.start` and `workflow.run.end`. After the
restart it still held exactly three — the restored run raised none.

`scripts/e2e/workflow-heartbeat-cleanup-evidence.sh` automates the pre-restart
half of this scenario against its own scratch project, for re-running it without
hand-driving tmux.
