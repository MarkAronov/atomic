import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, test } from "vitest";
import {
	type PossibleStagesScanResult,
	scanPossibleStagesFromSource,
} from "../../packages/workflows/src/shared/possible-stages.js";
import { makeTempDirectory, moduleDir, removeTempDirectory, writeTextSync } from "../helpers/runtime.js";

const TEST_DIR = makeTempDirectory("possible-stages-scan");
afterAll(() => {
	removeTempDirectory(TEST_DIR);
});

const BUILTIN_DIR = join(moduleDir(import.meta.url), "..", "..", "packages", "workflows", "builtin");

function writeFixture(name: string, source: string): string {
	const filePath = join(TEST_DIR, name);
	writeTextSync(filePath, source);
	return filePath;
}

function scanFile(name: string, source: string, options?: { readonly maxDepth?: number }): PossibleStagesScanResult {
	return scanPossibleStagesFromSource(writeFixture(name, source), options);
}

// ---------------------------------------------------------------------------
// D2 — stage-name pattern extraction
// ---------------------------------------------------------------------------

describe("possible-stage scan — D2 name patterns", () => {
	test("string literals stay literal; template holes become glob stars", () => {
		const result = scanFile(
			"d2.ts",
			`
				export default workflow({
					name: "d2",
					run: async (ctx) => {
						await ctx.stage("setup");
						await ctx.task(\`orchestrator-\${iteration}\`, {});
						await ctx.stage(\`review-\${slice}-\${n}\`);
						await ctx.stage(\`prefix-\${x}-suffix\`);
						let current: string | undefined;
						await ctx.task(name, {});
						await ctx.stage(derive(iteration));
					},
				});
			`,
		);
		assert.deepEqual(result.stages, ["*", "orchestrator-*", "prefix-*-suffix", "review-*-*", "setup"]);
		assert.deepEqual(result.warnings, []);
	});

	test("ctx.task contributes its name; chain/parallel steps contribute name fields", () => {
		const result = scanFile(
			"steps.ts",
			`
				export default workflow({
					name: "steps",
					run: async (ctx) => {
						const previous = await ctx.task("first", { prompt: "p" });
						await ctx.chain([
							{ name: "chain-a", task: "a" },
							{ name: "chain-b", task: previous.text },
						]);
						await ctx.parallel([
							{ name: "reviewer-a", task: "r" },
							{ name: "reviewer-b", task: "r" },
						]);
					},
				});
			`,
		);
		assert.deepEqual(result.stages, ["chain-a", "chain-b", "first", "reviewer-a", "reviewer-b"]);
	});

	test("step arrays built by .map() contribute their object name fields", () => {
		const result = scanFile(
			"mapped-steps.ts",
			`
				export default workflow({
					name: "mapped-steps",
					run: async (ctx) => {
						await ctx.parallel(partitions.map((partition, index) => ({
							name: \`branch-\${index}\`,
							prompt: prompt(partition),
						})));
					},
				});
			`,
		);
		assert.deepEqual(result.stages, ["branch-*"]);
	});

	test("typed step declarations built by .map() contribute their object name fields", () => {
		const result = scanFile(
			"typed-mapped-steps.ts",
			`
				export default workflow({
					name: "typed-mapped-steps",
					run: async (ctx) => {
						const steps: WorkflowTaskStep[] = partitions.map((partition, index) => ({
							name: \`branch-\${safeName(partition, index)}\`,
							prompt: branchPrompt(partition),
						}));
						await ctx.parallel(steps, { concurrency: 3 });
					},
				});
			`,
		);
		assert.deepEqual(result.stages, ["branch-*"]);
	});

	test("step factories: name shorthand binds to the call-site argument", () => {
		const result = scanFile(
			"factory-steps.ts",
			`
				export default workflow({
					name: "factory-steps",
					run: async (ctx) => {
						const reviewerStep = (name: string, role: string) => ({
							name,
							task: renderPrompt({ role }),
						});
						const reviewerSteps = [
							reviewerStep(\`completion-reviewer-\${turn}\`, "a"),
							reviewerStep(\`risk-reviewer-\${turn}\`, "b"),
						];
						await ctx.parallel(reviewerSteps, { failFast: true });
					},
				});
			`,
		);
		assert.deepEqual(result.stages, ["completion-reviewer-*", "risk-reviewer-*"]);
	});

	test("objects carrying both name and stageName string fields are stage targets", () => {
		const result = scanFile(
			"stage-records.ts",
			`
				export default workflow({
					name: "stage-records",
					run: async (ctx) => {
						reviewResults = [
							{
								name: "reviewer-error",
								stageName: "reviewer-error",
								text: failure,
							},
						];
						await ctx.stage("after");
					},
				});
			`,
		);
		assert.deepEqual(result.stages, ["after", "reviewer-error"]);
	});

	test("run-context aliases (workflowCtx, designContext chains) resolve their stage calls", () => {
		const result = scanFile(
			"aliased-ctx.ts",
			`
				export default workflow({
					name: "aliased-ctx",
					run: async (ctx) => {
						const workflowCtx = withSteeringPropagationContext(ctx);
						const designContext = workflowCtx;
						await workflowCtx.stage("rebound");
						await handle({ designContext });
					},
				});
				async function handle(args: { designContext: unknown }): Promise<void> {
					await args.designContext.task("discovery", {});
				}
			`,
		);
		assert.deepEqual(result.stages, ["discovery", "rebound"]);
	});

	test("calls inside strings and comments are ignored", () => {
		const result = scanFile(
			"noise.ts",
			`
				// ctx.stage("in-comment")
				/* await ctx.task("in-block") */
				const guidance = 'send via ctx.stage("in-string")';
				const text = \`review notes mentioning ctx.parallel([{ name: "ghost" }])\`;
				export default workflow({
					name: "noise",
					run: async (ctx) => {
						await ctx.stage("real");
					},
				});
			`,
		);
		assert.deepEqual(result.stages, ["real"]);
	});
});

// ---------------------------------------------------------------------------
// D1 — child following, boundaries, depth, cycles
// ---------------------------------------------------------------------------

describe("possible-stage scan — child definitions and boundaries", () => {
	test("ctx.workflow follows relative imports and nests under the default boundary", () => {
		writeFixture(
			"wf-child.ts",
			`
				import { workflow } from "@bastani/workflows";
				export default workflow({
					name: "child",
					run: async (ctx) => {
						await ctx.task(\`impl-\${index}\`, {});
						await ctx.stage("child-final");
					},
				});
			`,
		);
		const result = scanFile(
			"wf-parent.ts",
			`
				import child from "./wf-child.js";
				import { workflow } from "@bastani/workflows";
				export default workflow({
					name: "parent",
					run: async (ctx) => {
						await ctx.stage("root-setup");
						await ctx.workflow(child);
						await ctx.workflow(child, { stageName: "implement" });
					},
				});
			`,
		);
		assert.deepEqual(result.stages, [
			"implement",
			"implement/child-final",
			"implement/impl-*",
			"root-setup",
			"workflow:child",
			"workflow:child/child-final",
			"workflow:child/impl-*",
		]);
		assert.deepEqual(result.warnings, []);
	});

	test("ctx.workflow follows builtin barrel imports and nests builtin stages", () => {
		const result = scanFile(
			"barrel-parent.ts",
			`
				import { ralph } from "@bastani/workflows/builtin";
				import { workflow } from "@bastani/workflows";
				export default workflow({
					name: "barrel-parent",
					run: async (ctx) => {
						await ctx.workflow(ralph, { stageName: "ralph-child" });
					},
				});
			`,
		);
		assert.ok(result.stages.includes("ralph-child/research-*"), JSON.stringify(result.stages));
		assert.ok(result.stages.includes("ralph-child/pull-request"), JSON.stringify(result.stages));
		assert.ok(result.stages.includes("ralph-child/reviewer-a"), JSON.stringify(result.stages));
	});

	test("grandchildren nest transitively and maxDepth bounds the descent", () => {
		writeFixture(
			"depth-grandchild.ts",
			`
				import { workflow } from "@bastani/workflows";
				export default workflow({
					name: "grandchild",
					run: async (ctx) => {
						await ctx.stage("grandchild-stage");
					},
				});
			`,
		);
		writeFixture(
			"depth-child.ts",
			`
				import grandchild from "./depth-grandchild.js";
				import { workflow } from "@bastani/workflows";
				export default workflow({
					name: "depth-child",
					run: async (ctx) => {
						await ctx.stage("child-stage");
						await ctx.workflow(grandchild);
					},
				});
			`,
		);
		const parent = writeFixture(
			"depth-parent.ts",
			`
				import child from "./depth-child.js";
				import { workflow } from "@bastani/workflows";
				export default workflow({
					name: "depth-parent",
					run: async (ctx) => {
						await ctx.workflow(child);
					},
				});
			`,
		);
		const full = scanPossibleStagesFromSource(parent);
		assert.deepEqual(full.stages, [
			"workflow:depth-child",
			"workflow:depth-child/child-stage",
			"workflow:depth-child/workflow:grandchild",
			"workflow:depth-child/workflow:grandchild/grandchild-stage",
		]);
		const bounded = scanPossibleStagesFromSource(parent, { maxDepth: 2 });
		// The depth-2 boundary still materializes (the runtime spawns it before
		// the child's maxDepth refusal), but the refused child's stages do not.
		assert.deepEqual(bounded.stages, [
			"workflow:depth-child",
			"workflow:depth-child/child-stage",
			"workflow:depth-child/workflow:grandchild",
		]);
	});

	test("import cycles terminate and keep both files' stages", () => {
		writeFixture(
			"cycle-b.ts",
			`
				import a from "./cycle-a.js";
				import { workflow } from "@bastani/workflows";
				export default workflow({
					name: "cycle-b",
					run: async (ctx) => {
						await ctx.stage("b-stage");
						await ctx.workflow(a);
					},
				});
			`,
		);
		const result = scanFile(
			"cycle-a.ts",
			`
				import b from "./cycle-b.js";
				import { workflow } from "@bastani/workflows";
				export default workflow({
					name: "cycle-a",
					run: async (ctx) => {
						await ctx.stage("a-stage");
						await ctx.workflow(b);
					},
				});
			`,
		);
		// Boundary names still materialize where descent is cycle-blocked, but
		// the blocked subtree's stages are the documented partial result (D1).
		assert.deepEqual(result.stages, [
			"a-stage",
			"workflow:cycle-b",
			"workflow:cycle-b/b-stage",
			"workflow:cycle-b/workflow:cycle-a",
		]);
	});

	test("named-export and aliased-default child definitions nest instead of leaking flat", () => {
		writeFixture(
			"named-grand.ts",
			`
				import { workflow } from "@bastani/workflows";
				export const grand = workflow({
					name: "named-grand",
					run: async (ctx) => {
						await ctx.stage("grand-step");
					},
				});
			`,
		);
		writeFixture(
			"alias-child.ts",
			`
				import { workflow } from "@bastani/workflows";
				const child = workflow({
					name: "alias-child",
					run: async (ctx) => {
						await ctx.stage("alias-step");
					},
				});
				export default child;
			`,
		);
		const result = scanFile(
			"named-children-parent.ts",
			`
				import { grand } from "./named-grand.js";
				import aliasChild from "./alias-child.js";
				import { workflow } from "@bastani/workflows";
				export default workflow({
					name: "named-children-parent",
					run: async (ctx) => {
						await ctx.workflow(grand);
						await ctx.workflow(aliasChild);
					},
				});
			`,
		);
		assert.deepEqual(result.stages, [
			"workflow:alias-child",
			"workflow:alias-child/alias-step",
			"workflow:named-grand",
			"workflow:named-grand/grand-step",
		]);
	});

	test("wrapper modules with no visible definition fall back to the kebab boundary", () => {
		writeFixture(
			"kebab-impl.ts",
			`
				import { workflow } from "@bastani/workflows";
				export const def = workflow({
					name: "camel-child",
					run: async (ctx) => {
						await ctx.stage("impl-step");
					},
				});
			`,
		);
		// Shipped-layout shape: a re-export wrapper whose default binding has no
		// authored name in this file.
		writeFixture(
			"kebab-wrapper.ts",
			`
				import { def } from "./kebab-impl.js";
				export { def as default };
			`,
		);
		const result = scanFile(
			"kebab-parent.ts",
			`
				import camelChild from "./kebab-wrapper.js";
				import { workflow } from "@bastani/workflows";
				export default workflow({
					name: "kebab-parent",
					run: async (ctx) => {
						await ctx.workflow(camelChild);
					},
				});
			`,
		);
		assert.ok(result.stages.includes("workflow:camel-child"), JSON.stringify(result.stages));
		assert.ok(result.stages.includes("workflow:camel-child/impl-step"), JSON.stringify(result.stages));
	});

	test("computed child references map to a glob boundary with a warning", () => {
		const result = scanFile(
			"computed-child.ts",
			`
				import { workflow } from "@bastani/workflows";
				export default workflow({
					name: "computed-child",
					run: async (ctx) => {
						await ctx.stage("kept");
						await ctx.workflow(defs[0], {});
						await ctx.workflow(ns.default, {});
					},
				});
			`,
		);
		assert.deepEqual(result.stages, ["kept", "workflow:*"]);
		assert.equal(
			result.warnings.filter((warning) => warning.includes("could not be resolved")).length,
			2,
			JSON.stringify(result.warnings),
		);
	});

	test("unrecognized .map step builders warn instead of dropping silently", () => {
		const result = scanFile(
			"opaque-map.ts",
			`
				export default workflow({
					name: "opaque-map",
					run: async (ctx) => {
						await ctx.parallel(warmIndices.map((index) => steps[index]));
					},
				});
			`,
		);
		assert.deepEqual(result.stages, []);
		assert.equal(
			result.warnings.some((warning) => warning.includes("not statically visible")),
			true,
			JSON.stringify(result.warnings),
		);
	});

	test("resolution failures warn and never throw; the partial set survives", () => {
		const missingChild = scanFile(
			"missing-child-parent.ts",
			`
				import nothing from "./does-not-exist.js";
				import { workflow } from "@bastani/workflows";
				export default workflow({
					name: "missing-child-parent",
					run: async (ctx) => {
						await ctx.stage("kept");
						await ctx.workflow(nothing);
					},
				});
			`,
		);
		assert.deepEqual(missingChild.stages, ["kept", "workflow:nothing"]);
		assert.equal(
			missingChild.warnings.some(
				(warning) => warning.includes("did not resolve") || warning.includes("could not be resolved"),
			),
			true,
			JSON.stringify(missingChild.warnings),
		);

		const unreadable = scanPossibleStagesFromSource(join(TEST_DIR, "missing-entry-file.ts"));
		assert.deepEqual(unreadable.stages, []);
		assert.equal(unreadable.warnings.length > 0, true);
	});
});

// ---------------------------------------------------------------------------
// Determinism and the builtin acceptance sets
// ---------------------------------------------------------------------------

describe("possible-stage scan — determinism over builtin sources", () => {
	const BUILTINS = [
		"adversarial-verification",
		"classify-and-act",
		"fan-out-and-synthesize",
		"generate-and-filter",
		"goal",
		"loop-until-done",
		"open-claude-design",
		"ralph",
		"tournament",
	] as const;

	function scanBuiltin(name: string): PossibleStagesScanResult {
		const entry = join(BUILTIN_DIR, `${name}.ts`);
		assert.equal(existsSync(entry), true, `missing builtin source: ${entry}`);
		return scanPossibleStagesFromSource(entry);
	}

	test("scan output is deterministic for every builtin", () => {
		for (const name of BUILTINS) {
			const first = scanBuiltin(name);
			const second = scanBuiltin(name);
			assert.deepEqual(first, second, `nondeterministic scan for ${name}`);
		}
	});

	test("ralph yields the research, orchestration, pull-request, and reviewer stage sets", () => {
		const { stages } = scanBuiltin("ralph");
		for (const expected of [
			"research-*",
			"research-prompt-refinement-*",
			"orchestrator-*",
			"pull-request",
			"reviewer-a",
			"reviewer-b",
		]) {
			assert.ok(stages.includes(expected), `ralph missing "${expected}": ${JSON.stringify(stages)}`);
		}
	});

	test("goal yields the orchestration, reviewer-error, and pull-request stage sets", () => {
		const { stages } = scanBuiltin("goal");
		for (const expected of ["orchestrator-*", "reviewer-error", "pull-request"]) {
			assert.ok(stages.includes(expected), `goal missing "${expected}": ${JSON.stringify(stages)}`);
		}
	});

	test("the six pattern builtins yield their stage patterns", () => {
		const expected: Record<(typeof BUILTINS)[number], readonly string[]> = {
			"adversarial-verification": ["worker", "consolidate-findings-*", "repair-*"],
			"classify-and-act": ["classifier", "action-*"],
			"fan-out-and-synthesize": ["partition", "synthesize", "branch-*"],
			"generate-and-filter": ["generate-*", "dedupe-and-filter", "judge", "final-shortlist"],
			"loop-until-done": ["iteration-*", "evaluate-*", "completion-summary"],
			tournament: ["attempt-*", "comparisons-reducer", "*-reask"],
			goal: [],
			ralph: [],
			"open-claude-design": [],
		};
		for (const name of BUILTINS) {
			const required = expected[name];
			if (required.length === 0) continue;
			const { stages } = scanBuiltin(name);
			for (const stage of required) {
				assert.ok(stages.includes(stage), `${name} missing "${stage}": ${JSON.stringify(stages)}`);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Contract hygiene: the scanner stays dependency-free (D1 refinement)
// ---------------------------------------------------------------------------

describe("possible-stage scan — dependency-free lexer hygiene", () => {
	test("packages/workflows/src imports none of typescript, @babel/*, acorn, or oxc-*", () => {
		const srcRoot = join(moduleDir(import.meta.url), "..", "..", "packages", "workflows", "src");
		const banned = /(?:from\s*|import\s*\(\s*)["'](typescript|@babel\/[^"']*|acorn[^"']*|oxc-[^"']*)["']/g;
		const offenders: string[] = [];
		const visit = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true }) as readonly {
				name: string;
				isDirectory(): boolean;
			}[]) {
				const fullPath = join(dir, entry.name);
				if (entry.isDirectory()) {
					visit(fullPath);
					continue;
				}
				if (!entry.name.endsWith(".ts")) continue;
				const source = readFileSync(fullPath, "utf-8");
				if (banned.test(source)) offenders.push(fullPath);
			}
		};
		visit(srcRoot);
		assert.deepEqual(offenders, []);
	});
});
