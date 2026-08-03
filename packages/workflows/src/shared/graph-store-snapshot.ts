import type {
	PendingPrompt,
	RunSnapshot,
	StageInputRequest,
	StageSnapshot,
	StoreSnapshot,
	ToolEvent,
	ToolNodeSnapshot,
	WorkflowChildReplaySnapshot,
	WorkflowNotice,
} from "./store-types.js";
import type { WorkflowOutputValues, WorkflowSerializableValue } from "./types.js";

export const COMPACT_RESULT_FIELD_LIMIT = 1024;

/**
 * V8 backs `slice()` of a flat string of 13 characters or more with a
 * SlicedString that points at its parent, so a 1 KiB projection of a
 * multi-megabyte run result would keep the whole result alive for as long as
 * the projection lives — and `graphSnapshot()` memoizes projections, so the
 * store would outlive the run it dropped. `split("").join("")` copies the
 * characters into a fresh flat string with no parent pointer.
 */
function flattenTruncatedField(value: string): string {
	return value.split("").join("");
}

function compactResultField(value: WorkflowSerializableValue | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	if (value.length <= COMPACT_RESULT_FIELD_LIMIT) return value;
	return flattenTruncatedField(value.slice(0, COMPACT_RESULT_FIELD_LIMIT));
}

function compactRunResult(result: WorkflowOutputValues | undefined): WorkflowOutputValues | undefined {
	if (result === undefined) return undefined;
	const status = compactResultField(result.status);
	const summary = compactResultField(result.summary);
	const remainingWork = compactResultField(result.remaining_work);
	const resultText = compactResultField(result.result);
	const compact: WorkflowOutputValues = {
		...(status !== undefined ? { status } : {}),
		...(summary !== undefined ? { summary } : {}),
		...(remainingWork !== undefined ? { remaining_work: remainingWork } : {}),
		...(resultText !== undefined ? { result: resultText } : {}),
	};
	return Object.keys(compact).length === 0 ? undefined : compact;
}

function clonePrompt(prompt: PendingPrompt | undefined): PendingPrompt | undefined {
	if (prompt === undefined) return undefined;
	return {
		...prompt,
		...(prompt.choices !== undefined ? { choices: [...prompt.choices] } : {}),
	};
}

function cloneInputRequest(request: StageInputRequest | undefined): StageInputRequest | undefined {
	if (request === undefined) return undefined;
	return {
		...request,
		questions: request.questions.map((question) => ({
			...question,
			options: question.options.map((option) => ({ ...option })),
		})),
	};
}

function compactToolEvents(events: readonly ToolEvent[]): ToolEvent[] {
	const event = events.at(-1);
	return event === undefined ? [] : [{ name: event.name }];
}

function compactWorkflowChild(child: WorkflowChildReplaySnapshot): WorkflowChildReplaySnapshot {
	return {
		...child,
		outputs: {},
		outputCount: child.outputCount ?? Object.keys(child.outputs).length,
	};
}

function compactStage(stage: StageSnapshot): StageSnapshot {
	const {
		toolEvents,
		workflowChild,
		workflowChildRun,
		pendingPrompt,
		promptFootprint,
		inputRequest,
		notices,
		mcpScope: _mcpScope,
		attemptedModels: _attemptedModels,
		modelAttempts: _modelAttempts,
		// Agent-stage results can be unbounded and graph cards do not render
		// them. Durable tool cards use ToolNodeSnapshot.resultSummary instead.
		result: _result,
		...metadata
	} = stage;
	return {
		...metadata,
		parentIds: [...stage.parentIds],
		toolEvents: compactToolEvents(toolEvents),
		...(workflowChild !== undefined ? { workflowChild: compactWorkflowChild(workflowChild) } : {}),
		...(workflowChildRun !== undefined ? { workflowChildRun: { ...workflowChildRun } } : {}),
		...(pendingPrompt !== undefined ? { pendingPrompt: clonePrompt(pendingPrompt) } : {}),
		...(promptFootprint !== undefined ? { promptFootprint: clonePrompt(promptFootprint) } : {}),
		...(inputRequest !== undefined ? { inputRequest: cloneInputRequest(inputRequest) } : {}),
		...(notices !== undefined ? { notices: notices.map((notice) => ({ ...notice })) } : {}),
	};
}

function compactToolNode(node: ToolNodeSnapshot): ToolNodeSnapshot {
	return { ...node, parentIds: [...node.parentIds] };
}

function compactRun(run: RunSnapshot): RunSnapshot {
	const { inputs: _inputs, result: sourceResult, stages, toolNodes, pendingPrompt, ...metadata } = run;
	const result = compactRunResult(sourceResult);
	return {
		...metadata,
		inputs: {},
		stages: stages.map(compactStage),
		...(toolNodes !== undefined ? { toolNodes: toolNodes.map(compactToolNode) } : {}),
		...(pendingPrompt !== undefined ? { pendingPrompt: clonePrompt(pendingPrompt) } : {}),
		...(result !== undefined ? { result } : {}),
	};
}

export function createGraphStoreSnapshot(
	runs: readonly RunSnapshot[],
	notices: readonly WorkflowNotice[],
	version: number,
): StoreSnapshot {
	const snapshot: StoreSnapshot = {
		runs: runs.map(compactRun),
		notices: notices.map((notice) => ({ ...notice })),
		version,
	};
	deepFreezeGraphValue(snapshot);
	return snapshot;
}

function deepFreezeGraphValue(value: unknown): void {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
	Object.freeze(value);
	if (Array.isArray(value)) {
		for (const item of value) deepFreezeGraphValue(item);
		return;
	}
	for (const key of Object.keys(value as Record<string, unknown>)) {
		deepFreezeGraphValue((value as Record<string, unknown>)[key]);
	}
}
