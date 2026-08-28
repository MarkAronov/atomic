import type {
	AgentContext,
	AgentLoopConfig,
	AgentLoopTurnUpdate,
	PrepareNextTurnContext,
	ShouldStopAfterTurnContext,
} from "@earendil-works/pi-agent-core";

import { normalizeToolResultImages } from "../utils/tool-result-images.js";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { assertToolPairingInvariant } from "./context-tool-pairing.js";
import { redirectOversizedToolResult } from "./tools/oversized-tool-result.js";

interface LegacyAgentLoopConfigDoor {
	createLoopConfig(options?: { skipInitialSteeringPoll?: boolean }): AgentLoopConfig;
}

export function _installAgentToolHooks(this: AgentSession): void {
	this.agent.beforeToolCall = async ({ toolCall, args }) => {
		const runner = this._extensionRunner;
		if (!runner.hasHandlers("tool_call")) {
			return undefined;
		}

		await this._agentEventQueue;

		try {
			const result = await runner.emitToolCall({
				type: "tool_call",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				input: args as Record<string, unknown>,
			});
			if (result?.block && result.terminate === true) {
				this._terminatingToolCallIds.add(toolCall.id);
			} else {
				this._terminatingToolCallIds.delete(toolCall.id);
			}
			return result;
		} catch (err) {
			if (err instanceof Error) {
				throw err;
			}
			throw new Error(`Extension failed, blocking execution: ${String(err)}`);
		}
	};

	this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
		const runner = this._extensionRunner;
		const hookResult = runner.hasHandlers("tool_result")
			? await runner.emitToolResult({
					type: "tool_result",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: args as Record<string, unknown>,
					content: result.content,
					details: result.details,
					isError,
				})
			: undefined;

		const hookContent = hookResult?.content ?? result.content;
		// Run after extension hooks so extension-injected images enter history at provider-safe sizes.
		const normalizedContent = await normalizeToolResultImages(hookContent, {
			autoResizeImages: this.settingsManager.getImageAutoResize(),
		});
		const resultReplacement =
			hookResult || normalizedContent !== hookContent
				? {
						content: normalizedContent,
						details: hookResult?.details,
						isError: hookResult?.isError ?? isError,
					}
				: undefined;
		const finalResult = {
			content: normalizedContent,
			// Preserve original details when an extension hook rewrites only content;
			// the redirect check only replaces model-visible content blocks.
			details: hookResult?.details ?? result.details,
		};
		const finalIsError = hookResult?.isError ?? isError;
		const redirectReplacement = await redirectOversizedToolResult({
			toolName: toolCall.name,
			toolCallId: toolCall.id,
			result: finalResult,
			isError: finalIsError,
			sessionId: this.sessionManager.getSessionId(),
			sessionDir: this.sessionManager.getSessionDir() || undefined,
			maxResultSizeChars: this.getToolDefinition(toolCall.name)?.maxResultSizeChars,
		});

		if (result.terminate === true) this._terminatingToolCallIds.add(toolCall.id);
		else this._terminatingToolCallIds.delete(toolCall.id);
		return redirectReplacement ?? resultReplacement;
	};
}

/**
 * Install a prepareNextTurnWithContext hook so that extension tool changes
 * (e.g. setActiveTools) and before_agent_start systemPrompt overrides are
 * applied to the next provider request within the same run.
 */
export function _installAgentNextTurnRefresh(this: AgentSession): void {
	const previousPrepareNextTurnWithContext =
		this.agent.prepareNextTurnWithContext ??
		(this.agent.prepareNextTurn
			? async (_turn: PrepareNextTurnContext, signal?: AbortSignal) => await this.agent.prepareNextTurn?.(signal)
			: undefined);
	// pi-agent-core 0.84.3 invokes preparation before its stop hook. Run the
	// captured stop hook here, then replay that result when the dependency asks.

	const previousShouldStopAfterTurn = this.agent.shouldStopAfterTurn;
	let pendingStopResult:
		| {
				message: PrepareNextTurnContext["message"];
				toolResults: PrepareNextTurnContext["toolResults"];
				newMessages: PrepareNextTurnContext["newMessages"];
				shouldStop: boolean;
		  }
		| undefined;
	const pendingStopMatches = (turn: ShouldStopAfterTurnContext): boolean => {
		const pending = pendingStopResult;
		return (
			pending?.message === turn.message &&
			pending.toolResults === turn.toolResults &&
			pending.newMessages === turn.newMessages
		);
	};
	const clearPendingStopResult = (turn: ShouldStopAfterTurnContext): void => {
		if (pendingStopMatches(turn)) pendingStopResult = undefined;
	};

	// The dependency consumes a matching completed-turn result once. Unrelated
	// public stop checks delegate without invalidating that pending handoff.
	this.agent.shouldStopAfterTurn = async (turn, signal) => {
		const pending = pendingStopResult;
		if (pending && pendingStopMatches(turn)) {
			pendingStopResult = undefined;
			return pending.shouldStop;
		}
		return (await previousShouldStopAfterTurn?.(turn, signal)) ?? false;
	};

	const cacheStopResult = async (turn: ShouldStopAfterTurnContext, signal?: AbortSignal): Promise<boolean> => {
		const shouldStop = (await previousShouldStopAfterTurn?.(turn, signal)) ?? false;
		pendingStopResult = {
			message: turn.message,
			toolResults: turn.toolResults,
			newMessages: turn.newMessages,
			shouldStop,
		};
		return shouldStop;
	};

	const previousTransformContext = this.agent.transformContext;
	this.agent.transformContext = async (messages, signal) => {
		const transformed = previousTransformContext ? await previousTransformContext(messages, signal) : messages;
		const guarded = this._finishPostToolCompactionPreflight(transformed);
		// Last checkpoint before provider conversion: a structurally invalid context
		// here becomes an unrecoverable provider 400, so surface it as an Atomic error.
		assertToolPairingInvariant(guarded);
		return guarded;
	};

	const prepareTurn = async (turn: PrepareNextTurnContext, signal?: AbortSignal): Promise<AgentLoopTurnUpdate> => {
		const compactedMessages =
			turn.toolResults.length > 0
				? await this._preflightPostToolContext(turn.context.messages, signal)
				: turn.context.messages;
		const compactedContext =
			compactedMessages === turn.context.messages ? turn.context : { ...turn.context, messages: compactedMessages };
		const preparedTurn = compactedContext === turn.context ? turn : { ...turn, context: compactedContext };
		const previousSnapshot = await previousPrepareNextTurnWithContext?.(preparedTurn, signal);
		const previousContext = previousSnapshot?.context ?? compactedContext;

		return {
			...previousSnapshot,
			context: {
				...previousContext,
				messages: previousContext.messages,
				systemPrompt: this._systemPromptOverride ?? this._baseSystemPrompt,
				tools: this.agent.state.tools.slice(),
			},
			model: this.agent.state.model,
			thinkingLevel: this.agent.state.thinkingLevel,
		};
	};

	let deferredPreparation:
		| {
				turn: PrepareNextTurnContext;
				signal?: AbortSignal;
				loopContext: AgentContext;
		  }
		| undefined;

	const prepareDeferredTurn = async (loopConfig: AgentLoopConfig): Promise<void> => {
		const deferred = deferredPreparation;
		if (!deferred) return;
		// Queue polls are serial in pi-agent-core. Clear first so a failing callback
		// cannot be retried by a later poll in the same run.
		deferredPreparation = undefined;
		const snapshot = await prepareTurn(deferred.turn, deferred.signal);
		const nextContext = snapshot.context ?? deferred.turn.context;
		deferred.loopContext.systemPrompt = nextContext.systemPrompt;
		deferred.loopContext.messages = nextContext.messages;
		deferred.loopContext.tools = nextContext.tools;
		loopConfig.model = snapshot.model ?? loopConfig.model;
		loopConfig.reasoning =
			snapshot.thinkingLevel === undefined
				? loopConfig.reasoning
				: snapshot.thinkingLevel === "off"
					? undefined
					: snapshot.thinkingLevel;
	};

	// pi-agent-core 0.84.3 polls these queues after its premature preparation
	// callback. Intercept the poll itself: a non-empty result is the first point
	// at which a final or terminating turn is known to continue. The regular
	// function deliberately receives the loop's current copied config as `this`.
	const agentLoopDoor = this.agent as unknown as LegacyAgentLoopConfigDoor;
	const previousCreateLoopConfig = agentLoopDoor.createLoopConfig.bind(this.agent);
	agentLoopDoor.createLoopConfig = (options) => {
		deferredPreparation = undefined;
		const loopConfig = previousCreateLoopConfig(options);
		const wrapQueuePoll = (
			poll: AgentLoopConfig["getSteeringMessages"] | AgentLoopConfig["getFollowUpMessages"],
		): NonNullable<AgentLoopConfig["getSteeringMessages"]> =>
			async function (this: AgentLoopConfig) {
				const messages = (await poll?.()) ?? [];
				if (messages.length > 0) await prepareDeferredTurn(this);
				return messages;
			};
		loopConfig.getSteeringMessages = wrapQueuePoll(loopConfig.getSteeringMessages);
		loopConfig.getFollowUpMessages = wrapQueuePoll(loopConfig.getFollowUpMessages);
		return loopConfig;
	};

	this.agent.prepareNextTurnWithContext = async (turn, signal) => {
		const toolCallIds = turn.message.content.filter((part) => part.type === "toolCall").map((part) => part.id);
		const terminatingBatch =
			toolCallIds.length > 0 && toolCallIds.every((id) => this._terminatingToolCallIds.has(id));
		for (const id of toolCallIds) this._terminatingToolCallIds.delete(id);

		const shouldStop = await cacheStopResult(turn, signal);
		try {
			if (shouldStop) {
				deferredPreparation = undefined;
				await settleFallbackAfterTurn(this, turn, terminatingBatch);
				return undefined;
			}

			if (turn.toolResults.length > 0 && !terminatingBatch) {
				deferredPreparation = undefined;
				const snapshot = await prepareTurn(turn, signal);
				await settleFallbackAfterTurn(this, turn, terminatingBatch);
				return snapshot;
			}

			await settleFallbackAfterTurn(this, turn, terminatingBatch);
			const loopContext: AgentContext = {
				...turn.context,
				messages: turn.context.messages.slice(),
				tools: turn.context.tools?.slice(),
			};
			deferredPreparation = { turn, signal, loopContext };
			// Returning a placeholder moves the stale loop away from the completed
			// context without running user preparation. If a queue poll yields work,
			// the poll door replaces its fields before that message is injected.
			return { context: loopContext };
		} catch (error) {
			// The pinned loop cannot consume its cached stop decision when its
			// premature preparation rejects. Remove only this turn's handoff; an
			// asynchronously superseding turn remains authoritative.
			clearPendingStopResult(turn);
			throw error;
		}
	};
}

async function settleFallbackAfterTurn(
	session: AgentSession,
	turn: PrepareNextTurnContext,
	terminatingBatch: boolean,
): Promise<void> {
	// Settle before queued follow-up messages are polled, but keep the fallback
	// lifecycle open for deceptive completions that event processing must retry
	// on the same model (safety refusal, empty completion, or length truncation).
	const preserveFallbackForFailure =
		turn.message.role === "assistant" &&
		!session.agent.hasQueuedMessages() &&
		(turn.message.stopReason === "length" ||
			session._isEmptyCompletion?.(turn.message) === true ||
			session._isSafetyRefusal?.(turn.message) === true);
	if (!preserveFallbackForFailure && (turn.toolResults.length === 0 || terminatingBatch)) {
		await session._agentEventQueue;
		await session._settleFallbackModelScope();
	}
}

export const agentSessionToolHooksMethods = {
	_installAgentToolHooks,
	_installAgentNextTurnRefresh,
};
