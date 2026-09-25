import { jsonBytes, TRUNCATED_MARKER } from "./model-routing-bytes.js";

/**
 * The router's copy of the task is bounded so a very long task still fits a
 * classifier router such as Jev (32k tokens). Everything else in a routing
 * request is small and fixed in size, so the task gets most of the request.
 * Count JSON-encoded UTF-8 bytes, including escapes, not JS characters.
 */
export const MODEL_ROUTING_TASK_BYTES = 50_000;
const notice = "[Model-routing excerpt. Truncated text remains in the execution task.]\n";
type Range = { start: number; end: number };

function protectedRanges(task: string): Range[] {
	const ranges: Range[] = [];
	let depth = 0;
	let start = 0;
	for (const match of task.matchAll(/<\/?keepContext>/gi)) {
		if (match[0][1] !== "/") {
			if (depth++ === 0) start = match.index;
		} else if (depth > 0 && --depth === 0) {
			ranges.push({ start, end: match.index + match[0].length });
		}
	}
	// An unclosed protected span protects through the end rather than losing it.
	if (depth > 0) ranges.push({ start, end: task.length });
	return ranges;
}

// Never split a UTF-16 surrogate pair at an excerpt boundary.
function boundary(task: string, index: number, direction: -1 | 1): number {
	const before = task.charCodeAt(index - 1);
	const after = task.charCodeAt(index);
	return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff ? index + direction : index;
}

/** Keep equal-length head and tail that fit, marking the cut between them. */
function truncateMiddleToBytes(text: string, maxBytes: number): string {
	if (jsonBytes(text) <= maxBytes) return text;
	if (jsonBytes(TRUNCATED_MARKER) > maxBytes) return "";
	const cut = (edge: number) =>
		`${text.slice(0, boundary(text, edge, -1))}${TRUNCATED_MARKER}${text.slice(boundary(text, text.length - edge, 1))}`;
	let low = 0;
	let high = Math.floor(text.length / 2);
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (jsonBytes(cut(middle)) <= maxBytes) low = middle;
		else high = middle - 1;
	}
	return cut(low);
}

/** Bound only the model selector's copy. Execution and hard constraints stay intact. */
export function modelRoutingTask(task: string, maxBytes = MODEL_ROUTING_TASK_BYTES): string {
	const fits = (text: string) => jsonBytes(text) <= maxBytes;
	if (fits(task)) return task;
	const protectedSpans = protectedRanges(task);
	const excerpt = (edgeChars: number): string => {
		const ranges = [
			{ start: 0, end: boundary(task, edgeChars, -1) },
			...protectedSpans,
			{ start: boundary(task, task.length - edgeChars, 1), end: task.length },
		];
		const parts = [notice];
		let end = 0;
		for (const range of ranges) {
			if (range.end <= end) continue;
			if (range.start > end) parts.push(TRUNCATED_MARKER);
			parts.push(task.slice(Math.max(end, range.start), range.end));
			end = range.end;
		}
		if (end < task.length) parts.push(TRUNCATED_MARKER);
		return parts.join("");
	};
	let result = excerpt(0);
	// Protected spans that alone exceed the budget are cut too, from the middle of
	// the task so its opening and closing objective both reach the router. The
	// execution task keeps every span.
	if (!fits(result)) return `${notice}${truncateMiddleToBytes(task, maxBytes - (jsonBytes(notice) - 2))}`;
	let low = 0;
	let high = Math.min(Math.floor(task.length / 2), maxBytes);
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		const candidate = excerpt(middle);
		if (fits(candidate)) {
			result = candidate;
			low = middle;
		} else {
			high = middle - 1;
		}
	}
	return result;
}
