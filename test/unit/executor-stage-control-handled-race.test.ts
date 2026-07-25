import { test } from "bun:test";
import assert from "node:assert/strict";
import { createStageControlHandle } from "../../packages/workflows/src/runs/foreground/executor-stage-control.js";

test("stage-control prompt does not reject after handled input was authorized", async () => {
  const handlingStarted = Promise.withResolvers<void>();
  const finishHandling = Promise.withResolvers<void>();
  let terminal = false;
  let sideEffects = 0;
  const runtime = {
    runId: "run-handled-race",
    stageId: "stage-handled-race",
    name: "handled race",
    stageSnapshot: { status: "running", sessionId: "session-handled-race" },
    state: { liveHandleReleased: false },
    innerCtx: {
      __sessionMeta: () => ({ sessionId: "session-handled-race", sessionFile: undefined }),
      subscribe: () => () => {},
      async __sendUserMessage(_text: string, _options: undefined, beforeDelivery: () => void) {
        beforeDelivery();
        handlingStarted.resolve();
        await finishHandling.promise;
        sideEffects += 1;
        return "handled" as const;
      },
    },
    throwIfStageMutationBlocked() {
      if (terminal) throw new DOMException("workflow exited", "AbortError");
    },
    captureStageSessionMeta() {},
  };
  const handle = createStageControlHandle(runtime as never);

  const delivery = handle.prompt("handled input");
  await handlingStarted.promise;
  terminal = true;
  finishHandling.resolve();

  await delivery;
  assert.equal(sideEffects, 1);
});

test("stage-control resume rechecks admission after awaited __resume setup", async () => {
  const resumeStarted = Promise.withResolvers<void>();
  const continueResume = Promise.withResolvers<void>();
  const terminalError = new Error("root terminated during resume");
  let terminal = false;
  let nativeReleaseMutations = 0;
  let snapshotMutations = 0;
  const runtime = {
    runId: "run-resume-race",
    stageId: "stage-resume-race",
    name: "resume race",
    stageSnapshot: { status: "paused", sessionId: "session-resume-race" },
    state: {
      liveHandleReleased: false,
      waitingForStageChatTurn: false,
      resumeContinuationPending: false,
    },
    innerCtx: {
      __sessionMeta: () => ({ sessionId: "session-resume-race", sessionFile: undefined }),
      __isPaused: () => true,
      subscribe: () => () => {},
      async __resume(
        _message: string | undefined,
        _beforeResolve: ((result: { releasedQueuedMessages: boolean; runnerOwnedDeliveryPending: boolean }) => void) | undefined,
        beforeRelease: (() => void) | undefined,
      ) {
        resumeStarted.resolve();
        await continueResume.promise;
        beforeRelease?.();
        nativeReleaseMutations += 1;
        return { releasedQueuedMessages: false, runnerOwnedDeliveryPending: false };
      },
    },
    activeStore: {
      recordStageResumed() { snapshotMutations += 1; return true; },
      recordRunResumed() { snapshotMutations += 1; },
    },
    throwIfStageMutationBlocked() {},
    captureStageSessionMeta() {},
  };
  const handle = createStageControlHandle(runtime as never);

  const resume = handle.resume("late message", () => {
    if (terminal) throw terminalError;
  });
  await resumeStarted.promise;
  terminal = true;
  continueResume.resolve();

  await assert.rejects(resume, (error) => error === terminalError);
  assert.equal(nativeReleaseMutations, 0);
  assert.equal(snapshotMutations, 0);
});
