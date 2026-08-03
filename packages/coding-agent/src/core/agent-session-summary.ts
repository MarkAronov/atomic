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
	// --- Bail-outs, cheapest first ------------------------------------------------------
	if (!this.settingsManager.getSessionSummarySettings().enabled) return;

	// One-shot scripted runs should not pay for a background call; the process may exit before
	// it lands. "tui" and "rpc" are the resumable, interactive modes.
	if (this._extensionMode === "print" || this._extensionMode === "json") return;

	if (this.isStreaming || this.isCompacting) return;
	const model = this.model;
	if (!model) return;

	// Workflow-stage sessions are excluded from /resume entirely.
	if (this.sessionManager.getHeader()?.internal) return;

	const branch = this.sessionManager.getBranch();
	if (branch.length < MIN_ENTRIES_FOR_SUMMARY) return;

	const throughId = getLastConversationMessageId(branch);
	if (!throughId) return;

	// On a resumed session the in-memory anchor starts empty, so fall back to the persisted
	// summary. Without this the first idle after every resume regenerates a summary that is
	// already current.
	const lastSummarized =
		this._lastSummarizedMessageId ?? getLatestSessionSummary(this.sessionManager.getEntries())?.summarizedThroughId;
	if (throughId === lastSummarized) return;

	// Claim the run. The token answers "is this still the current attempt, and is this state
	// still mine to touch?" after the awaits below; the controller lives on the session so
	// abortSessionSummary() can reach it from the prompt and shutdown paths.
	this.abortSessionSummary();
	const sessionSummaryToken = ++this._sessionSummaryToken;
	this._sessionSummaryAbortController = new AbortController();
	const signal = this._sessionSummaryAbortController.signal;

	try {
		const { apiKey, headers, baseUrl } = await this._getRequiredRequestAuth(model);
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

		// Cancellation, a newer run, or a newer message all mean this summary no longer describes
		// the session. The signal is checked directly because abortSessionSummary() does not bump
		// the token, and a provider that ignores the signal still returns an ordinary result.
		if (signal.aborted) return;
		if (this._sessionSummaryToken !== sessionSummaryToken) return;
		if (getLastConversationMessageId(this.sessionManager.getBranch()) !== throughId) return;

		this.sessionManager.appendSessionSummary(result.summary, throughId, result.usage);
		this._lastSummarizedMessageId = throughId;
	} catch {
		// Nothing awaits this call, so an escaping rejection would surface as an unhandled
		// rejection and can take the process down. Credential resolution throws outright when
		// no key is configured, which is an ordinary state for a session that never prompts.
	} finally {
		if (this._sessionSummaryToken === sessionSummaryToken) {
			this._sessionSummaryAbortController = undefined;
		}
	}
}

export function abortSessionSummary(this: AgentSession): void {
	this._sessionSummaryAbortController?.abort();
}

export const agentSessionSummaryMethods = { _maybeGenerateSessionSummary, abortSessionSummary };
