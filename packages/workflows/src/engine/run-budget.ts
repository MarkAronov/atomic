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
export type RunBudgetController = ReturnType<typeof createRunBudgetController>;
const withFrontier = (
	report: DurationBudgetReport,
	frontierStage: string | undefined,
	summary?: string,
	usage?: WorkflowModelUsage,
): BudgetExceededReport =>
	Object.assign(
		{ ...report, frontierStage: frontierStage ?? "workflow frontier" },
		summary === undefined ? {} : { wrapUpSummary: summary },
		usage === undefined ? {} : { wrapUpUsage: usage },
	);
export function createRunBudgetController(input: {
	readonly run: RunSnapshot;
	readonly budget: EffectiveBudget;
	readonly onWarning?: (report: DurationBudgetReport) => void;
}) {
	const { run, budget } = input;
	const enabled = budget.maxDurationMs > 0;
	let state = run.budgetState === undefined ? undefined : { ...run.budgetState };
	let exhaustedReport: DurationBudgetReport | undefined;
	let wrapUpPromise: Promise<never> | undefined;
	const handlers: Array<{ readonly frontierStage: string; readonly handler: () => Promise<never> }> = [];
	const setState = (duration: DurationBudgetReport): void => {
		run.budgetState = state = { ...(state ?? {}), duration };
	};
	const finishWrapUp = (
		frontierStage: string | undefined,
		summary?: string,
		usage?: WorkflowModelUsage,
		delivered = true,
	): WorkflowBudgetExceededError => {
		state = Object.assign(state ?? {}, { systemOwnedStop: true });
		if (delivered)
			Object.assign(state, {
				wrapUpDelivered: true,
				wrapUpCompleted: true,
				...(summary === undefined ? {} : { wrapUpSummary: summary }),
				...(usage === undefined ? {} : { wrapUpUsage: usage }),
			});
		const report = exhaustedReport ?? enforceDurationBudget(elapsedRunMs(run), budget).report;
		setState(report);
		return new WorkflowBudgetExceededError(
			withFrontier(report, frontierStage, state?.wrapUpSummary, state?.wrapUpUsage),
		);
	};
	const checkpoint = (frontierStage?: string) => {
		if (!enabled) return { kind: "continue" };
		const check = enforceDurationBudget(elapsedRunMs(run), budget, { warned: state?.warned });
		if (check.kind === "continue") {
			if (check.warning) {
				state = { ...(state ?? {}), warned: true, warning: check.report };
				input.onWarning?.(check.report);
			}
			setState(check.report);
			return check.warning ? { kind: "warn", report: check.report } : check;
		}
		exhaustedReport ??= check.report;
		setState(check.report);
		if (state?.wrapUpCompleted !== true) return { kind: "wrap_up", report: check.report };
		return {
			kind: "exhausted",
			report: withFrontier(exhaustedReport, frontierStage, state.wrapUpSummary, state.wrapUpUsage),
		};
	};
	const stopAtBoundary = (frontierStage?: string): void => {
		const resolvedFrontierStage = frontierStage ?? handlers.at(-1)?.frontierStage;
		const check = checkpoint(resolvedFrontierStage);
		if (check.kind === "wrap_up" || check.kind === "exhausted")
			throw finishWrapUp(resolvedFrontierStage, undefined, undefined, false);
	};
	const rethrowIfSystemOwnedStop = (frontierStage?: string): void => {
		if (state?.systemOwnedStop === true)
			throw finishWrapUp(frontierStage, state.wrapUpSummary, state.wrapUpUsage, state.wrapUpCompleted === true);
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

	const deliverWrapUp = (frontierStage: string): Promise<never> => {
		if (wrapUpPromise !== undefined) return wrapUpPromise;
		if (state?.systemOwnedStop === true && state.wrapUpCompleted !== true)
			throw finishWrapUp(frontierStage, undefined, undefined, false);
		const registration = handlers.findLast((entry) => entry.frontierStage === frontierStage) ?? handlers.at(-1);
		if (registration === undefined) throw finishWrapUp(frontierStage, undefined, undefined, false);
		wrapUpPromise = registration.handler();
		return wrapUpPromise;
	};
	const stopAtBoundaryAsync = async (frontierStage?: string): Promise<void> => {
		const check = checkpoint(frontierStage);
		if (check.kind === "continue" || check.kind === "warn") return;
		if (check.kind === "wrap_up") {
			await deliverWrapUp(frontierStage ?? "workflow frontier");
			return;
		}
		throw finishWrapUp(frontierStage, state?.wrapUpSummary, state?.wrapUpUsage, state?.wrapUpCompleted === true);
	};
	return {
		enabled,
		checkpoint,
		registerWrapUp,
		deliverWrapUp,
		finishWrapUp,
		rethrowIfSystemOwnedStop,
		stopAtBoundary,
		stopAtBoundaryAsync,
	};
}
