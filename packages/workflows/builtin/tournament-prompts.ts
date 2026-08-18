type PromptSection = readonly [tag: string, content: string];

const GROUNDED_REPORTING = "Before reporting progress, audit each claim against a tool result from this session. Report only work you can point to evidence for; say so explicitly when something is unverified.";
const READABLE_REPORT = "Lead with the outcome. Keep facts, decisions, caveats, and next steps; drop background and repetition. Use complete, readable sentences rather than compressed fragments.";

/** The default three-criterion decomposition of the tournament rubric. */
export const DEFAULT_TOURNAMENT_CRITERIA = [
	{ name: "Correctness", description: "Satisfies the task without material errors." },
	{ name: "Completeness", description: "Covers required outcomes and important edge cases." },
	{
		name: "Evidence and task fit",
		description: "Supports claims with observable evidence or checks and is directly usable without irrelevant work.",
	},
] as const;

function taggedPrompt(sections: readonly PromptSection[]): string {
	return sections
		.map(([tag, content]) => `<${tag}>\n${content.trim()}\n</${tag}>`)
		.join("\n\n");
}

export function renderTournamentAttemptPrompt(task: string, attempt: number): string {
	return taggedPrompt([
		["role", "You are an independent solution author competing on solution quality."],
		["attempt", `Produce attempt ${attempt} without assuming another attempt's approach or conclusions.`],
		["success_criteria", "A judge can evaluate this artifact directly against correctness, completeness, evidence, and task fit."],
		["requirements", [
			"Deliver a complete, self-contained solution rather than commentary about how to solve it.",
			"Ground important claims in observable evidence or executable checks.",
			"State assumptions, limitations, and validation performed.",
			"Optimize for correctness and usefulness, not length.",
			GROUNDED_REPORTING,
		].join("\n")],
		["stop_rules", "Stop when the solution is complete, supported, validated where practical, and its residual risks are stated."],
		["output_format", `Markdown with Solution, Evidence and validation, Assumptions, and Residual risks. ${READABLE_REPORT}`],
		["objective", task],
	]);
}

export function renderComparisonsReducerPrompt(options: {
	readonly task: string;
	readonly comparisonsPath: string;
	readonly ranking: readonly { readonly label: string; readonly meanPreference: number }[];
	readonly winnerLabel: string;
	readonly winnerPath: string;
}): string {
	const rankingText = options.ranking
		.map((entry, index) => `${index + 1}. ${entry.label} (mean preference ${entry.meanPreference})`)
		.join("\n");
	return taggedPrompt([
		["artifacts", [
			`Comparisons ledger: ${options.comparisonsPath}`,
			`Winning artifact (${options.winnerLabel}): ${options.winnerPath}`,
			"Read the ledger and winning artifact before reporting.",
		].join("\n")],
		["role", "You are the soft-scored tournament reducer and final reporter."],
		["ranking", rankingText],
		["requirements", [
			"Return the winning solution faithfully; do not silently combine losing material into it.",
			"Report the full ranking exactly as recorded in the comparisons ledger.",
			"Identify notable score disagreements, invalid reports, or other limitations recorded by judges.",
			"Cite the comparisons ledger and winning artifact paths.",
			GROUNDED_REPORTING,
		].join("\n")],
		["success_criteria", "A reader can use the winning solution and recompute the ranking from the durable comparisons ledger."],
		["stop_rules", "Stop after faithfully presenting the winner, full ranking, decision evidence, and residual risks."],
		["output_format", `Markdown with Winner, Full ranking, Decision trail, Evidence, Notable disagreements, and Residual risks. ${READABLE_REPORT}`],
		["objective", options.task],
	]);
}
