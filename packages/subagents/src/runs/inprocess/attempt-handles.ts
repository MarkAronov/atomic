/**
 * In-process attempt handles for a top-level session's direct children.
 *
 * Delegation is one level deep, so this registry only ever holds a parent's own
 * children. A live child is addressed by its run id or canonical task path, and
 * interrupt/resume reach it through the handle registered when its attempt
 * started — never through a request file, a capability token, or a poller.
 */

export interface InProcessAttemptResumeOutcome {
	readonly status: "ok" | "error" | "interrupted" | "continued";
	readonly path: string;
	readonly sessionFile?: string;
	readonly envelope?: string;
}

export interface InProcessAttemptHandle {
	readonly runId: string;
	readonly path: string;
	readonly status: () => string;
	readonly interrupt: () => Promise<void>;
	readonly resume: (message: string) => Promise<InProcessAttemptResumeOutcome>;
}

export interface InProcessAttemptControlResult {
	readonly ok: boolean;
	readonly message: string;
	readonly outcome?: InProcessAttemptResumeOutcome;
}

const attemptHandles = new Map<string, Map<string, InProcessAttemptHandle>>();

function attemptKey(id: string): string {
	return id.trim();
}

export function registerInProcessAttempt(handle: InProcessAttemptHandle): () => void {
	const key = attemptKey(handle.runId);
	let handles = attemptHandles.get(key);
	if (!handles) {
		handles = new Map();
		attemptHandles.set(key, handles);
	}
	handles.set(handle.path, handle);
	const pathKey = attemptKey(handle.path);
	if (pathKey !== key) {
		let byPath = attemptHandles.get(pathKey);
		if (!byPath) {
			byPath = new Map();
			attemptHandles.set(pathKey, byPath);
		}
		byPath.set(handle.path, handle);
	}
	return () => {
		for (const lookupKey of [key, pathKey]) {
			const current = attemptHandles.get(lookupKey);
			if (!current || current.get(handle.path) !== handle) continue;
			current.delete(handle.path);
			if (current.size === 0) attemptHandles.delete(lookupKey);
		}
	};
}

function handlesFor(id: string): InProcessAttemptHandle[] {
	return [...(attemptHandles.get(attemptKey(id))?.values() ?? [])];
}

export async function interruptInProcessAttempt(targetId: string): Promise<InProcessAttemptControlResult | undefined> {
	const handles = handlesFor(targetId);
	if (handles.length === 0) return undefined;
	const active = handles.filter((handle) => handle.status() === "running" || handle.status() === "continued");
	if (active.length === 0) {
		return { ok: false, message: `Run ${targetId} has no active child attempt to interrupt.` };
	}
	await Promise.all(active.map((handle) => handle.interrupt()));
	return { ok: true, message: `Interrupt requested for run ${targetId}.` };
}

export async function resumeInProcessAttempt(
	targetId: string,
	message: string,
): Promise<InProcessAttemptControlResult | undefined> {
	const handles = handlesFor(targetId);
	if (handles.length === 0) return undefined;
	const handle =
		handles.find((candidate) => candidate.status() === "interrupted" || candidate.status() === "error") ?? handles[0];
	if (!handle) return undefined;
	if (handle.status() === "running" || handle.status() === "continued") {
		return { ok: false, message: `Run ${targetId} is still running; resume is not required.` };
	}
	const outcome = await handle.resume(message);
	return {
		ok: outcome.status === "ok" || outcome.status === "continued",
		message:
			outcome.status === "ok"
				? `Reloaded run ${targetId} through the in-process control plane.`
				: `Run ${targetId} resume ended with status '${outcome.status}'.`,
		outcome,
	};
}

export function clearInProcessAttemptHandles(): void {
	attemptHandles.clear();
}
