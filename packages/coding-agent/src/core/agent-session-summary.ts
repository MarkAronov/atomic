/**
 * Session summary generation for the resume picker.
 *
 * Runs once the agent goes idle, decides whether a fresh summary is worth generating, and
 * persists the result. Generation itself lives in core/compaction/session-summarization.ts.
 */

import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { generateSessionSummary } from "./compaction/index.ts";
import { getLastConversationMessageId, getLatestSessionSummary } from "./session-manager-entries.ts";

/** Sessions shorter than this are already legible from their first message. */
const MIN_ENTRIES_FOR_SUMMARY = 4;

export async function _maybeGenerateSessionSummary(this: AgentSession): Promise<void> {
	// Held rather than read from the session in `finally`, so an early return can never clear a
	// controller belonging to a different run.
	let controller: AbortController | undefined;
	try {
		// --- Bail-outs that cannot change while we wait ---------------------------------
		if (this._disposed) return;
		if (!this.settingsManager.getSessionSummarySettings().enabled) return;

		// One-shot scripted runs should not pay for a background call; the process may exit before
		// it lands. "tui" and "rpc" are the resumable, interactive modes.
		if (this._extensionMode === "print" || this._extensionMode === "json") return;

		const model = this.model;
		if (!model) return;

		// Workflow-stage sessions are excluded from /resume entirely.
		if (this.sessionManager.getHeader()?.internal) return;

		// Claim the launch before waiting, so a later turn supersedes this one while both are
		// parked below.
		const sessionSummaryToken = ++this._sessionSummaryToken;

		// `agent_end` fires while the agent still reports isStreaming, and that flag survives the
		// entire microtask queue — it only clears a macrotask later. Testing it here without
		// waiting made generation depend on whether `_checkCompaction` happened to cross a
		// macrotask boundary: green under test, silently skipped in the real TUI, and nothing
		// retries it.
		await this.agent.waitForIdle();

		if (this._disposed) return;
		if (this._sessionSummaryToken !== sessionSummaryToken) return;
		if (this.isStreaming || this.isCompacting) return;

		const branch = this.sessionManager.getBranch();
		if (branch.length < MIN_ENTRIES_FOR_SUMMARY) return;

		const throughId = getLastConversationMessageId(branch);
		if (!throughId) return;

		// On a resumed session the in-memory anchor starts empty, so fall back to the persisted
		// summary. Without this the first idle after every resume regenerates a summary that is
		// already current.
		const lastSummarized =
			this._lastSummarizedMessageId ??
			getLatestSessionSummary(this.sessionManager.getEntries())?.summarizedThroughId;
		if (throughId === lastSummarized) return;

		// Retire a request still in flight from an earlier turn, then take the controller. Abort
		// the previous one directly rather than via abortSessionSummary(), which bumps the token
		// and would invalidate the claim made above. The controller lives on the session so the
		// prompt, tree-navigation, and shutdown paths can reach it.
		this._sessionSummaryAbortController?.abort();
		controller = new AbortController();
		this._sessionSummaryAbortController = controller;
		const signal = controller.signal;

		const { apiKey, headers, baseUrl } = await this._getRequiredRequestAuth(model);

		// Disposal or a newer turn can land while credentials resolve; nothing past this point
		// should reach the provider.
		if (this._disposed || signal.aborted) return;
		if (this._sessionSummaryToken !== sessionSummaryToken) return;

		const result = await generateSessionSummary(branch, {
			model,
			apiKey,
			headers,
			baseUrl,
			signal,
			streamFn: this.agent.streamFunction,
			retry: this.settingsManager.getRetrySettings(),
		});
		// Failures stay silent: nothing awaits this, and the picker falls back on its own.
		if (result.aborted || result.error || !result.summary) return;

		// Disposal, cancellation, a newer run, or a newer message all mean this summary no longer
		// describes the session. The signal is checked directly as well as the token because a
		// provider that ignores the signal still returns an ordinary result.
		if (this._disposed) return;
		if (signal.aborted) return;
		if (this._sessionSummaryToken !== sessionSummaryToken) return;
		if (getLastConversationMessageId(this.sessionManager.getBranch()) !== throughId) return;

		this.sessionManager.appendSessionSummary(result.summary, throughId, result.usage);
		this._lastSummarizedMessageId = throughId;
	} catch {
		// Nothing awaits this call, so an escaping rejection would surface as an unhandled
		// rejection and can take the process down. Credential resolution throws outright when no
		// key is configured, which is an ordinary state for a session that never prompts.
	} finally {
		if (controller !== undefined && this._sessionSummaryAbortController === controller) {
			this._sessionSummaryAbortController = undefined;
		}
	}
}

export function abortSessionSummary(this: AgentSession): void {
	// Bump the token as well as aborting: a launch parked on waitForIdle() has no controller yet,
	// and would otherwise survive a prompt, a tree navigation, or disposal.
	this._sessionSummaryToken++;
	this._sessionSummaryAbortController?.abort();
	this._sessionSummaryAbortController = undefined;
}

export const agentSessionSummaryMethods = { _maybeGenerateSessionSummary, abortSessionSummary };
