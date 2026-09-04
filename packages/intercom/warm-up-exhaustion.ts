/**
 * Terminal outcome of the bounded workflow-stage warm-up retry.
 *
 * The wrapper owns recovery for a stage warm-up that lost the broker, but that
 * ownership is bounded. When the attempts run out nothing is left to reconnect,
 * and a stage holding queued messages would otherwise wait forever on
 * `pendingStageDelivery.ready()`. This error is what the wrapper hands to the
 * delivery owner instead: it is a typed reason, not a console diagnostic, so no
 * raw extension text reaches the host transcript and the stage decides its own
 * outcome.
 *
 * Wording is deliberately free of the tokens the host's model-fallback and
 * workflow-failure classifiers read (`network`, `timeout`, `connection error`,
 * `cancel`, `abort`, `terminated`, and the rest), so the stage failure it
 * produces stays an unknown, non-retryable, terminal decision.
 */
export class IntercomWarmUpExhaustedError extends Error {
	readonly attempts: number;

	constructor(attempts: number, options?: ErrorOptions) {
		super(`Intercom could not reach the broker after ${attempts} warm-up attempts.`, options);
		this.name = "IntercomWarmUpExhaustedError";
		this.attempts = attempts;
	}
}
