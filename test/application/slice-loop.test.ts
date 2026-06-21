import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";

import { sliceLoopStage } from "../../src/application/stage/slice-loop.js";
import type { TelemetryEvent } from "../../src/application/port/index.js";
import { TestHarness } from "../support/harness.js";

const harnesses: TestHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.dispose()));
});

function renderTestDesign(): string {
  const manifest = {
    slices: [
      {
        id: "S1",
        title: "Health Check Endpoint",
        deps: [],
        acceptanceCriteria: ["The endpoint returns 200 OK."],
      },
    ],
  };
  return [
    "# Design",
    "",
    "## Approach",
    "Build a minimal health check endpoint.",
    "",
    "## Slice Manifest",
    "",
    "```json",
    JSON.stringify(manifest, null, 2),
    "```",
  ].join("\n");
}

async function writeCoreArtifacts(harness: TestHarness): Promise<void> {
  await writeFile(
    harness.artifacts.goalsFile,
    "# Goals\n\n## Acceptance Criteria\n1. The endpoint returns 200 OK.\n",
    "utf8",
  );
  await writeFile(harness.artifacts.designFile, renderTestDesign(), "utf8");
  await writeFile(
    harness.artifacts.structureFile,
    [
      "# Structure",
      "",
      "## File Map",
      "",
      "### Slice S1: Health Check",
      "| File | Action | Purpose |",
      "|------|--------|---------|",
      "| `src/health.ts` | CREATE | Health check handler |",
    ].join("\n"),
    "utf8",
  );
  await writeFile(harness.artifacts.skeletonResultsFile, "### Skeleton Status — CLEAN\n\nBaseline clean.\n", "utf8");
}

// ---------------------------------------------------------------------------
// Happy path: planner writes task spec, full loop exhausts to PASS
// ---------------------------------------------------------------------------

test("slice-loop: planner writes task spec, queue exhausts to PASS", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);
  await writeCoreArtifacts(harness);

  harness.completeStage("baseline", "slice-loop");
  harness.state = { ...harness.state, nextStage: "slice-loop" };

  const result = await sliceLoopStage.run(harness.runtime(undefined, "slice-loop"));

  assert.equal(result.status, "PASS");
  assert.match(result.summary, /exhausted/i);

  // Pin the write-location contract: task spec must land in the run dir, not workspace root.
  const correctPath = path.join(harness.artifacts.phasesDir, "phase-01", "tasks", "task-01.md");
  await assert.doesNotReject(access(correctPath), `task-01.md not found in run dir: ${correctPath}`);

  const wrongPath = path.join(harness.workspaceRoot, "phases", "phase-01", "tasks", "task-01.md");
  await assert.rejects(access(wrongPath), `task-01.md must NOT exist at workspace root: ${wrongPath}`);
});

// ---------------------------------------------------------------------------
// Empty-plan guard: planner writes nothing → anomaly + requeue × N → LOOP_DESIGN
// ---------------------------------------------------------------------------

test("slice-loop: empty plan emits slice-plan-empty anomalies and escalates LOOP_DESIGN after requeue cap", async () => {
  // MAX_REQUEUE = 2, so there are 3 plan attempts (requeueCount 1, 2, 3) before escalation.
  const harness = await TestHarness.create({ route: "full", slicePlannerWritesNoTasks: true });
  harnesses.push(harness);
  await writeCoreArtifacts(harness);

  harness.completeStage("baseline", "slice-loop");
  harness.state = { ...harness.state, nextStage: "slice-loop" };

  const result = await sliceLoopStage.run(harness.runtime(undefined, "slice-loop"));

  assert.equal(result.status, "FAIL");
  assert.ok(result.backwardLoop, "Expected backwardLoop to be set");
  assert.equal(result.backwardLoop?.classification, "LOOP_DESIGN");

  const events = await harness.telemetrySink.readEvents();
  const anomalies = events.filter(
    (e: TelemetryEvent) => e.event_type === "pipeline.anomaly" && e.context?.["code"] === "slice-plan-empty",
  );
  // One anomaly per plan attempt; requeueCounts 1 and 2 requeue, 3 escalates — all 3 emit the anomaly.
  assert.equal(anomalies.length, 3, `Expected 3 slice-plan-empty anomalies; got ${anomalies.length}`);
});
