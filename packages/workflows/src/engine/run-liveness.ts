/** Root-liveness diagnostics for a completed frontier with no live work. */

import type { RunSnapshot, StageStatus, ToolNodeStatus } from "../shared/store-types.js";
import { elapsedRunMs } from "../shared/timing.js";

const TERMINAL_STAGE_STATUSES = new Set<StageStatus>(["completed", "failed", "skipped"]);
const LIVE_TOOL_STATUSES = new Set<ToolNodeStatus>(["pending", "running"]);

export const IMPOSSIBLE_ROOT_LIVENESS_MESSAGE =
	"atomic-workflows: root is running with a completed frontier and no active/control node";

export function hasCompletedFrontierWithoutLiveWork(
	run: Pick<RunSnapshot, "status" | "endedAt" | "stages" | "toolNodes">,
): boolean {
	if (run.status !== "running" || run.endedAt !== undefined) return false;
	if (run.stages.length === 0) return false;
	if (!run.stages.every((stage) => TERMINAL_STAGE_STATUSES.has(stage.status))) return false;
	return !(run.toolNodes ?? []).some((tool) => LIVE_TOOL_STATUSES.has(tool.status));
}

/**
 * True when a raw-running root has a completed frontier, no live stage/tool work,
 * and an already-exhausted duration budget. That combination is not a legal
 * between-node pause: duration enforcement must have become `budget_exceeded`.
 */
export function isImpossibleRootLiveness(
	run: Pick<RunSnapshot, "status" | "endedAt" | "startedAt" | "stages" | "toolNodes" | "budget">,
	now = Date.now(),
): boolean {
	if (!hasCompletedFrontierWithoutLiveWork(run)) return false;
	const ceiling = run.budget?.maxDurationMs ?? 0;
	return ceiling > 0 && elapsedRunMs(run, now) >= ceiling;
}
