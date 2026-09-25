import assert from "node:assert/strict";
import { test } from "vitest";
import { parseEvalsCatalog } from "../../packages/coding-agent/src/core/model-routing-evals.js";
import {
	buildCandidateProfiles,
	type ProfileCandidate,
} from "../../packages/coding-agent/src/core/model-routing-profiles.js";

const evals = [
	"# Evals",
	"",
	"## Artificial Analysis Intelligence Index v4.3.2",
	"",
	"| slug | Model | Release date | idx | TB4 | MMMU |",
	"| --- | --- | --- | ---: | ---: | ---: |",
	"| model-a | A | 2026-09-20 | 60 | 60 | 90 |",
	"| model-a-high | A high | 2026-09-20 | 55 | 62 | 88 |",
	"| model-b | B | 2026-09-01 | 50 | 40 | 80 |",
	"| model-c | C | 2026-03-01 | 40 | 30 | 70 |",
	"| model-d | D | 2025-09-01 | 30 | 10 | ∅ |",
	"",
	"## Published benchmark results",
	"",
	"| slug | Model | Benchmark | Score | Setting | Source |",
	"| --- | --- | --- | ---: | --- | --- |",
	"| model-a | A | OSW2 | 72.6 | partial | OpenAI |",
].join("\n");

function candidate(id: string, input: number, image = true): ProfileCandidate {
	return {
		model: `provider/${id}`,
		name: id.toUpperCase(),
		cost: { input, output: input * 5 },
		input: image ? ["text", "image"] : ["text"],
		contextWindow: 1_000_000,
		efforts: ["high", "low", "medium"],
	};
}

const candidates = [
	candidate("model-a", 10),
	candidate("model-b", 4),
	candidate("model-c", 1),
	candidate("model-d", 0.1, false),
];
const profiles = buildCandidateProfiles(parseEvalsCatalog(evals), candidates);

test("standings compare each model with the other eligible models, quoting its own best result", () => {
	assert.match(profiles.get("provider/model-a")!, /^- General intelligence: top 10% \(AA Intelligence Index 60\)$/mu);
	assert.match(
		profiles.get("provider/model-a")!,
		/^- Agentic coding in a terminal or repository: top 10% \(Terminal-Bench 4\.0 62%\)$/mu,
	);
	assert.match(profiles.get("provider/model-d")!, /^- General intelligence: bottom quarter/mu);
});

test("an area measured by fewer than four eligible models is quoted without a standing", () => {
	assert.match(
		profiles.get("provider/model-a")!,
		/Computer use \(operating GUIs from screenshots\): measured \(OSWorld 2\.0 72\.6%, MMMU-Pro visual reasoning 90%\)/u,
	);
});

test("price tier, recency, image input, context and efforts are stated in words", () => {
	const a = profiles.get("provider/model-a")!;
	assert.match(
		a,
		/^MODEL-A \(provider\/model-a\): high price among these candidates \(\$10 input \/ \$50 output per million tokens\); released 2026-09-20, among the newest candidates; accepts images; 1M context; efforts low, medium, high\./mu,
	);
	const d = profiles.get("provider/model-d")!;
	assert.match(d, /low price among these candidates/u);
	assert.match(d, /released 2025-09-01, 13 months older than the newest candidate/u);
	assert.match(d, /text only, cannot read images/u);
});

test("areas without evidence are named as unknown rather than implied weak", () => {
	assert.match(
		profiles.get("provider/model-d")!,
		/^- No published results for: .*computer use.*security and exploitation/mu,
	);
	const unlisted = buildCandidateProfiles(parseEvalsCatalog(evals), [candidate("model-z", 2)]).get(
		"provider/model-z",
	)!;
	assert.match(unlisted, /release date unknown/u);
	assert.doesNotMatch(unlisted, /top|median|quarter/u);
});

test("a fast route names its base model, its price multiple and when to prefer it", () => {
	const base = candidate("model-a", 4);
	const fast = { ...candidate("model-a-fast", 8), name: "MODEL-A FAST" };
	const withBase = buildCandidateProfiles(parseEvalsCatalog(evals), [base, fast, candidate("model-b", 1)]);
	assert.match(
		withBase.get("provider/model-a-fast")!,
		/^- Fast route of MODEL-A \(provider\/model-a\): the same model with the same results, served faster at 2× its price\. Choose it over MODEL-A only when faster responses are worth the extra cost\.$/mu,
	);
	assert.doesNotMatch(withBase.get("provider/model-a")!, /Fast route/u);
	const alone = buildCandidateProfiles(parseEvalsCatalog(evals), [fast]).get("provider/model-a-fast")!;
	assert.match(
		alone,
		/^- Fast route: the same model as its standard route, served faster\. Its results are the standard model's\.$/mu,
	);
});

test("a fast route at its base model's listed price is not described as costing more", () => {
	const note = buildCandidateProfiles(parseEvalsCatalog(evals), [
		candidate("model-a", 2),
		{ ...candidate("model-a-fast", 2), name: "MODEL-A FAST" },
	]).get("provider/model-a-fast")!;
	assert.match(
		note,
		/Fast route of MODEL-A \(provider\/model-a\): the same model with the same results, served faster at the same listed price\.$/mu,
	);
	assert.doesNotMatch(note, /extra cost/u);
});
