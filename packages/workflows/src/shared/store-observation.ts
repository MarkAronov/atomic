import type { Store } from "./store-public-types.js";
import type { StoreSnapshot } from "./store-types.js";

export function readGraphStoreSnapshot(store: Store): StoreSnapshot {
	return typeof store.graphSnapshot === "function" ? store.graphSnapshot() : store.snapshot();
}

export function subscribeStoreInvalidation(store: Store, listener: () => void): () => void {
	return typeof store.subscribeInvalidation === "function"
		? store.subscribeInvalidation(listener)
		: store.subscribe(listener);
}
