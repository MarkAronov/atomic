#!/usr/bin/env bash
#
# Terminal evidence for issue #1975 slice 3 — heartbeats stop once a workflow
# reaches a terminal state.
#
# Usage: bash scripts/e2e/workflow-heartbeat-cleanup-evidence.sh <tmux-session-name> <artifact-dir>
#
# The session already exists and is captured by the caller afterwards, so this
# script never creates, renames, kills, or detaches it. It types into the pane
# and waits for text the CLI renders; it never prints the evidence itself.
#
# Scenario, driven through the real interactive CLI:
#
#   /workflow workflow-heartbeat-cleanup-evidence   a tool-only run that parks
#                                                   for 200s, authored with
#                                                   heartbeatIntervalMinutes: 1
#   (wait)                                          two WORKFLOW HEARTBEAT cards
#                                                   land on their own, one
#                                                   interval apart
#   (wait)                                          the run completes by itself
#   (wait 25s + 3 intervals)                        no WORKFLOW HEARTBEAT card
#                                                   ever appears after the
#                                                   terminal card — the cadence
#                                                   stopped with the run
#
# Nothing is typed after the launch.
#
# The final assertion is positional, not a count: the CLI draws on the alternate
# screen, which has no scrollback, so the number of cards visible in a capture
# falls as older ones scroll off and cannot be compared across time. "No
# heartbeat below the terminal card" is exactly the claim and is immune to that.
# The 25s settle before the quiet window is under one interval, so a card the
# parent's queue had already accepted has time to be injected while a live
# cadence could not have reached its next boundary.
#
# Separate from scripts/e2e/workflow-heartbeat-evidence.sh (slice 2) on purpose:
# that script's evidence stays reproducible unchanged.

set -euo pipefail

SESSION="${1:?usage: workflow-heartbeat-cleanup-evidence.sh <tmux-session-name> <artifact-dir>}"
ARTIFACTS="${2:?usage: workflow-heartbeat-cleanup-evidence.sh <tmux-session-name> <artifact-dir>}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE="$REPO_ROOT/test/integration/fixtures/workflow-heartbeat-cleanup-evidence-workflow.ts"
WORKFLOW_NAME="workflow-heartbeat-cleanup-evidence"
# Three cadence intervals of silence after the run ended.
QUIET_SECONDS=190
# Under one interval: long enough for a card the parent's queue had already
# accepted before the run ended to be read and rendered, short enough that a
# still-running cadence could not have reached its next boundary.
SETTLE_SECONDS=25
# Bun is a declared engine of this repository and runs the CLI from source.
BUN="${ATOMIC_BUN_EXECUTABLE:-bun}"
if ! command -v "$BUN" >/dev/null 2>&1; then
	echo "heartbeat cleanup evidence: bun was not found on PATH; set ATOMIC_BUN_EXECUTABLE" >&2
	exit 1
fi

mkdir -p "$ARTIFACTS"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/workflow-heartbeat-cleanup-evidence-XXXXXX")"
PROJECT="$WORKDIR/project"
AGENT="$WORKDIR/agent"
mkdir -p "$PROJECT/.atomic/workflows" "$AGENT"
cp "$FIXTURE" "$PROJECT/.atomic/workflows/"

step=0

capture() { tmux capture-pane -p -t "$SESSION"; }

# The pane exactly as the caller will read it: scrollback included, wrapped
# lines joined, every line padded to the pane width.
capture_as_harness() { tmux capture-pane -p -J -S - -t "$SESSION"; }

# Heartbeat cards rendered *after* the run's terminal card, which is the whole
# claim. Deliberately positional rather than a count: the CLI draws on the
# alternate screen, which has no scrollback, so a total count silently shrinks
# as older cards scroll off the top and cannot be compared across time.
heartbeats_after_terminal() {
	local pane="$1" completed_at
	completed_at="$(grep -nF -- "WORKFLOW COMPLETE" "$pane" | tail -1 | cut -d: -f1)"
	if [[ -z "$completed_at" ]]; then
		echo "missing"
		return 0
	fi
	tail -n "+$((completed_at + 1))" "$pane" | grep -cF -- "WORKFLOW HEARTBEAT" || true
}

save() {
	step=$((step + 1))
	capture >"$ARTIFACTS/$(printf '%02d' "$step")-$1.txt"
}

save_harness() {
	step=$((step + 1))
	capture_as_harness >"$ARTIFACTS/$(printf '%02d' "$step")-$1.txt"
}

# Poll the pane for text the CLI rendered. Never a bare sleep: each step waits
# for the state it depends on, and a step that never arrives fails the run.
await() {
	local needle="$1" label="$2" timeout="${3:-120}"
	local deadline=$((SECONDS + timeout))
	while ((SECONDS < deadline)); do
		if capture_as_harness | grep -qF -- "$needle"; then return 0; fi
		sleep 2
	done
	echo "heartbeat cleanup evidence: timed out after ${timeout}s waiting for ${label}" >&2
	capture_as_harness >"$ARTIFACTS/failure-${label// /-}.txt"
	return 1
}

# Poll for the Nth occurrence of a needle across the whole scrollback.
await_count() {
	local needle="$1" wanted="$2" label="$3" timeout="${4:-120}"
	local deadline=$((SECONDS + timeout))
	while ((SECONDS < deadline)); do
		if (($(capture_as_harness | grep -cF -- "$needle" || true) >= wanted)); then return 0; fi
		sleep 2
	done
	echo "heartbeat cleanup evidence: timed out after ${timeout}s waiting for ${label}" >&2
	capture_as_harness >"$ARTIFACTS/failure-${label// /-}.txt"
	return 1
}

# Type one slash command and submit it. The first Enter can be consumed by an
# open completion popup, so submission is confirmed by the editor going quiet.
type_command() {
	tmux send-keys -t "$SESSION" -l "$1"
	sleep 0.5
	tmux send-keys -t "$SESSION" Enter
	sleep 0.5
	if capture | grep -qF -- "❯ $1"; then
		tmux send-keys -t "$SESSION" Enter
		sleep 0.5
	fi
}

# 1. Start the real CLI in the pane, against a scratch project holding the
#    fixture workflow and an isolated agent directory.
tmux send-keys -t "$SESSION" -l \
	"cd '$PROJECT' && ATOMIC_CODING_AGENT_DIR='$AGENT' '$BUN' '$REPO_ROOT/packages/coding-agent/src/cli.ts' --approve --offline --no-session"
tmux send-keys -t "$SESSION" Enter
await "Type a message or slash command" "the CLI to finish starting" 240
save "cli-started"

# 2. Launch the parked run. This is the last thing typed in this scenario.
type_command "/workflow $WORKFLOW_NAME"
await "started in background" "the run to be dispatched" 120
RUN_ID="$(capture | grep -oE '/workflow connect [0-9a-f]{8}' | tail -1 | awk '{print $3}')"
if [[ -z "$RUN_ID" ]]; then
	echo "heartbeat cleanup evidence: the CLI rendered no dispatched run id" >&2
	capture >"$ARTIFACTS/failure-no-run-id.txt"
	exit 1
fi
save "run-dispatched"

# 3. The cadence is alive: two cards, one interval apart, with nothing typed.
await "WORKFLOW HEARTBEAT" "the first heartbeat card in the main chat" 150
save "first-heartbeat"
await_count "WORKFLOW HEARTBEAT" 2 "the second heartbeat card one interval later" 200
save "second-heartbeat"

# 4. The run ends on its own. `WORKFLOW COMPLETE` is the terminal lifecycle
#    card's own heading, so this waits for the terminal state rather than for a
#    timeout of its own.
await "WORKFLOW COMPLETE" "the run to reach a terminal state by itself" 240
save "run-completed"

# A card the parent's queue had already accepted before the run ended is still
# the parent's to read and can be injected just after the completion card. Let
# that settle for less than one interval, so anything appearing later is the
# cadence rather than a card already in flight.
sleep "$SETTLE_SECONDS"
save "settled-after-terminal"

# 5. Three whole intervals of silence, with nothing typed. A cadence that had
#    survived the terminal state would have raised at least three more cards.
sleep "$QUIET_SECONDS"
save_harness "quiet-after-terminal"

FINAL_PANE="$ARTIFACTS/harness-shaped-capture.txt"
capture_as_harness >"$FINAL_PANE"
AFTER_TERMINAL="$(heartbeats_after_terminal "$FINAL_PANE")"
if [[ "$AFTER_TERMINAL" != "0" ]]; then
	echo "heartbeat cleanup evidence: ${AFTER_TERMINAL} heartbeat card(s) after the terminal card," \
		"${QUIET_SECONDS}s (three intervals) past completion" >&2
	cp "$FINAL_PANE" "$ARTIFACTS/failure-heartbeat-after-terminal.txt"
	exit 1
fi
echo "heartbeat cleanup evidence: no heartbeat card after the terminal card," \
	"${SETTLE_SECONDS}s + ${QUIET_SECONDS}s past completion"

# 6. Guard the handover: assert the markers in the pane shape the caller reads.
HARNESS_PANE="$FINAL_PANE"
for marker in "WORKFLOW HEARTBEAT" "$WORKFLOW_NAME" "WORKFLOW COMPLETE"; do
	if ! grep -qF -- "$marker" "$HARNESS_PANE"; then
		echo "heartbeat cleanup evidence: ${marker} is missing from the pane as the caller captures it" >&2
		exit 1
	fi
done

echo "heartbeat cleanup evidence: scenario complete; run $RUN_ID;" \
	"heartbeats before the terminal card and none after it; artifacts in $ARTIFACTS"
