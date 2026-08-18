import { type DurationBudgetReport, type EffectiveBudget, enforceDurationBudget } from "../shared/budget.js";
import type { RunSnapshot } from "../shared/store-types.js";
import { elapsedRunMs } from "../shared/timing.js";
import type { WorkflowModelUsage } from "../shared/types.js";

export const BUDGET_WRAP_UP_PROMPT =
	"The workflow budget is exhausted. Stop substantive work, summarize useful progress, identify remaining work or blockers, and leave a clear next step. Do not start any new stages.";

export interface BudgetExceededReport extends DurationBudgetReport {
	readonly frontierStage: string;
	readonly wrapUpSummary?: string;
	readonly wrapUpUsage?: WorkflowModelUsage;
}
export type BudgetCheckpoint =
	| { readonly kind: "continue"; readonly report?: DurationBudgetReport }
	| { readonly kind: "warn"; readonly report: DurationBudgetReport }
	| { readonly kind: "wrap_up"; readonly report: DurationBudgetReport }
	| { readonly kind: "exhausted"; readonly report: BudgetExceededReport };

export class WorkflowBudgetExceededError extends Error {
	readonly report: BudgetExceededReport;
	constructor(report: BudgetExceededReport) {
		super(
			`atomic-workflows: ${report.dimension} budget exceeded (${report.reading}ms / ${report.ceiling}ms) at ${report.frontierStage}`,
		);
		this.name = "WorkflowBudgetExceededError";
		this.report = report;
	}
}
export interface RunBudgetController {
	readonly enabled: boolean;
	checkpoint(frontierStage?: string): BudgetCheckpoint;
	registerWrapUp(frontierStage: string, handler: () => Promise<never>): () => void;
	deliverWrapUp(frontierStage: string | undefined): Promise<never>;
	finishWrapUp(
		frontierStage: string | undefined,
		summary: string | undefined,
		usage: WorkflowModelUsage | undefined,
	): WorkflowBudgetExceededError;
}
export function isWorkflowBudgetExceededError(error: unknown): error is WorkflowBudgetExceededError {
	return error instanceof WorkflowBudgetExceededError;
}

function withFrontier(
	report: DurationBudgetReport,
	frontierStage: string | undefined,
	summary: string | undefined,
	usage: WorkflowModelUsage | undefined,
): BudgetExceededReport {
	return {
		...report,
		frontierStage: frontierStage ?? "workflow frontier",
		...(summary !== undefined ? { wrapUpSummary: summary } : {}),
		...(usage !== undefined ? { wrapUpUsage: usage } : {}),
	};
}

export function createRunBudgetController(input: {
	readonly run: RunSnapshot;
	readonly budget: EffectiveBudget;
	readonly onWarning?: (report: DurationBudgetReport) => void;
}): RunBudgetController {
	const { run, budget } = input;
	const enabled = budget.maxDurationMs > 0;
	let warned = run.budgetState?.warned === true;
	let wrapUpDelivered = run.budgetState?.wrapUpDelivered === true;
	let wrapUpCompleted = run.budgetState?.wrapUpCompleted === true;
	let wrapUpSummary = run.budgetState?.wrapUpSummary;
	let wrapUpUsage = run.budgetState?.wrapUpUsage;
	let exhaustedReport: DurationBudgetReport | undefined;
	let wrapUpPromise: Promise<never> | undefined;
	const handlers: Array<{ readonly frontierStage: string; readonly handler: () => Promise<never> }> = [];
	const setState = (duration: DurationBudgetReport): void => {
		run.budgetState = {
			duration,
			...(warned ? { warned: true } : {}),
			...(wrapUpDelivered ? { wrapUpDelivered: true } : {}),
			...(wrapUpCompleted ? { wrapUpCompleted: true } : {}),
			...(wrapUpSummary !== undefined ? { wrapUpSummary } : {}),
			...(wrapUpUsage !== undefined ? { wrapUpUsage } : {}),
		};
	};
	const finishWrapUp = (
		frontierStage: string | undefined,
		summary: string | undefined,
		usage: WorkflowModelUsage | undefined,
	): WorkflowBudgetExceededError => {
		wrapUpDelivered = true;
		wrapUpCompleted = true;
		wrapUpSummary = summary ?? wrapUpSummary;
		wrapUpUsage = usage ?? wrapUpUsage;
		const report = exhaustedReport ?? enforceDurationBudget(elapsedRunMs(run), budget).report;
		setState(report);
		return new WorkflowBudgetExceededError(withFrontier(report, frontierStage, wrapUpSummary, wrapUpUsage));
	};
	const checkpoint = (frontierStage?: string): BudgetCheckpoint => {
		if (!enabled) return { kind: "continue" };
		const check = enforceDurationBudget(elapsedRunMs(run), budget, { warned });
		if (check.kind === "continue") {
			if (check.warning) {
				warned = true;
				input.onWarning?.(check.report);
			}
			setState(check.report);
			return check.warning ? { kind: "warn", report: check.report } : check;
		}
		exhaustedReport ??= check.report;
		setState(check.report);
		if (!wrapUpCompleted) {
			wrapUpDelivered = true;
			setState(check.report);
			return { kind: "wrap_up", report: check.report };
		}
		return { kind: "exhausted", report: withFrontier(exhaustedReport, frontierStage, wrapUpSummary, wrapUpUsage) };
	};
	const registerWrapUp = (frontierStage: string, handler: () => Promise<never>): (() => void) => {
		if (!enabled) return () => {};
		const registration = { frontierStage, handler };
		handlers.push(registration);
		return () => {
			const index = handlers.indexOf(registration);
			if (index >= 0) handlers.splice(index, 1);
		};
	};
	const deliverWrapUp = (frontierStage: string | undefined): Promise<never> => {
		if (wrapUpPromise !== undefined) return wrapUpPromise;
		const registration =
			frontierStage === undefined
				? handlers.at(-1)
				: [...handlers].reverse().find((entry) => entry.frontierStage === frontierStage);
		if (registration === undefined) throw finishWrapUp(frontierStage, undefined, undefined);
		wrapUpPromise = registration.handler();
		return wrapUpPromise;
	};
	return { enabled, checkpoint, registerWrapUp, deliverWrapUp, finishWrapUp };
}
