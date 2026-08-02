import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { GraphCanvas } from "../../packages/workflows/src/tui/graph-canvas.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { defaultTheme, makeStage, visibleText } from "./overlay-graph-helpers.js";

class CountingCanvas extends GraphCanvas {
	mergedCells = 0;

	override mergeCell(...args: Parameters<GraphCanvas["mergeCell"]>): void {
		this.mergedCells++;
		super.mergeCell(...args);
	}
}

class InstrumentedGraphView extends GraphView {
	composeCalls = 0;
	edgeCalls = 0;

	protected override _composeRow(
		edgeRow: string,
		cards: Array<{ startCol: number; width: number; line: string }>,
		edgeColor: string,
	): string {
		this.composeCalls++;
		return super._composeRow(edgeRow, cards, edgeColor);
	}

	protected override _plotEdge(
		canvas: GraphCanvas,
		px: number,
		py: number,
		cx: number,
		cy: number,
		color: string,
	): void {
		this.edgeCalls++;
		super._plotEdge(canvas, px, py, cx, cy, color);
	}

	animationEligible(): boolean {
		return this._needsAnimationTick();
	}

	layoutForTest() {
		return this.cachedLayout;
	}

	expandedTargetsForTest() {
		return this.expandedGraph.targets;
	}

	expandedGraphForTest() {
		return this.expandedGraph;
	}

	renderGeometryForTest() {
		return this.cachedRenderGeometry;
	}

	focusedIndexForTest(): number {
		return this.focusedIndex;
	}

	guardLayoutIterationForTest(): void {
		this.cachedLayout = new Proxy(this.cachedLayout, {
			get(target, property, receiver) {
				if (property === Symbol.iterator) throw new Error("render iterated complete layout");
				return Reflect.get(target, property, receiver);
			},
		});
	}

	guardAnimationLayoutScanForTest(): void {
		this.cachedLayout = new Proxy(this.cachedLayout, {
			get(target, property, receiver) {
				if (property === Symbol.iterator || property === "length" || /^\d+$/.test(String(property))) {
					throw new Error("animation eligibility scanned layout");
				}
				return Reflect.get(target, property, receiver);
			},
		});
	}

	scanLayoutWithSomeForTest(): boolean {
		return this.cachedLayout.some(() => false);
	}
}

function chainStages(count: number): StageSnapshot[] {
	return Array.from({ length: count }, (_, index) => ({
		...makeStage(`s${index}`, index === 0 ? [] : [`s${index - 1}`]),
		status: index === count - 1 ? ("running" as const) : ("completed" as const),
		startedAt: 1,
		...(index < count - 1 ? { endedAt: 2, durationMs: 1 } : {}),
	}));
}

function parallelPairs(count: number): StageSnapshot[] {
	const roots = Array.from({ length: count }, (_, index) => makeStage(`root-${index}`));
	const children = Array.from({ length: count }, (_, index) => makeStage(`child-${index}`, [`root-${index}`]));
	return [...roots, ...children];
}

function createGraphStore(stages: StageSnapshot[]) {
	const store = createStore();
	store.recordRunStart({
		id: "run-1",
		name: "large",
		inputs: {},
		status: "running",
		stages,
		startedAt: 1,
	});
	return store;
}

function renderPairGraph(count: number): { composed: number; edges: number; cards: number; text: string } {
	const store = createGraphStore(parallelPairs(count));
	let cards = 0;
	const view = new InstrumentedGraphView({
		mode: "overlay",
		runId: "run-1",
		store,
		graphTheme: defaultTheme,
		getViewportRows: () => 24,
		initialFocusedStageId: "root-0",
		getStageQueuedMessageCount: () => {
			cards++;
			return 0;
		},
	});
	try {
		const text = visibleText(view.render(96));
		return { composed: view.composeCalls, edges: view.edgeCalls, cards, text };
	} finally {
		view.dispose();
	}
}

describe("GraphView many-stage performance (#2100)", () => {
	it("composes and paints only the visible rows and cards in a tall graph", () => {
		const store = createGraphStore(chainStages(400));
		let cards = 0;
		const view = new InstrumentedGraphView({
			mode: "overlay",
			runId: "run-1",
			store,
			graphTheme: defaultTheme,
			getViewportRows: () => 24,
			initialFocusedStageId: "s399",
			getStageQueuedMessageCount: () => {
				cards++;
				return 0;
			},
		});
		try {
			const lines = view.render(96);
			const text = visibleText(lines);
			assert.equal(lines.length, 24);
			assert.match(text, /s399/);
			assert.match(text, /running/);
			assert.doesNotMatch(text, /s0\b/);
			assert.ok(view.composeCalls <= 16, `composed ${view.composeCalls} rows for a 16-row body`);
			assert.ok(cards <= 2, `painted ${cards} cards outside the focused viewport`);
		} finally {
			view.dispose();
		}
	});

	it("clips off-screen fan-out edges and keeps expensive work viewport bounded", () => {
		const small = renderPairGraph(100);
		const large = renderPairGraph(1_000);
		for (const result of [small, large]) {
			assert.equal(result.composed, 13);
			assert.ok(result.cards <= 8, `painted ${result.cards} cards`);
			assert.ok(result.edges <= 4, `plotted ${result.edges} off-screen edges`);
			assert.doesNotMatch(result.text, /root-50|child-50/);
		}
		assert.ok(large.cards <= small.cards + 2);
		assert.ok(large.edges <= small.edges + 2);
	});

	it("bounds long edge segments to the viewport width and height", () => {
		const horizontal = new CountingCanvas({ top: 10, bottom: 20, left: 1_000, right: 1_080 });
		horizontal.hline(15, 0, 100_000, "#ffffff");
		assert.equal(horizontal.mergedCells, 80);
		assert.equal(horizontal.toLines().length, 10);

		const vertical = new CountingCanvas({ top: 500, bottom: 516, left: 20, right: 40 });
		vertical.vline(30, 0, 100_000, "#ffffff");
		assert.equal(vertical.mergedCells, 16);
		assert.equal(vertical.toLines().length, 16);
	});

	it("retains layout and expanded target identity across status-only store updates", () => {
		const store = createGraphStore([{ ...makeStage("A"), status: "running", startedAt: 1 }]);
		const view = new InstrumentedGraphView({ mode: "overlay", runId: "run-1", store, graphTheme: defaultTheme });
		try {
			view.render(80);
			const beforeLayout = view.layoutForTest();
			const beforeNode = beforeLayout[0];
			const beforeGraph = view.expandedGraphForTest();
			const beforeGeometry = view.renderGeometryForTest();
			const beforeTargets = view.expandedTargetsForTest();
			const beforeFocusedIndex = view.focusedIndexForTest();

			store.recordStageEnd("run-1", {
				...makeStage("A"),
				status: "completed",
				startedAt: 1,
				endedAt: 2,
				durationMs: 1,
			});
			view.invalidate();

			assert.strictEqual(view.layoutForTest(), beforeLayout);
			assert.strictEqual(view.layoutForTest()[0], beforeNode);
			assert.notStrictEqual(view.expandedGraphForTest(), beforeGraph);
			assert.strictEqual(view.renderGeometryForTest(), beforeGeometry);
			assert.strictEqual(view.expandedTargetsForTest(), beforeTargets);
			assert.equal(view.layoutForTest()[0]?.stage.status, "completed");
			assert.equal(view.focusedIndexForTest(), beforeFocusedIndex);
			assert.match(visibleText(view.render(80)), /✓ complete/);
		} finally {
			view.dispose();
		}
	});

	it("retains expanded topology for plain failed and skipped real-store updates", () => {
		for (const status of ["failed", "skipped"] as const) {
			const store = createGraphStore([{ ...makeStage("A"), status: "running", startedAt: 1 }]);
			const view = new InstrumentedGraphView({ mode: "overlay", runId: "run-1", store, graphTheme: defaultTheme });
			try {
				view.render(80);
				const beforeLayout = view.layoutForTest();
				const beforeNode = beforeLayout[0];
				const beforeGraph = view.expandedGraphForTest();
				const beforeGeometry = view.renderGeometryForTest();
				const beforeTargets = view.expandedTargetsForTest();
				const beforeFocusedIndex = view.focusedIndexForTest();

				store.recordStageEnd("run-1", {
					...makeStage("A"),
					status,
					startedAt: 1,
					endedAt: 2,
					durationMs: 1,
				});
				view.invalidate();

				assert.strictEqual(view.layoutForTest(), beforeLayout, `${status} replaced layout`);
				assert.strictEqual(view.layoutForTest()[0], beforeNode, `${status} replaced layout node`);
				assert.notStrictEqual(view.expandedGraphForTest(), beforeGraph, `${status} reused expanded graph`);
				assert.strictEqual(view.renderGeometryForTest(), beforeGeometry, `${status} replaced render geometry`);
				assert.strictEqual(view.expandedTargetsForTest(), beforeTargets, `${status} replaced targets`);
				assert.equal(view.layoutForTest()[0]?.stage.status, status);
				assert.equal(view.focusedIndexForTest(), beforeFocusedIndex);
			} finally {
				view.dispose();
			}
		}
	});

	it("renders and records hit targets without iterating the complete layout", () => {
		const store = createGraphStore(chainStages(1_000));
		const view = new InstrumentedGraphView({
			mode: "overlay",
			runId: "run-1",
			store,
			graphTheme: defaultTheme,
			getViewportRows: () => 24,
			initialFocusedStageId: "s999",
		});
		try {
			view.guardLayoutIterationForTest();
			assert.doesNotThrow(() => view.render(96));
		} finally {
			view.dispose();
		}
	});

	it("checks idle animation eligibility without iterating graph nodes", () => {
		const store = createGraphStore(Array.from({ length: 1_000 }, (_, index) => makeStage(`idle-${index}`)));
		const view = new InstrumentedGraphView({ mode: "overlay", runId: "run-1", store, graphTheme: defaultTheme });
		try {
			view.guardAnimationLayoutScanForTest();
			assert.throws(() => view.scanLayoutWithSomeForTest(), /animation eligibility scanned layout/);
			assert.equal(view.animationEligible(), false);
		} finally {
			view.dispose();
		}
	});
});
