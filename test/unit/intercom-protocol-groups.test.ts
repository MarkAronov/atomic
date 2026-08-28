import assert from "node:assert/strict";
import { test } from "vitest";
import type { ClientMessage, SessionInfo } from "../../packages/intercom/types.js";

const BASE_SESSION = {
	id: "session-1",
	cwd: "/repo",
	model: "test",
	pid: 1,
	startedAt: 1,
	lastActivity: 1,
} as const;

test("the session protocol carries a set of group memberships", () => {
	const session: SessionInfo = { ...BASE_SESSION, groups: ["default", "reviewers"] };
	const presence: ClientMessage = { type: "presence", groups: ["default", "reviewers"] };
	const registration: ClientMessage = {
		type: "register",
		session: {
			cwd: BASE_SESSION.cwd,
			model: BASE_SESSION.model,
			pid: BASE_SESSION.pid,
			startedAt: BASE_SESSION.startedAt,
			lastActivity: BASE_SESSION.lastActivity,
			groups: ["default", "reviewers"],
		},
	};

	assert.deepEqual(session.groups, ["default", "reviewers"]);
	assert.deepEqual(presence.groups, ["default", "reviewers"]);
	assert.deepEqual(registration.session.groups, ["default", "reviewers"]);
});

test("legacy single-group clients remain valid protocol clients", () => {
	const session: SessionInfo = { ...BASE_SESSION, group: "reviewers" };
	const registration: ClientMessage = {
		type: "register",
		session: {
			cwd: session.cwd,
			model: session.model,
			pid: session.pid,
			startedAt: session.startedAt,
			lastActivity: session.lastActivity,
			group: session.group,
		},
	};
	const presence: ClientMessage = { type: "presence", group: "reviewers" };

	assert.equal(session.group, "reviewers");
	assert.equal(registration.session.group, "reviewers");
	assert.equal(presence.group, "reviewers");
});
