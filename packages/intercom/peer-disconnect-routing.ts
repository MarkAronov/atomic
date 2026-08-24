export interface PeerDisconnectWaiter {
	from: string;
	replyTo: string;
	reject(error: Error): void;
}

export interface PeerDisconnectNotice {
	replyTo: string;
	peerSessionId: string;
	peerName?: string;
}

/** Rejects only the exact departed-peer/thread pair for a blocking tool waiter. */
export function routePeerDisconnect(
	waiter: PeerDisconnectWaiter | null | undefined,
	notice: PeerDisconnectNotice,
): boolean {
	if (!waiter) return false;
	const peerTarget = notice.peerName || notice.peerSessionId;
	const peerMatches =
		peerTarget.toLowerCase() === waiter.from.toLowerCase() || notice.peerSessionId === waiter.from;
	if (!peerMatches || notice.replyTo !== waiter.replyTo) return false;
	waiter.reject(new Error(`Session "${notice.peerName ?? notice.peerSessionId}" disconnected before replying`));
	return true;
}
