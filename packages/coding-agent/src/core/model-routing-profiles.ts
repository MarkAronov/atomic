import { candidateEvidenceRows, type EvalsCatalog } from "./model-routing-evals.js";

/** What the profile builder needs to know about one eligible model. */
export interface ProfileCandidate {
	/** `provider/id`, the same string the router's candidates use. */
	readonly model: string;
	readonly name: string;
	readonly cost: { readonly input: number; readonly output: number };
	readonly input: readonly string[];
	readonly contextWindow: number;
	/** Reasoning efforts the model accepts; `null` alone means no configurable reasoning. */
	readonly efforts: readonly (string | null)[];
}

interface Metric {
	/** Section kind plus column (or published benchmark code) in evals.md. */
	readonly key: string;
	readonly label: string;
	readonly unit: "%" | "pts";
}

interface Area {
	readonly name: string;
	readonly metrics: readonly Metric[];
}

const percent = (key: string, label: string): Metric => ({ key, label, unit: "%" });
const points = (key: string, label: string): Metric => ({ key, label, unit: "pts" });

/**
 * Capability areas the router can match a task against directly, each backed by
 * the evals.md columns that measure it. Listing order within an area is the
 * order values are quoted in a profile.
 */
const AREAS: readonly Area[] = [
	{ name: "General intelligence", metrics: [points("aa:idx", "AA Intelligence Index")] },
	{
		name: "Computer use (operating GUIs from screenshots)",
		metrics: [
			percent("pub:OSW2", "OSWorld 2.0"),
			percent("pub:SSP", "ScreenSpot-Pro"),
			percent("pub:ALE", "Agents' Last Exam"),
			percent("aa:MMMU", "MMMU-Pro visual reasoning"),
		],
	},
	{
		name: "Agentic coding in a terminal or repository",
		metrics: [
			percent("aa:TB4", "Terminal-Bench 4.0"),
			percent("dswe:Pass@1", "DeepSWE"),
			percent("aa:TB21", "Terminal-Bench 2.1"),
		],
	},
	{
		name: "Code quality and mergeable changes",
		metrics: [
			percent("fc:Main", "FrontierCode mergeability"),
			percent("aa:LCB", "LiveCodeBench"),
			percent("aa:Sci", "SciCode"),
		],
	},
	{
		name: "Tool use and business workflows",
		metrics: [
			percent("aa:tau2", "τ²-Bench"),
			percent("aa:Auto", "AutomationBench-AA"),
			percent("pub:ABench", "AutomationBench"),
			percent("aa:Ent", "EnterpriseOps-Gym"),
			percent("aa:tauB", "Banking tool use"),
		],
	},
	{
		name: "Research, browsing and expert knowledge",
		metrics: [
			percent("aa:HLE", "Humanity's Last Exam"),
			percent("aa:GPQA", "GPQA Diamond"),
			percent("pub:BComp", "BrowseComp"),
			points("aa:Omni", "Omniscience reliability"),
		],
	},
	{
		name: "Math and science",
		metrics: [
			percent("pub:FMT4", "FrontierMath Tier 4"),
			percent("pub:TBSci", "Terminal-Bench-Science"),
			percent("aa:Crit", "CritPt"),
			percent("aa:AIME", "AIME 2025"),
		],
	},
	{
		name: "Long documents",
		metrics: [percent("aa:LCR", "AA-LCR"), percent("aa:PDF", "GDP.pdf"), percent("aa:MLCR", "Medical long context")],
	},
	{
		name: "Professional knowledge work",
		metrics: [
			points("aa:Gn", "GDPval"),
			points("aa:Brief", "AA-Briefcase"),
			percent("aa:Harvey", "Harvey legal"),
			percent("aa:Analyst", "AnalystAgent"),
			percent("aa:Apex", "APEX-Agents"),
		],
	},
	{ name: "Instruction following", metrics: [percent("aa:IF", "IFBench")] },
	{
		name: "Security and exploitation",
		metrics: [
			percent("pub:XBench", "ExploitBench"),
			percent("pub:XGym", "ExploitGym"),
			percent("pub:SRE", "SRE-Bench"),
			percent("pub:SECPro", "SEC-Bench Pro"),
		],
	},
	{
		name: "Abstract reasoning",
		metrics: [percent("pub:ARC2", "ARC-AGI-2"), percent("pub:ARC3", "ARC-AGI-3")],
	},
];

/** A standing is only stated when enough eligible models have the measurement to rank against. */
const MIN_RANKED_MODELS = 4;

function sectionKind(intro: readonly string[]): "aa" | "dswe" | "fc" | "pub" {
	const heading = intro.find((line) => line.startsWith("## ")) ?? "";
	if (/DeepSWE/u.test(heading)) return "dswe";
	if (/FrontierCode/u.test(heading)) return "fc";
	if (/Published/u.test(heading)) return "pub";
	return "aa";
}

function cells(line: string): string[] {
	return line
		.split("|")
		.slice(1, -1)
		.map((cell) => cell.trim());
}

/** Best value per metric key across every evals row that describes the model. */
function measurements(catalog: EvalsCatalog, model: string): { values: Map<string, number>; released?: string } {
	const kinds = catalog.sections.map((section) => sectionKind(section.intro));
	const headers = catalog.sections.map((section) =>
		cells(section.intro.find((line) => line.startsWith("| slug |")) ?? ""),
	);
	const values = new Map<string, number>();
	let released: string | undefined;
	const record = (key: string, raw: string | undefined) => {
		const value = Number.parseFloat(raw ?? "");
		if (Number.isFinite(value)) values.set(key, Math.max(values.get(key) ?? Number.NEGATIVE_INFINITY, value));
	};
	for (const row of candidateEvidenceRows(catalog, model)) {
		const kind = kinds[row.section]!;
		const header = headers[row.section]!;
		const rowCells = cells(row.line);
		if (kind === "pub") record(`pub:${rowCells[header.indexOf("Benchmark")]}`, rowCells[header.indexOf("Score")]);
		else for (const [index, column] of header.entries()) if (index > 1) record(`${kind}:${column}`, rowCells[index]);
		if (row.releaseDate && (!released || row.releaseDate > released)) released = row.releaseDate;
	}
	return { values, ...(released ? { released } : {}) };
}

function standing(fraction: number): string {
	if (fraction >= 0.9) return "top 10%";
	if (fraction >= 0.75) return "top quarter";
	if (fraction >= 0.5) return "above median";
	if (fraction >= 0.25) return "below median";
	return "bottom quarter";
}

const EFFORT_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function money(value: number): string {
	return `$${Number(value.toPrecision(3))}`;
}

function contextLabel(tokens: number): string {
	return tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toPrecision(3))}M` : `${Math.round(tokens / 1000)}k`;
}

/**
 * One plain-language profile per eligible model, distilled from evals.md.
 * Standings compare each model only with the other eligible models, so the
 * router reads relative strength directly instead of cross-referencing tables
 * and comparing numbers. Absent measurements are named as unknown, not weak.
 */
export function buildCandidateProfiles(
	catalog: EvalsCatalog,
	candidates: readonly ProfileCandidate[],
): Map<string, string> {
	const measured = candidates.map((candidate) => ({ candidate, ...measurements(catalog, candidate.model) }));
	const rankOf = (key: string, value: number): number | undefined => {
		const all = measured.flatMap((entry) => (entry.values.has(key) ? [entry.values.get(key)!] : []));
		if (all.length < MIN_RANKED_MODELS) return undefined;
		return all.filter((other) => other < value).length / (all.length - 1);
	};
	const blended = (candidate: ProfileCandidate) => (3 * candidate.cost.input + candidate.cost.output) / 4;
	const prices = [...measured.map((entry) => blended(entry.candidate))].sort((a, b) => a - b);
	const priceTier = (value: number) => {
		const position = prices.filter((other) => other < value).length / Math.max(1, prices.length - 1);
		return position < 1 / 3 ? "low" : position < 2 / 3 ? "mid" : "high";
	};
	const newest = measured
		.map((entry) => entry.released ?? "")
		.sort()
		.at(-1);

	const profiles = new Map<string, string>();
	for (const { candidate, values, released } of measured) {
		const parts: string[] = [];
		const price = blended(candidate);
		parts.push(
			price > 0
				? `${priceTier(price)} price among these candidates (${money(candidate.cost.input)} input / ${money(candidate.cost.output)} output per million tokens)`
				: "no listed price",
		);
		if (released && newest) {
			const monthsBehind = Math.round((Date.parse(newest) - Date.parse(released)) / (30.44 * 86_400_000));
			parts.push(
				monthsBehind <= 1
					? `released ${released}, among the newest candidates`
					: `released ${released}, ${monthsBehind} months older than the newest candidate`,
			);
		} else parts.push("release date unknown");
		parts.push(candidate.input.includes("image") ? "accepts images" : "text only, cannot read images");
		parts.push(`${contextLabel(candidate.contextWindow)} context`);
		const efforts = [...candidate.efforts]
			.filter((effort): effort is string => effort !== null)
			.sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
		parts.push(efforts.length ? `efforts ${efforts.join(", ")}` : "no configurable reasoning effort");

		const strengths: string[] = [];
		const unmeasured: string[] = [];
		for (const area of AREAS) {
			const present = area.metrics.filter((metric) => values.has(metric.key));
			if (present.length === 0) {
				unmeasured.push(area.name.replace(/ \(.*\)$/u, "").toLowerCase());
				continue;
			}
			const ranks = present
				.map((metric) => rankOf(metric.key, values.get(metric.key)!))
				.filter((rank): rank is number => rank !== undefined);
			const quoted = present
				.slice(0, 2)
				.map((metric) => `${metric.label} ${values.get(metric.key)}${metric.unit === "%" ? "%" : ""}`)
				.join(", ");
			const label = ranks.length ? standing(ranks.reduce((a, b) => a + b, 0) / ranks.length) : "measured";
			strengths.push(`${area.name}: ${label} (${quoted})`);
		}
		const lines = [`${candidate.name} (${candidate.model}): ${parts.join("; ")}.`];
		if (strengths.length) lines.push(...strengths.map((line) => `- ${line}`));
		if (unmeasured.length) lines.push(`- No published results for: ${unmeasured.join(", ")}.`);
		profiles.set(candidate.model, lines.join("\n"));
	}
	return profiles;
}
