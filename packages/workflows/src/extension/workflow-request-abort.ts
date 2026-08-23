export function raceWorkflowRequestAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (signal === undefined) return operation;
	if (signal.aborted) {
		void operation.catch(() => {});
		return Promise.reject(signal.reason ?? new DOMException("Workflow request aborted", "AbortError"));
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => reject(signal.reason ?? new DOMException("Workflow request aborted", "AbortError"));
		signal.addEventListener("abort", onAbort, { once: true });
		operation.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}
