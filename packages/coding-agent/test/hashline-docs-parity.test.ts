import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { readTextSync } from "../../../test/helpers/runtime.js";
import {
	BARE_BODY_AUTO_PIPED_WARNING,
	BLOCK_RESOLVER_UNAVAILABLE,
	DELETE_BLOCK_TAKES_NO_BODY,
	DELETE_TAKES_NO_BODY,
	describeAnchorExamples,
	EMPTY_BLOCK,
	EMPTY_INSERT,
	EMPTY_REPLACE,
	HUNK_LIKE_LITERAL_WARNING,
	MINUS_ROW_REJECTED,
	Patch,
	UNRESOLVED_BLOCK_INTERNAL,
} from "../src/core/tools/hashline-engine/index.ts";

const docs = readTextSync(join(dirname(fileURLToPath(import.meta.url)), "../docs/tools/edit.md"), "utf8");
const normalizedDocs = docs.replace(/\s+/g, " ");

describe("hashline edit reference documentation", () => {
	test("keeps exported diagnostics and generated anchor examples aligned with the engine", () => {
		assert.ok(docs.includes(describeAnchorExamples("119")));
		for (const diagnostic of [
			MINUS_ROW_REJECTED,
			EMPTY_INSERT,
			EMPTY_BLOCK,
			DELETE_TAKES_NO_BODY,
			DELETE_BLOCK_TAKES_NO_BODY,
			BLOCK_RESOLVER_UNAVAILABLE,
			UNRESOLVED_BLOCK_INTERNAL,
			BARE_BODY_AUTO_PIPED_WARNING,
			HUNK_LIKE_LITERAL_WARNING,
			EMPTY_REPLACE,
		]) {
			assert.ok(docs.includes(diagnostic), `reference docs omitted or changed: ${diagnostic}`);
		}
	});

	test("documents the narrow scope of hash-comment skipping", () => {
		assert.ok(!normalizedDocs.includes("Comment lines beginning with `#` between hunks are ignored"));
		assert.ok(normalizedDocs.includes("skipped only before the first operation in a section"));
		assert.ok(normalizedDocs.includes("Once a hunk is open, a `#` line is body content"));
	});

	test("skips a leading hash comment but treats one in an open hunk as body content", () => {
		const leadingComment = Patch.parse("[probe.ts#AAAA]\n# note\ndelete 3");
		assert.equal(leadingComment.sections[0]?.edits.length, 1);
		assert.equal(leadingComment.sections[0]?.edits[0]?.kind, "delete");

		const replacementComment = Patch.parse(
			'[probe.ts#AAAA]\nreplace 3..3:\n+    msg = "hi"\n# note\ninsert after 5:\n+tail()',
		);
		assert.ok(
			replacementComment.sections[0]?.edits.some((edit) => edit.kind === "insert" && edit.text === "# note"),
			"a hash comment in an open replacement hunk must remain literal payload",
		);
	});
});
