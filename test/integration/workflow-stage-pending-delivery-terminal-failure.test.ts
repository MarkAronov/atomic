/**
 * Integration: a workflow stage whose queued Intercom instructions can no
 * longer be delivered must reach a deterministic terminal outcome.
 *
 * Before the fix, the Intercom wrapper wrote one console diagnostic when its
 * bounded warm-up retries ran out and nothing settled the delivery, so the
 * stage stayed `running` forever on the untimed
 * `await pendingStageDelivery.ready()` in `stage-runner-controller`. This
 * drives the real executor with the production
 * `createWorkflowPendingStageDelivery` and asserts the stage fails, at its own
 * lifecycle boundary, with an error that names it — and that the queued
 * steering it never received stays queued rather than being dropped.
 */

import { getDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import type { StageExecutionMeta } from "../../packages/workflows/src/shared/types.js";
import {
	assert,
	createStore,
	mockSession,
	run,
	type StageSessionRuntime,
	test,
	workflow,
} from "../unit/executor-shared.js";

const QUEUED_MESSAGE_ID = "steering-1";
const WARM_UP_EXHAUSTED = "Intercom could not reach the broker after 5 warm-up attempts.";

test("a stage whose pending Intercom delivery fails terminally becomes a failed stage", async () => {
	const store = createStore();
	let prompted = 0;
	const definition = workflow({
		name: "pending-stage-terminal-failure",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("reviewer", { tools: ["intercom"] }).prompt("review the change");
			return {};
		},
	});

	const result = await run(
		definition,
		{},
		{
			store,
			adapters: {
				agentSession: {
					async create(options, meta?: StageExecutionMeta) {
						const delivery = options.orchestrationContext?.pendingStageDelivery;
						assert.ok(delivery, "the stage must expose the production pending delivery");
						assert.ok(meta);
						const runId = meta.runId;
						const group = `workflow:${runId}`;
						// Queue the steering this stage was supposed to receive, then model
						// the Intercom wrapper running out of bounded warm-up retries.
						const queued = await store.queueStageMessage(
							{
								runId,
								stageKey: "reviewer",
								from: { id: "planner-session", name: "planner", group },
								message: {
									id: QUEUED_MESSAGE_ID,
									timestamp: 1_725_000_000_000,
									content: { text: "Scope amendment the reviewer must read first." },
								},
								queuedAt: "2026-09-04T00:00:00.000Z",
							},
							group,
							group,
							getDurableBackend(),
						);
						assert.equal(queued?.ok, true);
						delivery.fail?.(new Error(WARM_UP_EXHAUSTED));
						// `stage-runner-controller` only gates on `ready()` when the created
						// session is recognized as a real AgentSession (`asAgentSession`) and
						// carries the stage's orchestration context, so the mock supplies the
						// same shape production does.
						const session: StageSessionRuntime = {
							...mockSession(),
							async prompt() {
								prompted += 1;
							},
							state: {},
							sessionManager: {},
							modelRuntime: {},
							getContextUsage: () => ({}),
							orchestrationContext: options.orchestrationContext,
						} as StageSessionRuntime;
						return session;
					},
				},
			},
		},
	);

	assert.equal(prompted, 0, "the stage never runs without the instructions it was refused");
	assert.equal(result.status, "failed");
	const stage = result.stages.find((candidate) => candidate.name === "reviewer");
	assert.ok(stage);
	assert.equal(stage.status, "failed", "the stage reaches a terminal outcome instead of staying parked");
	assert.equal(stage.failureDisposition, "terminal_failed");
	assert.equal(stage.failureKind, "unknown");
	assert.match(String(stage.error), /stage "reviewer"/);
	assert.match(String(stage.error), new RegExp(WARM_UP_EXHAUSTED.replace(/\./g, "\\.")));

	const queued = store.pendingStageMessagesFor(result.runId, "reviewer");
	assert.equal(queued.length, 1, "the steering is not dropped");
	assert.equal(queued[0]?.id, QUEUED_MESSAGE_ID);
	assert.equal(queued[0]?.status, "queued");
});
