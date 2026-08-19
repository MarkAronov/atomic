import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";

export default function slashAutosendFixtureExtension(pi: ExtensionAPI): void {
	pi.registerCommand("foo", {
		description: "Harmless slash auto-send regression fixture command",
		handler: async () => {},
	});
}
