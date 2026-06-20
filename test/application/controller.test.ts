import { test } from "node:test";
import assert from "node:assert/strict";

import { applyStageTransition } from "../../src/application/pipeline/run-pipeline.js";
import { Run } from "../../src/domain/run/index.js";

function freshState(runId = "deeplooper-20260601-000000") {
  return Run.start({
    runId,
    interactionMode: "automated",
    failurePolicy: "best-effort",
    route: "full",
  }).toSnapshot();
}

// ---------------------------------------------------------------------------
// DEEPLOOPER stage transition tests
// ---------------------------------------------------------------------------

test("goals → research on PASS", async () => {
  const next = applyStageTransition(freshState(), "goals", {
    status: "PASS",
    filesWritten: [],
    summary: "Goals written.",
  });
  assert.equal(next.nextStage, "research");
  assert.ok(next.stagesCompleted.includes("goals"));
});

test("research → design on PASS", async () => {
  const next = applyStageTransition(freshState(), "research", {
    status: "PASS",
    filesWritten: [],
    summary: "Research done.",
  });
  assert.equal(next.nextStage, "design");
});

test("design → skeleton on PASS", async () => {
  const next = applyStageTransition(freshState(), "design", {
    status: "PASS",
    filesWritten: [],
    summary: "Design done.",
  });
  assert.equal(next.nextStage, "skeleton");
  assert.ok(!next.pendingReconcile);
});

test("design preserves pendingReconcile so slice-loop can reconcile after escalation", () => {
  // pendingReconcile is set when escalating to design/goals; it must survive the
  // design → skeleton → baseline transitions so slice-loop (the consumer) reconciles.
  const escalated = { ...freshState(), pendingReconcile: true };
  const next = applyStageTransition(escalated, "design", {
    status: "PASS",
    filesWritten: [],
    summary: "Redesigned after escalation.",
  });
  assert.equal(next.nextStage, "skeleton");
  assert.equal(next.pendingReconcile, true);
});

test("skeleton → baseline on PASS", async () => {
  const next = applyStageTransition(freshState(), "skeleton", {
    status: "PASS",
    filesWritten: [],
    summary: "Skeleton done.",
  });
  assert.equal(next.nextStage, "baseline");
});

test("baseline → slice-loop on PASS", async () => {
  const next = applyStageTransition(freshState(), "baseline", {
    status: "PASS",
    filesWritten: [],
    summary: "Baseline clean.",
  });
  assert.equal(next.nextStage, "slice-loop");
});

test("slice-loop → verify on PASS (queue exhausted)", async () => {
  const next = applyStageTransition(freshState(), "slice-loop", {
    status: "PASS",
    filesWritten: [],
    summary: "All slices done.",
  });
  assert.equal(next.nextStage, "verify");
});

test("verify → accept on PASS", async () => {
  const next = applyStageTransition(freshState(), "verify", {
    status: "PASS",
    filesWritten: [],
    summary: "Verify passed.",
    telemetry: { verify_status: "PASS" },
  });
  assert.equal(next.nextStage, "accept");
  assert.equal(next.verifyStatus, "PASS");
});

test("verify → slice-loop when remediationSlicesAdded=true", async () => {
  const next = applyStageTransition(freshState(), "verify", {
    status: "FAIL",
    filesWritten: [],
    summary: "Remediation slices added.",
    telemetry: { remediationSlicesAdded: true, verify_status: "FAIL" },
  });
  assert.equal(next.nextStage, "slice-loop");
});

test("accept → report on PASS", async () => {
  const next = applyStageTransition(freshState(), "accept", {
    status: "PASS",
    filesWritten: [],
    summary: "Acceptance passed.",
  });
  assert.equal(next.nextStage, "report");
});

test("accept → slice-loop when remediationSlicesAdded=true", async () => {
  const next = applyStageTransition(freshState(), "accept", {
    status: "FAIL",
    filesWritten: [],
    summary: "Remediation slices added.",
    telemetry: { remediationSlicesAdded: true },
  });
  assert.equal(next.nextStage, "slice-loop");
});

test("report → done on PASS", async () => {
  const next = applyStageTransition(freshState(), "report", {
    status: "PASS",
    filesWritten: [],
    summary: "Report written.",
  });
  assert.equal(next.nextStage, "done");
});

test("verifyStatus PARTIAL is recorded in state", async () => {
  const next = applyStageTransition(freshState(), "verify", {
    status: "PARTIAL",
    filesWritten: [],
    summary: "Partial.",
    telemetry: { verify_status: "PARTIAL" },
  });
  assert.equal(next.verifyStatus, "PARTIAL");
});
