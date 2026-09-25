import { jsonBytes, truncateToBytes } from "./model-routing-task.js";

/** Bounds the evaluation evidence sent with one routing request. */
export const MODEL_SELECTION_EVALS_JSON_BYTES = 14_200;

const VENDOR_OR_REGION_PREFIX = /^(?:[a-z][a-z-]*\.)+/u;
const SNAPSHOT_TOKEN = /^\d{4}$/u;
const DEPLOYMENT_TOKENS = new Set([
	"fast",
	"highspeed",
	"ultraspeed",
	"lightning",
	"beta",
	"exp",
	"free",
	"it",
	"instruct",
	"contributor",
]);
const ROW_EDITION_TOKENS = new Set(["preview", "instruct", "it"]);
const VARIANT_TOKENS = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"adaptive",
	"thinking",
	"reasoning",
	"non",
	"effort",
	"preview",
]);
const CLAUDE_FAMILIES = new Set(["opus", "sonnet", "haiku", "fable"]);

/** Artificial Analysis names older Claude models `claude-4-5-sonnet`; catalogs use `claude-sonnet-4-5`. */
function canonicalClaudeOrder(tokens: string[]): string[] {
	if (tokens[0] !== "claude" || !CLAUDE_FAMILIES.has(tokens[1] ?? "")) return tokens;
	const versionEnd = tokens.findIndex((token, index) => index > 1 && !/^\d+$/u.test(token));
	const end = versionEnd < 0 ? tokens.length : versionEnd;
	if (end === 2) return tokens;
	return ["claude", ...tokens.slice(2, end), tokens[1]!, ...tokens.slice(end)];
}

/** Provider-independent model tokens: `us.anthropic.claude-opus-4-6-v1` and `anthropic/claude-opus-4.6` agree. */
export function modelEvidenceTokens(id: string): string[] {
	const normalized = id.trim().toLowerCase();
	const model = normalized
		.slice(normalized.lastIndexOf("/") + 1)
		.replace(/^~/u, "")
		.replace(VENDOR_OR_REGION_PREFIX, "")
		.replace(/(?<=[a-z])-\d+:\d+$/u, "")
		.replace(/:[a-z0-9]+$/u, "")
		.replace(/-v\d+$/u, "")
		.replace(/-\d{8}$/u, "");
	const tokens = model
		.split(/[-._]/u)
		.filter(Boolean)
		.map((token) => (token === "thinking" ? "reasoning" : token));
	return canonicalClaudeOrder(tokens);
}

/** True when `slug` is the candidate model or one of its effort, edition or snapshot variants. */
function slugMatchesCandidate(slug: readonly string[], candidate: readonly string[]): boolean {
	if (slug.length < candidate.length || candidate.some((token, index) => slug[index] !== token)) return false;
	return slug
		.slice(candidate.length)
		.every((token) => VARIANT_TOKENS.has(token) || ROW_EDITION_TOKENS.has(token) || SNAPSHOT_TOKEN.test(token));
}

/**
 * The candidate's own tokens first, then the same model without trailing
 * deployment, reasoning-mode or snapshot suffixes (`gpt-5.4-fast`,
 * `grok-4.20-reasoning`, `qwen3.8-max-0902`). A fallback applies only when the
 * more specific form matched no row, so a model that is itself named `-fast`
 * keeps its own evidence.
 */
function candidateForms(tokens: readonly string[]): string[][] {
	const forms = [[...tokens]];
	let current = [...tokens];
	while (current.length > 1) {
		const last = current[current.length - 1]!;
		if (!DEPLOYMENT_TOKENS.has(last) && !VARIANT_TOKENS.has(last) && !SNAPSHOT_TOKEN.test(last)) break;
		current = current.slice(0, -1);
		forms.push(current);
	}
	return forms;
}

interface CatalogRow {
	readonly line: string;
	readonly order: number;
	readonly tokens: readonly string[];
	readonly releaseDate?: string;
}

/** `evals.md` parsed once so batch packing can query evidence per candidate cheaply. */
export interface EvalsCatalog {
	readonly preamble: readonly string[];
	readonly rows: readonly CatalogRow[];
	/** The unparsed document when it has no model table. */
	readonly raw?: string;
	readonly matches: Map<string, readonly CatalogRow[]>;
}

export function parseEvalsCatalog(evals: string): EvalsCatalog {
	const lines = evals.split("\n");
	const headerIndex = lines.findIndex((line) => /^\|\s*slug\s*\|/u.test(line));
	if (headerIndex < 0) return { preamble: [], rows: [], raw: evals, matches: new Map() };
	const header = lines[headerIndex]!.split("|").map((cell) => cell.trim());
	const releaseColumn = header.indexOf("Release date");
	const rows: CatalogRow[] = [];
	for (const [order, line] of lines.slice(headerIndex + 2).entries()) {
		if (!line.startsWith("|")) continue;
		const cells = line.split("|").map((cell) => cell.trim());
		if (!cells[1]) continue;
		const release = releaseColumn > 0 ? cells[releaseColumn] : undefined;
		rows.push({
			line,
			order,
			tokens: modelEvidenceTokens(cells[1]),
			...(release && /^\d{4}-\d{2}-\d{2}$/u.test(release) ? { releaseDate: release } : {}),
		});
	}
	return { preamble: lines.slice(0, headerIndex + 2), rows, matches: new Map() };
}

/** Rows describing `candidate`: its own model and variants, or its base model when it has none. */
export function candidateEvidenceRows(catalog: EvalsCatalog, candidate: string): readonly CatalogRow[] {
	const cached = catalog.matches.get(candidate);
	if (cached) return cached;
	let matches: readonly CatalogRow[] = [];
	for (const form of candidateForms(modelEvidenceTokens(candidate))) {
		matches = catalog.rows.filter((row) => slugMatchesCandidate(row.tokens, form));
		if (matches.length > 0) break;
	}
	catalog.matches.set(candidate, matches);
	return matches;
}

/** Latest release date among the candidate's evidence rows, when any row has one. */
export function candidateReleaseDate(catalog: EvalsCatalog, candidate: string): string | undefined {
	const dates = candidateEvidenceRows(catalog, candidate).flatMap((row) => (row.releaseDate ? [row.releaseDate] : []));
	return dates.length ? dates.sort().at(-1) : undefined;
}

/**
 * The catalog preamble plus the rows for `candidates`. `maxBytes` bounds the
 * JSON-encoded result; batched routing omits it because its request budget
 * already decides how many candidates, and so how many rows, one batch holds.
 */
export function catalogEvidence(
	catalog: EvalsCatalog,
	candidates: readonly string[],
	maxBytes = Number.POSITIVE_INFINITY,
): string {
	if (catalog.raw !== undefined) return truncateToBytes(catalog.raw, maxBytes);
	const selected = new Set<number>();
	for (const candidate of new Set(candidates))
		for (const row of candidateEvidenceRows(catalog, candidate)) selected.add(row.order);
	const kept = catalog.rows.filter((row) => selected.has(row.order)).map((row) => row.line);
	const filtered = [...catalog.preamble, ...kept].join("\n");
	return jsonBytes(filtered) <= maxBytes ? filtered : truncateToBytes(filtered, maxBytes);
}

/**
 * Keep the catalog preamble and only the table rows that describe an eligible
 * candidate model, bounded to the routing evidence budget.
 */
export function filterModelSelectionEvals(evals: string, candidates: readonly string[]): string {
	return catalogEvidence(parseEvalsCatalog(evals), candidates, MODEL_SELECTION_EVALS_JSON_BYTES);
}
