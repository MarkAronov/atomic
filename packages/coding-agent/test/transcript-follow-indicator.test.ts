import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import {
	TRANSCRIPT_JUMP_TO_END_URL,
	TranscriptFollowIndicator,
} from "../src/modes/interactive/components/transcript-follow-indicator.ts";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import "../src/modes/interactive/interactive-transcript-follow.ts";
import { createInteractiveTui, handleUrlActivation } from "../src/modes/interactive/interactive-tui.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { openBrowser } from "../src/utils/open-browser.ts";
import { RecordingTerminal } from "./helpers/interactive-fullscreen-layout.ts";

vi.mock("../src/utils/open-browser.ts", () => ({ openBrowser: vi.fn() }));

beforeAll(() => initTheme("dark"));
const OSC8_MARKER = "\x1b]8;;";

function leadingSpaceCount(row: string): number {
	return stripTerminalSequences(row).match(/^ */)?.[0].length ?? 0;
}

describe("TranscriptFollowIndicator", () => {
	test("is hidden while the transcript follows its end", () => {
		const indicator = new TranscriptFollowIndicator({ isFollowing: () => true, keyLabel: () => "End" });

		expect(indicator.render(80)).toEqual([]);
	});

	test("renders a centered linked three-row box with the live key label", () => {
		const indicator = new TranscriptFollowIndicator({ isFollowing: () => false, keyLabel: () => "Ctrl+End" });

		for (const width of [80, 41]) {
			const rows = indicator.render(width);
			expect(rows).toHaveLength(3);
			expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
			const boxWidth = visibleWidth(stripTerminalSequences(rows[0]!).trimStart());
			const expectedLeftPadding = Math.floor((width - boxWidth) / 2);
			expect(leadingSpaceCount(rows[0]!)).toBe(expectedLeftPadding);
			expect(leadingSpaceCount(rows[1]!)).toBe(expectedLeftPadding);
			expect(visibleWidth(stripTerminalSequences(rows[1]!).trimStart())).toBe(boxWidth);
			expect(visibleWidth(stripTerminalSequences(rows[2]!).trimStart())).toBe(boxWidth);
		}

		const rows = indicator.render(80);
		expect(rows[0]).not.toContain(OSC8_MARKER);
		expect(rows[2]).not.toContain(OSC8_MARKER);
		expect(rows[1]).toContain(OSC8_MARKER);
		expect(rows[1]).toContain(TRANSCRIPT_JUMP_TO_END_URL);
		expect(rows[1]).toContain("Ctrl+End");
		expect(rows[0]).toContain("┌");
		expect(rows[2]).toContain("└");
	});

	test("truncates every row to a narrow viewport and omits an empty key suffix", () => {
		const indicator = new TranscriptFollowIndicator({ isFollowing: () => false, keyLabel: () => "" });
		const rows = indicator.render(8);
		expect(rows).toHaveLength(3);
		expect(rows.every((row) => visibleWidth(row) <= 8)).toBe(true);
		expect(stripTerminalSequences(rows[1]!)).toContain("J");
		expect(rows[1]).not.toContain("()");

		for (const width of [0, 1, 2, 3, 4]) {
			const narrowRows = indicator.render(width);
			expect(narrowRows).toHaveLength(3);
			expect(narrowRows.every((row) => visibleWidth(row) <= width)).toBe(true);
		}
	});
});

describe("handleUrlActivation", () => {
	test("routes the transcript jump URL internally without opening a browser", () => {
		const onInternalUiAction = vi.fn();
		const openUrl = vi.fn();

		handleUrlActivation(TRANSCRIPT_JUMP_TO_END_URL, { onInternalUiAction, openUrl });

		expect(onInternalUiAction).toHaveBeenCalledExactlyOnceWith(TRANSCRIPT_JUMP_TO_END_URL);
		expect(openUrl).not.toHaveBeenCalled();
	});

	test("opens non-internal URLs in the browser", () => {
		const onInternalUiAction = vi.fn();
		const openUrl = vi.fn();

		handleUrlActivation("https://example.com", { onInternalUiAction, openUrl });

		expect(openUrl).toHaveBeenCalledExactlyOnceWith("https://example.com");
		expect(onInternalUiAction).not.toHaveBeenCalled();
	});

	test("drops unknown atomic-ui URLs", () => {
		const onInternalUiAction = vi.fn();
		const openUrl = vi.fn();

		handleUrlActivation("atomic-ui://transcript/unknown", { onInternalUiAction, openUrl });

		expect(onInternalUiAction).not.toHaveBeenCalled();
		expect(openUrl).not.toHaveBeenCalled();
	});

	test("accepts case-insensitive internal schemes", () => {
		const onInternalUiAction = vi.fn();
		const openUrl = vi.fn();

		handleUrlActivation("ATOMIC-UI://transcript/jump-to-end", { onInternalUiAction, openUrl });

		expect(onInternalUiAction).toHaveBeenCalledExactlyOnceWith("ATOMIC-UI://transcript/jump-to-end");
		expect(openUrl).not.toHaveBeenCalled();
	});
	test.each(["atomic-ui://[", "atomic-ui://a[b", "atomic-ui://tra nscript/jump-to-end", "ATOMIC-UI://tra nscript/x"])(
		"drops malformed internal URLs without invoking either handler: %s",
		(url) => {
			const onInternalUiAction = vi.fn();
			const openUrl = vi.fn();

			handleUrlActivation(url, { onInternalUiAction, openUrl });

			expect(onInternalUiAction).not.toHaveBeenCalled();
			expect(openUrl).not.toHaveBeenCalled();
		},
	);

	test("preserves browser routing for unparseable non-internal URLs", () => {
		const onInternalUiAction = vi.fn();
		const openUrl = vi.fn();

		handleUrlActivation("not a url", { onInternalUiAction, openUrl });

		expect(openUrl).toHaveBeenCalledExactlyOnceWith("not a url");
		expect(onInternalUiAction).not.toHaveBeenCalled();
	});

	test("wires fullscreen URL activation to the browser and internal action callback", () => {
		const onInternalUiAction = vi.fn();
		const tui = createInteractiveTui({
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: new RecordingTerminal(),
			onInternalUiAction,
		});
		const openUrl = Reflect.get(tui, "openUrl");
		if (typeof openUrl !== "function") throw new Error("fullscreen TUI did not expose its URL handler");

		const browser = vi.mocked(openBrowser);
		browser.mockClear();
		openUrl("https://example.com");
		expect(browser).toHaveBeenCalledExactlyOnceWith("https://example.com");

		openUrl(TRANSCRIPT_JUMP_TO_END_URL);
		expect(onInternalUiAction).toHaveBeenCalledExactlyOnceWith(TRANSCRIPT_JUMP_TO_END_URL);
		expect(browser).toHaveBeenCalledExactlyOnceWith("https://example.com");
	});
});

describe("jumpToTranscriptEnd", () => {
	test("is safe without a transcript viewport and remains idempotent", () => {
		const requestRender = vi.fn();
		const context = {
			transcriptScrollView: undefined,
			ui: { requestRender },
		};

		expect(() => InteractiveModeBase.prototype.jumpToTranscriptEnd.call(context as never)).not.toThrow();
		const scrollToEnd = vi.fn();
		context.transcriptScrollView = { scrollToEnd } as never;

		InteractiveModeBase.prototype.jumpToTranscriptEnd.call(context as never);
		InteractiveModeBase.prototype.jumpToTranscriptEnd.call(context as never);

		expect(scrollToEnd).toHaveBeenCalledTimes(2);
		expect(requestRender).toHaveBeenCalledTimes(3);
	});
});
