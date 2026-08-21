/**
 * Idle deadline for provider response streams (#2553).
 *
 * The HTTP layer only bounds the request/response handshake and, for SDK clients,
 * the socket idle timeout its dispatcher enforces. A body that decodes into a
 * decompression failure can destroy the underlying stream without ever rejecting
 * the async iterator the adapter is awaiting, so `for await (...)` stays pending
 * forever, the adapter's promise never settles, and retry/model-fallback logic
 * never advances. GitHub Copilot with the default `transport: "auto"` reproduces
 * this as a repeated `Library error: zlib error: incorrect header check`.
 *
 * {@link withStreamDeadline} bounds the gap *between* stream events, below the
 * HTTP layer, so a stalled stream always settles as a transient transport error
 * that {@link isRetryableAssistantError} classifies as retryable.
 */

/**
 * Default idle gap allowed between two provider stream events, in milliseconds.
 *
 * Deliberately below the 600000 ms default HTTP idle timeout so a stalled stream
 * is cut by this deadline rather than waiting on the transport, while staying
 * generous enough for slow reasoning models that go quiet between events.
 */
export const DEFAULT_STREAM_DEADLINE_MS = 300_000;

/** Message text used when a stream exceeds its idle deadline. */
export function streamDeadlineErrorMessage(deadlineMs: number): string {
	return `Provider stream timed out after ${deadlineMs}ms without a new event (stream deadline exceeded)`;
}

/**
 * Raised when a provider stream produces no event within its idle deadline.
 *
 * The message intentionally carries transport-timeout wording so the shared
 * transient-error classifier treats it as a retryable transport failure.
 */
export class StreamDeadlineError extends Error {
	readonly deadlineMs: number;

	constructor(deadlineMs: number) {
		super(streamDeadlineErrorMessage(deadlineMs));
		this.name = "StreamDeadlineError";
		this.deadlineMs = deadlineMs;
	}
}

/**
 * Resolve the effective idle deadline for a stream.
 *
 * `undefined` selects {@link DEFAULT_STREAM_DEADLINE_MS}. A non-positive or
 * non-finite value disables the deadline and returns `undefined`, matching how
 * `httpIdleTimeoutMs` and `websocketConnectTimeoutMs` treat `0`/`"disabled"`.
 */
export function resolveStreamDeadlineMs(value: number | undefined): number | undefined {
	if (value === undefined) return DEFAULT_STREAM_DEADLINE_MS;
	if (!Number.isFinite(value) || value <= 0) return undefined;
	return Math.floor(value);
}

/**
 * Wrap an async iterable so each pending `next()` is bounded by an idle deadline.
 *
 * The timer is restarted per event, so it caps the gap between events rather than
 * total stream duration: a long but progressing stream is never cut. When the
 * deadline expires the wrapper throws {@link StreamDeadlineError} and closes the
 * source iterator, which aborts the underlying request for SDK and fetch streams
 * alike, so the adapter's `catch` settles the attempt instead of hanging.
 *
 * A deadline of `undefined` delegates straight to the source and adds no timer.
 */
export async function* withStreamDeadline<T>(
	source: AsyncIterable<T>,
	deadlineMs: number | undefined,
): AsyncGenerator<T, void, undefined> {
	if (deadlineMs === undefined) {
		yield* source;
		return;
	}

	const iterator = source[Symbol.asyncIterator]();
	let closed = false;
	// Close the source without awaiting: a stream that stalled in `next()` can
	// stall in `return()` too, and the deadline must stay bounded either way.
	const closeSource = (): void => {
		if (closed) return;
		closed = true;
		try {
			void Promise.resolve(iterator.return?.()).catch(() => {});
		} catch {
			// A source iterator without a usable `return` needs no cleanup.
		}
	};

	try {
		for (;;) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const pending = iterator.next();
			const deadline = new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new StreamDeadlineError(deadlineMs)), deadlineMs);
			});

			let result: IteratorResult<T>;
			try {
				result = await Promise.race([pending, deadline]);
			} catch (error) {
				// The abandoned `next()` may settle later; swallow it so a losing
				// rejection never surfaces as an unhandled rejection.
				void pending.catch(() => {});
				closeSource();
				throw error;
			} finally {
				if (timer !== undefined) clearTimeout(timer);
			}

			if (result.done) {
				closed = true;
				return;
			}
			yield result.value;
		}
	} finally {
		closeSource();
	}
}
