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
export interface BudgetCheckpointContinue {
	readonly kind: "continue";
}
export interface BudgetCheckpointWarning {
	readonly kind: "warn";
	readonly report: DurationBudgetReport;
}
export interface BudgetCheckpointWrapUp {
	readonly kind: "wrap_up";
	readonly report: DurationBudgetReport;
}
export interface BudgetCheckpointExhausted {
	readonly kind: "exhausted";
	readonly report: BudgetExceededReport;
}
export type BudgetCheckpoint =
	| BudgetCheckpointContinue
	| BudgetCheckpointWarning
	| BudgetCheckpointWrapUp
	| BudgetCheckpointExhausted;
export interface RunBudgetController {
	readonly enabled: boolean;
	readonly checkpoint: (frontierStage?: string) => BudgetCheckpoint;
	readonly registerWrapUp: (frontierStage: string, handler: () => Promise<never>) => () => void;
	readonly deliverWrapUp: (frontierStage: string) => Promise<never>;
	readonly finishWrapUp: (
		frontierStage: string | undefined,
		summary?: string,
		usage?: WorkflowModelUsage,
		delivered?: boolean,
	) => WorkflowBudgetExceededError;
	readonly rethrowIfSystemOwnedStop: (frontierStage?: string) => void;
	readonly stopAtBoundary: (frontierStage?: string) => void;
	readonly stopAtBoundaryAsync: (frontierStage?: string) => Promise<void>;
	readonly awaitPendingWrapUp: () => Promise<WorkflowBudgetExceededError | undefined>;
}
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
	readonly rootBudget?: RunBudgetController;
}) {
	const { run, budget } = input;
	const ownEnabled = budget.maxDurationMs > 0;
	const enabled = ownEnabled || input.rootBudget?.enabled === true;
	let state = run.budgetState === undefined ? undefined : { ...run.budgetState };
	let exhaustedReport: DurationBudgetReport | undefined;
	let wrapUpPromise: Promise<never> | undefined;
	let rootWrapUpPending = false;
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
	const ownCheckpoint = (frontierStage?: string): BudgetCheckpoint => {
		if (!ownEnabled) return { kind: "continue" };
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
	const checkpoint = (frontierStage?: string): BudgetCheckpoint => {
		const rootCheck = input.rootBudget?.enabled === true ? input.rootBudget.checkpoint(frontierStage) : undefined;
		if (rootCheck?.kind === "wrap_up") rootWrapUpPending = true;
		if (rootCheck?.kind === "wrap_up" || rootCheck?.kind === "exhausted") return rootCheck;
		return ownCheckpoint(frontierStage);
	};
	const stopAtBoundary = (frontierStage?: string): void => {
		const resolvedFrontierStage = frontierStage ?? handlers.at(-1)?.frontierStage;
		if (input.rootBudget?.enabled === true) {
			const rootCheck = input.rootBudget.checkpoint(resolvedFrontierStage);
			if (rootCheck.kind === "wrap_up") {
				void input.rootBudget.deliverWrapUp(resolvedFrontierStage ?? "workflow frontier");
				throw input.rootBudget.finishWrapUp(resolvedFrontierStage, undefined, undefined, false);
			}
			if (rootCheck.kind === "exhausted")
				throw input.rootBudget.finishWrapUp(resolvedFrontierStage, undefined, undefined, false);
		}
		const check = ownCheckpoint(resolvedFrontierStage);
		if (check.kind === "wrap_up" || check.kind === "exhausted") {
			if (check.kind === "wrap_up") void deliverWrapUp(resolvedFrontierStage ?? "workflow frontier");
			throw finishWrapUp(resolvedFrontierStage, undefined, undefined, false);
		}
	};
	const rethrowIfSystemOwnedStop = (frontierStage?: string): void => {
		input.rootBudget?.rethrowIfSystemOwnedStop(frontierStage);
		if (state?.systemOwnedStop === true)
			throw finishWrapUp(frontierStage, state.wrapUpSummary, state.wrapUpUsage, state.wrapUpCompleted === true);
	};
	const registerWrapUp = (frontierStage: string, handler: () => Promise<never>): (() => void) => {
		if (!ownEnabled) return () => {};
		const registration = { frontierStage, handler };
		handlers.push(registration);
		return () => {
			const index = handlers.indexOf(registration);
			if (index >= 0) handlers.splice(index, 1);
		};
	};

	const deliverWrapUp = (frontierStage: string): Promise<never> => {
		if (wrapUpPromise !== undefined) return wrapUpPromise;
		if (rootWrapUpPending && input.rootBudget !== undefined) return input.rootBudget.deliverWrapUp(frontierStage);
		if (state?.systemOwnedStop === true && state.wrapUpCompleted !== true)
			throw finishWrapUp(frontierStage, undefined, undefined, false);
		const registration = handlers.findLast((entry) => entry.frontierStage === frontierStage) ?? handlers.at(-1);
		if (registration === undefined) throw finishWrapUp(frontierStage, undefined, undefined, false);
		wrapUpPromise = registration.handler();
		return wrapUpPromise;
	};
	const stopAtBoundaryAsync = async (frontierStage?: string): Promise<void> => {
		if (input.rootBudget?.enabled === true) await input.rootBudget.stopAtBoundaryAsync(frontierStage);
		const check = ownCheckpoint(frontierStage);
		if (check.kind === "continue" || check.kind === "warn") return;
		if (check.kind === "wrap_up") {
			await deliverWrapUp(frontierStage ?? "workflow frontier");
			return;
		}
		throw finishWrapUp(frontierStage, state?.wrapUpSummary, state?.wrapUpUsage, state?.wrapUpCompleted === true);
	};
	const awaitPendingWrapUp = async (): Promise<WorkflowBudgetExceededError | undefined> => {
		const rootError = await input.rootBudget?.awaitPendingWrapUp();
		if (rootError !== undefined) return rootError;
		if (wrapUpPromise === undefined) return undefined;
		try {
			await wrapUpPromise;
		} catch (error) {
			if (error instanceof WorkflowBudgetExceededError) return error;
			throw error;
		}
		return undefined;
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
		awaitPendingWrapUp,
	};
}
