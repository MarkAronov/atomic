import { type Component, hyperlink, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

export const TRANSCRIPT_JUMP_TO_END_URL = "atomic-ui://transcript/jump-to-end";

export interface TranscriptFollowIndicatorOptions {
	isFollowing: () => boolean;
	keyLabel: () => string;
}

/** Shows the clickable affordance for a transcript that is detached from its live end. */
export class TranscriptFollowIndicator implements Component {
	private readonly options: TranscriptFollowIndicatorOptions;

	constructor(options: TranscriptFollowIndicatorOptions) {
		this.options = options;
	}
	invalidate(): void {}

	render(width: number): string[] {
		if (this.options.isFollowing()) return [];

		const viewportWidth = Math.max(0, Math.floor(width));
		const keyLabel = this.options.keyLabel();
		const label = keyLabel.length > 0 ? `Jump to bottom (${keyLabel}) ↓` : "Jump to bottom ↓";

		// A normal box has two border columns and one padding column on each side.
		// For very narrow viewports, retain the three rows while clipping the box
		// geometry to the available cells.
		if (viewportWidth < 4) {
			return this.renderNarrow(label, viewportWidth);
		}

		const truncatedLabel = truncateToWidth(label, viewportWidth - 4);
		const labelWidth = visibleWidth(truncatedLabel);
		const boxWidth = labelWidth + 4;
		const leftPadding = Math.floor((viewportWidth - boxWidth) / 2);
		const padding = " ".repeat(leftPadding);
		const border = "─".repeat(labelWidth + 2);

		return [
			theme.fg("muted", `${padding}┌${border}┐`),
			theme.fg("muted", `${padding}│ `) +
				(labelWidth > 0 ? theme.fg("muted", hyperlink(truncatedLabel, TRANSCRIPT_JUMP_TO_END_URL)) : "") +
				theme.fg("muted", " │"),
			theme.fg("muted", `${padding}└${border}┘`),
		];
	}

	private renderNarrow(label: string, width: number): string[] {
		if (width === 0) return ["", "", ""];
		if (width === 1) return [theme.fg("muted", "┌"), theme.fg("muted", "│"), theme.fg("muted", "└")];

		const insideWidth = width - 2;
		const truncatedLabel = truncateToWidth(label, insideWidth);
		const labelWidth = visibleWidth(truncatedLabel);
		const labelRow =
			theme.fg("muted", "│") +
			(labelWidth > 0 ? theme.fg("muted", hyperlink(truncatedLabel, TRANSCRIPT_JUMP_TO_END_URL)) : "") +
			theme.fg("muted", `${" ".repeat(Math.max(0, insideWidth - labelWidth))}│`);
		const border = `┌${"─".repeat(insideWidth)}┐`;
		const bottom = `└${"─".repeat(insideWidth)}┘`;
		return [theme.fg("muted", border), labelRow, theme.fg("muted", bottom)];
	}
}
