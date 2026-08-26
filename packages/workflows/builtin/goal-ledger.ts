import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LEDGER_FILENAME, type GoalLedger, type GoalLifecycleEvent } from "./goal-types.js";

type ModelVisibleGoalLedger = Omit<
  GoalLedger,
  "turns" | "receipts" | "reviews" | "blockers" | "decisions" | "lifecycle"
> & {
  readonly receipts: ReadonlyArray<Omit<GoalLedger["receipts"][number], "turn">>;
  readonly reviews: ReadonlyArray<Omit<GoalLedger["reviews"][number], "turn">>;
  readonly blockers: ReadonlyArray<Omit<GoalLedger["blockers"][number], "turn">>;
  readonly decisions: ReadonlyArray<Omit<GoalLedger["decisions"][number], "turn">>;
  readonly lifecycle: ReadonlyArray<Omit<GoalLedger["lifecycle"][number], "turn">>;
};

function withoutTurn<T extends { readonly turn: number }>(value: T): Omit<T, "turn"> {
  const copy = { ...value } as Omit<T, "turn"> & { turn?: number };
  delete copy.turn;
  return copy;
}

function modelVisibleLedger(ledger: GoalLedger): ModelVisibleGoalLedger {
  return {
    goal_id: ledger.goal_id,
    objective: ledger.objective,
    acceptance_criteria: ledger.acceptance_criteria,
    status: ledger.status,
    created_at: ledger.created_at,
    updated_at: ledger.updated_at,
    receipts: ledger.receipts.map(withoutTurn),
    reviews: ledger.reviews.map(withoutTurn),
    blockers: ledger.blockers.map(withoutTurn),
    decisions: ledger.decisions.map(withoutTurn),
    lifecycle: ledger.lifecycle.map(withoutTurn),
    reverification: ledger.reverification ?? [],
    convergence: ledger.convergence ?? [],
  };
}

export function appendLifecycleEvent(
  ledger: GoalLedger,
  event: GoalLifecycleEvent["event"],
  summary: string,
  turn = ledger.turns,
): void {
  ledger.lifecycle.push({
    turn,
    event,
    status: ledger.status,
    at: new Date().toISOString(),
    summary,
  });
}

function restoreTurns<T>(values: readonly Omit<T & { readonly turn: number }, "turn">[], turnForIndex: (index: number) => number): T[] {
  return values.map((value, index) => ({ ...value, turn: turnForIndex(index) }) as T);
}
function restoreReviewTurns(values: ModelVisibleGoalLedger["reviews"]): GoalLedger["reviews"] {
  const reviewerOccurrences = new Map<string, number>();
  return values.map((value) => {
    const turn = (reviewerOccurrences.get(value.reviewer) ?? 0) + 1;
    reviewerOccurrences.set(value.reviewer, turn);
    return { ...value, turn };
  });
}


async function readExistingGoalLedger(ledgerPath: string): Promise<GoalLedger | undefined> {
  let contents: string;
  try {
    contents = await readFile(ledgerPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  const stored = JSON.parse(contents) as ModelVisibleGoalLedger;
  const turns = stored.receipts.length;
  return {
    ...stored,
    turns,
    receipts: restoreTurns<GoalLedger["receipts"][number]>(stored.receipts, (index) => index + 1),
    reviews: restoreReviewTurns(stored.reviews),
    blockers: restoreTurns<GoalLedger["blockers"][number]>(stored.blockers, (index) => index + 1),
    decisions: restoreTurns<GoalLedger["decisions"][number]>(stored.decisions, (index) => index + 1),
    lifecycle: restoreTurns<GoalLedger["lifecycle"][number]>(stored.lifecycle, (index) =>
      stored.lifecycle[index]?.event === "created" ? 0 : Math.min(index, Math.max(turns, 1)),
    ),
  };
}

export async function createGoalLedger(
  objective: string,
  acceptanceCriteria: string,
  artifactDir: string,
): Promise<{ ledger: GoalLedger; ledgerPath: string; artifactDir: string }> {
  const ledgerPath = join(artifactDir, LEDGER_FILENAME);
  const existing = await readExistingGoalLedger(ledgerPath);
  if (existing !== undefined) return { ledger: existing, ledgerPath, artifactDir };

  const goalId = randomUUID();
  const now = new Date().toISOString();
  const ledger: GoalLedger = {
    goal_id: goalId,
    objective,
    acceptance_criteria: acceptanceCriteria,
    status: "active",
    turns: 0,
    created_at: now,
    updated_at: now,
    receipts: [],
    reviews: [],
    blockers: [],
    decisions: [],
    lifecycle: [],
    reverification: [],
    convergence: [],
  };
  appendLifecycleEvent(ledger, "created", "Goal created.", 0);
  await writeGoalLedger(ledgerPath, ledger);
  return { ledger, ledgerPath, artifactDir };
}

export async function writeGoalLedger(
  ledgerPath: string,
  ledger: GoalLedger,
): Promise<void> {
  ledger.updated_at = new Date().toISOString();
  await writeFile(ledgerPath, `${JSON.stringify(modelVisibleLedger(ledger), null, 2)}\n`, {
    encoding: "utf8",
  });
}
