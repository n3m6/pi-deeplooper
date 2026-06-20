import { test } from "node:test";
import assert from "node:assert/strict";

import { runAgentReviewLoop } from "../../src/application/workflow/agent-review-loop.js";
import { InMemoryArtifactRepository } from "../support/in-memory-artifact-repository.js";
import type { PipelineServices, ReviewDepth, StageRuntime } from "../../src/application/port/index.js";

function makeRuntime(reviewDepth?: ReviewDepth): StageRuntime {
  return {
    state: {
      runId: "dl-20260601-000000",
      route: "full",
      lastCompletedStage: "none",
      nextStage: "goals",
      stagesCompleted: [],
      backwardLoops: 0,
      currentSlice: null,
      slicesDone: [],
      slicesBlocked: [],
      requeueCounts: {},
      pendingReconcile: false,
      resumeSource: "fresh",
      interactionMode: "automated",
      failurePolicy: "best-effort",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    workspaceRoot: "/tmp",
    currentStage: "goals",
    services: {
      telemetrySink: { record: async () => {}, regenerateRunLog: async () => {}, regenerateMetrics: async () => {} },
      artifactRepo: new InMemoryArtifactRepository(),
      gates: { interactionMode: "automated", failurePolicy: "best-effort", reviewDepth },
    } as unknown as PipelineServices,
  };
}

test("runAgentReviewLoop fast mode clamps maxRounds:5 to 2 — both FAIL, onFail runs once, returns reviewRounds:2 FAIL", async () => {
  const runtime = makeRuntime("fast");
  let reviewCalls = 0;
  let onFailCalls = 0;

  const result = await runAgentReviewLoop(runtime, {
    maxRounds: 5,
    stageName: "goals",
    runReview: async () => {
      reviewCalls += 1;
      return { text: "### Status — FAIL\n\n### Summary\nNeeds work." };
    },
    onFail: async () => {
      onFailCalls += 1;
    },
  });

  assert.equal(result.status, "FAIL");
  assert.equal(result.reviewRounds, 2, "clamped to 2 rounds");
  assert.equal(reviewCalls, 2, "review called for each of the 2 rounds");
  assert.equal(onFailCalls, 1, "onFail called exactly once — the one correction cycle between rounds 1 and 2");
});

test("runAgentReviewLoop fast mode passes on round 1 without invoking onFail", async () => {
  const runtime = makeRuntime("fast");
  let onFailCalls = 0;

  const result = await runAgentReviewLoop(runtime, {
    maxRounds: 5,
    stageName: "goals",
    runReview: async () => ({ text: "### Status — PASS\n\n### Summary\nAll good." }),
    onFail: async () => {
      onFailCalls += 1;
    },
  });

  assert.equal(result.status, "PASS");
  assert.equal(result.reviewRounds, 1);
  assert.equal(onFailCalls, 0);
});

test("runAgentReviewLoop retries a transient failure once and returns PASS", async () => {
  const runtime = makeRuntime();
  let calls = 0;

  const result = await runAgentReviewLoop(runtime, {
    maxRounds: 3,
    stageName: "goals",
    maxTransientRetries: 1,
    runReview: async () => {
      calls += 1;
      if (calls === 1) return { failure: "dispatched session timed out", transient: true };
      return { text: "### Status — PASS\n\n### Summary\nPass." };
    },
  });

  assert.equal(result.status, "PASS");
  assert.equal(result.reviewRounds, 1);
  assert.equal(calls, 2, "should attempt twice: 1 timeout + 1 retry");
});

test("runAgentReviewLoop fails after exhausting transient retry budget", async () => {
  const runtime = makeRuntime();
  let calls = 0;

  const result = await runAgentReviewLoop(runtime, {
    maxRounds: 3,
    stageName: "goals",
    maxTransientRetries: 1,
    runReview: async () => {
      calls += 1;
      return { failure: "dispatched session timed out", transient: true };
    },
  });

  assert.equal(result.status, "FAIL");
  assert.equal(result.dispatchFailure, true);
  assert.match(result.summary ?? "", /timed out/);
  assert.equal(calls, 2, "should attempt twice: 1 initial + 1 retry = budget exhausted");
});

test("runAgentReviewLoop does not retry non-transient failures", async () => {
  const runtime = makeRuntime();
  let calls = 0;

  const result = await runAgentReviewLoop(runtime, {
    maxRounds: 3,
    stageName: "goals",
    maxTransientRetries: 1,
    runReview: async () => {
      calls += 1;
      return { failure: "dispatched session was aborted", transient: false };
    },
  });

  assert.equal(result.status, "FAIL");
  assert.equal(result.dispatchFailure, true);
  assert.equal(calls, 1, "should attempt exactly once — non-transient failures are not retried");
});
