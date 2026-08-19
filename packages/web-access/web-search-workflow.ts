export type WebSearchWorkflow = "none" | "summary-review";
export type CuratorWorkflow = "summary-review";

export function resolveWorkflow(input: unknown, hasUI: boolean): WebSearchWorkflow {
	if (!hasUI) return "none";
	if (typeof input === "string" && input.trim().toLowerCase() === "summary-review") {
		return "summary-review";
	}
	return "none";
}
