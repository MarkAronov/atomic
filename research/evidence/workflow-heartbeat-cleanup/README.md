# Terminal evidence — heartbeats stop at a terminal state (#1975, slice 3)

A real interactive Atomic CLI, driven through tmux, with a workflow authored at
`heartbeatIntervalMinutes: 1` that parks, heartbeats, then completes on its own.
Nothing is typed after the launch, so no card here is a side effect of a
keystroke, and no keystroke ends the run.

## How to reproduce

```sh
tmux new-session -d -s hb-slice3 -x 200 -y 50
bash scripts/e2e/workflow-heartbeat-cleanup-evidence.sh hb-slice3 research/evidence/workflow-heartbeat-cleanup
tmux kill-session -t hb-slice3
```

The script starts the CLI from source with `bun packages/coding-agent/src/cli.ts`
against a scratch project and an isolated agent directory, launches the
`workflow-heartbeat-cleanup-evidence` fixture workflow, waits for two heartbeat
cards, waits for the run to complete by itself, then stays silent for a settle
window plus three whole cadence intervals. Every step polls the pane for text the
CLI rendered rather than sleeping blindly, so a card that never arrives fails the
run instead of producing an empty capture.

The slice-2 script and fixture are untouched, so that evidence stays
reproducible on its own.

## The assertion, and why it is positional

The final check is *"no `WORKFLOW HEARTBEAT` card appears below the
`WORKFLOW COMPLETE` card"*, not *"the card count did not grow"*. The CLI draws on
the terminal's alternate screen, which has no scrollback: the number of cards a
capture can see falls as older ones scroll off the top, so two counts taken
minutes apart are not comparable. An earlier draft of this script compared counts
and reported a false failure for exactly that reason — the pane had truncated the
first card's header, not gained a fourth card.

A 25-second settle runs before the three quiet intervals. It is shorter than one
interval, so a card the parent's queue had already accepted before the run ended
has time to be injected, while a cadence that was still running could not have
reached its next boundary.

## Captures

| File | What it proves |
| --- | --- |
| `01-cli-started.txt` | A real interactive session is up and accepting input. |
| `02-run-dispatched.txt` | The 1-minute-cadence workflow is running in the background. This is the last thing typed. |
| `03-first-heartbeat.txt` | The first `WORKFLOW HEARTBEAT` card lands on its own, roughly 60s after the persisted start time. |
| `04-second-heartbeat.txt` | A second card one interval later — the cadence is alive, not a one-shot notice. |
| `05-run-completed.txt` | The run reaches `completed` by itself; the `WORKFLOW COMPLETE` card follows the third heartbeat. |
| `06-settled-after-terminal.txt` | 25s later — under one interval — nothing new has been injected. |
| `07-quiet-after-terminal.txt` | A further 190s (three whole intervals) of silence with nothing typed. |
| `harness-shaped-capture.txt` | The same pane with wrapped lines joined, as the script's own assertion reads it. |

## Observed transcript

Three heartbeats at 1m, 2m, and 3m elapsed, the run completing at 3m 20s, and
nothing below it after 215 seconds of waiting:

```
╭ WORKFLOW HEARTBEAT ──────────────────────────────╮
│ ♥ Workflow "workflow-heartbeat-cleanup-evidence" │
│ cadence   1-minute                               │
│ elapsed   3m                                     │
╰──────────────────────────────────────────────────╯

╭ WORKFLOW COMPLETE ───────────────────────────────╮
│ ✓ Workflow "workflow-heartbeat-cleanup-evidence" │
│ run       dc6e79b7-…                             │
│ duration  3m 20s                                 │
╰──────────────────────────────────────────────────╯
```

The 3-minute heartbeat was raised while the run was still active — the run ended
at 3m 20s — so it belongs above the terminal card, and the 4-minute boundary that
a surviving cadence would have raised never appears.
