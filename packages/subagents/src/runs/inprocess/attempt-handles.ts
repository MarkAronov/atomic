/** Live in-process attempt handles used only for separately supported interrupt control. */
export interface InProcessAttemptHandle {
	readonly runId: string;
	readonly path: string;
	readonly status: () => string;
	readonly interrupt: () => Promise<void>;
}

export interface InProcessAttemptControlResult {
	readonly ok: boolean;
	readonly message: string;
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

export function clearInProcessAttemptHandles(): void {
	attemptHandles.clear();
}
