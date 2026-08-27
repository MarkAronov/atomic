import {
	depositStageInboxEntry,
	markStageInboxEntryDelivered,
	markStageInboxEntryUndeliverable,
	peekStageInbox,
	type StageInboxDeposit,
	type StageInboxDepositResult,
	type StageInboxEntry,
} from "./stage-inbox.js";
import type { StoreContext } from "./store-internal.js";
import type { Store } from "./store-public-types.js";

type StageInboxStoreMethods = Pick<
	Store,
	"depositStageInboxEntry" | "peekStageInbox" | "markStageInboxEntryDelivered" | "markStageInboxEntryUndeliverable"
>;

export function createStageInboxStoreMethods(context: StoreContext): StageInboxStoreMethods {
	return {
		depositStageInboxEntry(
			deposit: StageInboxDeposit,
			depositingGroup: string | undefined,
			runGroup: string | undefined,
		): StageInboxDepositResult | undefined {
			const run = context.findRun(deposit.runId);
			if (run === undefined) return undefined;
			const result = depositStageInboxEntry(run.stageInbox ?? [], deposit, depositingGroup, runGroup);
			if (result.ok && !result.deduplicated) {
				run.stageInbox = [...result.inbox];
				context.bumpAndNotify();
			}
			return result;
		},

		peekStageInbox(runId: string, stageKey: string): readonly StageInboxEntry[] {
			const run = context.findRun(runId);
			return peekStageInbox(run?.stageInbox ?? [], runId, stageKey);
		},

		markStageInboxEntryDelivered(runId: string, stageKey: string, messageId: string, deliveredAt: string): boolean {
			const run = context.findRun(runId);
			if (run === undefined) return false;
			const current = run.stageInbox ?? [];
			const next = markStageInboxEntryDelivered(current, runId, stageKey, messageId, deliveredAt);
			if (next === current) return false;
			run.stageInbox = [...next];
			context.bumpAndNotify();
			return true;
		},

		markStageInboxEntryUndeliverable(runId: string, stageKey: string, messageId: string, reason: string): boolean {
			const run = context.findRun(runId);
			if (run === undefined) return false;
			const current = run.stageInbox ?? [];
			const next = markStageInboxEntryUndeliverable(current, runId, stageKey, messageId, reason);
			if (next === current) return false;
			run.stageInbox = [...next];
			context.bumpAndNotify();
			return true;
		},
	};
}
