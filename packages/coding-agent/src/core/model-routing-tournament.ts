/** FNV-1a with MurmurHash3's finalizer, so IDs that differ only in their last characters still spread apart. */
function seededHash(text: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	hash ^= hash >>> 16;
	hash = Math.imul(hash, 0x85ebca6b) >>> 0;
	hash ^= hash >>> 13;
	hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
	hash ^= hash >>> 16;
	return hash >>> 0;
}

/**
 * Candidate order seeded by the task, so the same task routes the same way on
 * every run while catalog order stops deciding which candidate a classifier
 * sees first.
 */
export function seededCandidateOrder<Group extends { readonly model: string }>(
	groups: readonly Group[],
	seed: string,
): Group[] {
	return groups
		.map((group) => ({ group, key: seededHash(`${seed}\n${group.model}`) }))
		.sort((a, b) => a.key - b.key || a.group.model.localeCompare(b.group.model))
		.map(({ group }) => group);
}

/**
 * Greedily pack groups, in order, into batches whose routing request fits.
 * A group that cannot fit even alone still gets its own batch; the request
 * builder then truncates only that batch's routing copy.
 */
export function packRoutingBatches<Group>(
	groups: readonly Group[],
	fits: (batch: readonly Group[]) => boolean,
): Group[][] {
	const batches: Group[][] = [];
	let current: Group[] = [];
	for (const group of groups) {
		const next = [...current, group];
		if (current.length > 0 && !fits(next)) {
			batches.push(current);
			current = [group];
		} else {
			current = next;
		}
	}
	if (current.length > 0) batches.push(current);
	return batches;
}
