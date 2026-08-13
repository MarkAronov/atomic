import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, test } from "vitest";
import {
	assert,
	createStore,
	deriveGraphTheme,
	fakeFooterAgentSession,
	flush,
	makeHandle,
	makeTestTui,
	StageChatView,
	setupRun,
} from "./stage-chat-view-helpers.js";

async function makeScrollableStageChat(
	rows: number | (() => number | undefined) = 12,
	withFooter = false,
): Promise<StageChatView> {
	const store = createStore();
	setupRun(store, "run-1", "stage-a", "pending");
	const { handle } = withFooter ? makeHandle(undefined, [], "pending", fakeFooterAgentSession()) : makeHandle();
	const view = new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "test-wf",
		handle,
		onDetach: () => {},
		onClose: () => {},
		piTui: makeTestTui(rows),
		footerData: withFooter
			? {
					getGitBranch: () => "main",
					getExtensionStatuses: () => new Map(),
					getAvailableProviderCount: () => 1,
					onBranchChange: () => () => {},
				}
			: undefined,
	});
	for (let i = 0; i < 18; i++) {
		for (const ch of `follow-msg-${i}`) view.handleInput(ch);
		view.handleInput("\r");
		await flush();
		await flush();
	}
	return view;
}

describe("StageChatView", () => {
	test("expands the chat surface to the reported viewport row count", () => {
		// Full-screen overlay: when the host surfaces terminal.rows
		// Full-screen overlay: when the host surfaces terminal.rows,
		// the renderer must paint that many lines so the popup fills the terminal.
		const store = createStore();
		setupRun(store, "run-1", "stage-a");
		const { handle } = makeHandle();
		const view = new StageChatView({
			store,
			graphTheme: deriveGraphTheme({}),
			runId: "run-1",
			stageId: "stage-a",
			workflowName: "test-wf",
			handle,
			onDetach: () => {},
			onClose: () => {},
			piTui: makeTestTui(44),
		});
		const lines = view.render(96);
		assert.equal(lines.length, 44);
		view.dispose();
	});

	test("transcript body grows with the viewport so more entries stay visible", async () => {
		// The transcript body is `viewportRows - HEADER - INPUT - FOOTER`.
		// A larger viewport must surface more transcript entries inside
		// the body band; the fixed 32-row default would clip them.
		const store = createStore();
		setupRun(store, "run-1", "stage-a", "pending");
		const { handle, state } = makeHandle();

		// Seed enough transcript entries that the 32-row body truncates; a
		// larger viewport must render strictly more message content even now
		// that Pi user-message boxes consume multiple terminal rows each.
		const view = new StageChatView({
			store,
			graphTheme: deriveGraphTheme({}),
			runId: "run-1",
			stageId: "stage-a",
			workflowName: "test-wf",
			handle,
			onDetach: () => {},
			onClose: () => {},
			piTui: makeTestTui(60),
		});
		for (let i = 0; i < 30; i++) {
			for (const ch of `msg-${i}`) view.handleInput(ch);
			view.handleInput("\r");
			await flush();
			await flush();
		}
		// Sanity: stub handle recorded each prompt.
		assert.equal(state.promptCalls.length, 30);

		const wideText = view.render(96).join("\n");
		const wideOccurrences = wideText.split("\n").filter((line) => line.includes("msg-")).length;
		const narrow = new StageChatView({
			store,
			graphTheme: deriveGraphTheme({}),
			runId: "run-1",
			stageId: "stage-a",
			workflowName: "test-wf",
			handle,
			onDetach: () => {},
			onClose: () => {},
		});
		for (const entry of view._transcript) {
			for (const ch of entry.text) narrow.handleInput(ch);
			narrow.handleInput("\r");
			await flush();
			await flush();
		}
		const narrowOccurrences = narrow
			.render(96)
			.join("\n")
			.split("\n")
			.filter((line) => line.includes("msg-")).length;
		assert.ok(
			wideOccurrences > narrowOccurrences,
			`expected wider viewport to show more entries (${wideOccurrences} <= ${narrowOccurrences})`,
		);
		narrow.dispose();
		view.dispose();
	});

	test("PageUp and PageDown scroll attached chat history", async () => {
		const store = createStore();
		setupRun(store, "run-1", "stage-a", "pending");
		const { handle } = makeHandle();
		const view = new StageChatView({
			store,
			graphTheme: deriveGraphTheme({}),
			runId: "run-1",
			stageId: "stage-a",
			workflowName: "test-wf",
			handle,
			onDetach: () => {},
			onClose: () => {},
		});

		for (let i = 0; i < 18; i++) {
			for (const ch of `scroll-msg-${i}`) view.handleInput(ch);
			view.handleInput("\r");
			await flush();
			await flush();
		}

		const bottomText = view.render(96).join("\n");
		assert.match(bottomText, /scroll-msg-17/);
		assert.doesNotMatch(bottomText, /scroll-msg-0/);
		assert.ok(view._lastBodyMaxScroll > 0);

		view.handleInput("\x1b[5~");
		const offsetAfterPageUp = view._bodyScrollFromBottom;
		const olderText = view.render(96).join("\n");
		assert.ok(offsetAfterPageUp > 0);
		assert.notEqual(olderText, bottomText);

		view.handleInput("\x1b[6~");
		view.render(96);
		assert.equal(view._bodyScrollFromBottom, 0);
		view.dispose();
	});

	test("mouse wheel scrolls history without typing SGR bytes into the editor", async () => {
		const store = createStore();
		setupRun(store, "run-1", "stage-a", "pending");
		const { handle } = makeHandle();
		const view = new StageChatView({
			store,
			graphTheme: deriveGraphTheme({}),
			runId: "run-1",
			stageId: "stage-a",
			workflowName: "test-wf",
			handle,
			onDetach: () => {},
			onClose: () => {},
		});

		for (let i = 0; i < 18; i++) {
			for (const ch of `wheel-msg-${i}`) view.handleInput(ch);
			view.handleInput("\r");
			await flush();
			await flush();
		}
		view.render(96);

		view.handleInput("\x1b[<64;10;10M");
		view.render(96);
		assert.ok(view._bodyScrollFromBottom > 0);

		const before = view._inputBuffer;
		view.handleInput("\x1b[<0;10;10M");
		assert.equal(view._inputBuffer, before);
		view.dispose();
	});
	test("hides the follow indicator at the pristine live end without consuming a body row", async () => {
		const view = await makeScrollableStageChat();
		const bottom = view.render(96);
		const visibleLines = bottom.map(stripTerminalSequences);

		assert.equal(view._bodyScrollFromBottom, 0);
		assert.doesNotMatch(visibleLines.join("\n"), /Jump to bottom/);
		assert.match(visibleLines[2] ?? "", /follow-msg-16/);
		assert.match(visibleLines[6] ?? "", /follow-msg-17/);
		assert.equal(bottom.length, 12);
		view.dispose();
	});

	test("shows the shared follow indicator after scrolling stage-chat history", async () => {
		const view = await makeScrollableStageChat();
		view.render(96);
		assert.equal(view.handleInput("\x1b[5~"), true);
		const scrolled = view.render(96);
		const visible = stripTerminalSequences(scrolled.join("\n"));

		assert.ok(view._bodyScrollFromBottom > 0);
		assert.match(visible, /Jump to bottom \(end\) ↓/);
		assert.equal(scrolled.length, 12);
		view.dispose();
	});

	test("keeps the transcript viewport size stable while the follow indicator is visible", async () => {
		const view = await makeScrollableStageChat(13);
		view.render(96);

		assert.equal(view.handleInput("\x1b[5~"), true);
		const scrolled = view.render(96);
		assert.ok(view._bodyScrollFromBottom > 0);
		assert.match(stripTerminalSequences(scrolled.join("\n")), /Jump to bottom \(end\) ↓/);
		assert.equal(scrolled.length, 13);

		assert.equal(view.handleInput("\x1b[6~"), true);
		view.render(96);
		assert.equal(view._bodyScrollFromBottom, 0);
		view.dispose();
	});

	test("the bound end key returns stage chat to the live end and hides the indicator", async () => {
		const view = await makeScrollableStageChat();
		view.render(96);
		view.handleInput("\x1b[5~");
		assert.match(stripTerminalSequences(view.render(96).join("\n")), /Jump to bottom \(end\) ↓/);

		assert.equal(view.handleInput("\x1b[F"), true);
		const bottom = view.render(96);
		const visible = stripTerminalSequences(bottom.join("\n"));
		assert.equal(view._bodyScrollFromBottom, 0);
		assert.doesNotMatch(visible, /Jump to bottom/);
		assert.equal(bottom.length, 12);
		view.dispose();
	});

	test("drops the indicator before the composer and footer in a tight viewport", async () => {
		let rows = 12;
		const view = await makeScrollableStageChat(() => rows, true);
		view.render(96);
		assert.equal(view.handleInput("\x1b[5~"), true);
		assert.match(stripTerminalSequences(view.render(96).join("\n")), /Jump to bottom \(end\) ↓/);

		rows = 8;
		const tight = view.render(96);
		const visible = stripTerminalSequences(tight.join("\n"));
		assert.ok(view._bodyScrollFromBottom > 0);
		assert.doesNotMatch(visible, /Jump to bottom/);
		assert.ok(visible.includes("❯"), "composer must survive the tight viewport");
		assert.match(visible, /ctrl\+x return to graph/);
		assert.equal(tight.length, 8);
		view.dispose();
	});
});
