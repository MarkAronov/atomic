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
	const root = input.rootBudget?.enabled === true ? input.rootBudget : undefined;
	const enabled = ownEnabled || root !== undefined;
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
	const boundaryCheckpoint = (
		frontierStage?: string,
	): { readonly check: BudgetCheckpoint; readonly owner?: RunBudgetController } => {
		const rootCheck = root?.checkpoint(frontierStage);
		if (rootCheck?.kind === "wrap_up") rootWrapUpPending = true;
		if (rootCheck?.kind === "wrap_up" || rootCheck?.kind === "exhausted") return { check: rootCheck, owner: root };
		return { check: ownCheckpoint(frontierStage) };
	};
	const checkpoint = (frontierStage?: string): BudgetCheckpoint => boundaryCheckpoint(frontierStage).check;
	const finishBoundary = (owner: RunBudgetController | undefined, frontierStage: string | undefined): never => {
		throw (
			owner?.finishWrapUp(frontierStage, undefined, undefined, false) ??
			finishWrapUp(frontierStage, undefined, undefined, false)
		);
	};
	const deliverBoundary = (owner: RunBudgetController | undefined, frontierStage: string): void => {
		void (owner?.deliverWrapUp(frontierStage) ?? deliverWrapUp(frontierStage));
	};
	const stopAtBoundary = (frontierStage?: string): void => {
		const resolvedFrontierStage = frontierStage ?? handlers.at(-1)?.frontierStage;
		const { check, owner } = boundaryCheckpoint(resolvedFrontierStage);
		if (check.kind === "wrap_up") {
			deliverBoundary(owner, resolvedFrontierStage ?? "workflow frontier");
			finishBoundary(owner, resolvedFrontierStage);
		}
		if (check.kind === "exhausted") finishBoundary(owner, resolvedFrontierStage);
	};
	const rethrowIfSystemOwnedStop = (frontierStage?: string): void => {
		root?.rethrowIfSystemOwnedStop(frontierStage);
		if (state?.systemOwnedStop === true)
			throw finishWrapUp(frontierStage, state.wrapUpSummary, state.wrapUpUsage, state.wrapUpCompleted === true);
	};
	const registerLocalWrapUp = (registration: {
		readonly frontierStage: string;
		readonly handler: () => Promise<never>;
	}): (() => void) => {
		handlers.push(registration);
		return () => {
			const index = handlers.indexOf(registration);
			if (index >= 0) handlers.splice(index, 1);
		};
	};
	const registerWrapUp = (frontierStage: string, handler: () => Promise<never>): (() => void) => {
		const registration = { frontierStage, handler };
		const unregisterOwn = ownEnabled ? registerLocalWrapUp(registration) : undefined;
		const unregisterRoot = root
			? root.registerWrapUp(frontierStage, async () => {
					try {
						return await handler();
					} catch (error) {
						if (!(error instanceof WorkflowBudgetExceededError)) throw error;
						throw root.finishWrapUp(
							error.report.frontierStage,
							error.report.wrapUpSummary,
							error.report.wrapUpUsage,
							error.report.wrapUpSummary !== undefined,
						);
					}
				})
			: undefined;
		return () => {
			unregisterOwn?.();
			unregisterRoot?.();
		};
	};

	const deliverWrapUp = (frontierStage: string): Promise<never> => {
		if (wrapUpPromise !== undefined) return wrapUpPromise;
		if (rootWrapUpPending && root !== undefined) return root.deliverWrapUp(frontierStage);
		if (state?.systemOwnedStop === true && state.wrapUpCompleted !== true)
			throw finishWrapUp(frontierStage, undefined, undefined, false);
		const registration = handlers.findLast((entry) => entry.frontierStage === frontierStage) ?? handlers.at(-1);
		if (registration === undefined) throw finishWrapUp(frontierStage, undefined, undefined, false);
		wrapUpPromise = registration.handler();
		return wrapUpPromise;
	};
	const stopAtBoundaryAsync = async (frontierStage?: string): Promise<void> => {
		if (root !== undefined) await root.stopAtBoundaryAsync(frontierStage);
		const check = ownCheckpoint(frontierStage);
		if (check.kind === "continue" || check.kind === "warn") return;
		if (check.kind === "wrap_up") {
			await deliverWrapUp(frontierStage ?? "workflow frontier");
			return;
		}
		throw finishWrapUp(frontierStage, state?.wrapUpSummary, state?.wrapUpUsage, state?.wrapUpCompleted === true);
	};
	const awaitPendingWrapUp = async (): Promise<WorkflowBudgetExceededError | undefined> => {
		const rootError = await root?.awaitPendingWrapUp();
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
