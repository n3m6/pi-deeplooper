import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

import { runPipeline } from "../../src/application/pipeline/run-pipeline.js";
import { TestHarness } from "../support/harness.js";
import type { TelemetryEvent } from "../../src/application/port/index.js";

const harnesses: TestHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.dispose()));
});

async function writeReportArtifacts(harness: TestHarness): Promise<void> {
  await writeFile(harness.artifacts.goalsFile, "# Goals\n\n## Acceptance Criteria\n1. Works.", "utf8");
  await writeFile(harness.artifacts.requirementsFile, "Build CLI.", "utf8");
  await writeFile(harness.artifacts.baselineResultsFile, "### Baseline Status — PASS\n\nAll clean.", "utf8");
  await writeFile(
    harness.artifacts.stage9SummaryFile,
    "### Overall Status — PASS\n\n### Stage Summary\nVerification passed.",
    "utf8",
  );
  await writeFile(
    harness.artifacts.globalAcceptanceResultsFile,
    "# Global Acceptance Results\n\n## Summary\nAll passed.\n\n## Overall Status\nPASS\n",
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// Lifecycle telemetry — run.started / run.completed
// ---------------------------------------------------------------------------

test("runPipeline emits run.started and run.completed telemetry on a trivial run", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);

  // Advance state to report so we skip all intermediate stages
  harness.completeStage("accept", "report");
  harness.state = { ...harness.state, nextStage: "report" };
  await writeReportArtifacts(harness);

  const finalState = await runPipeline({
    services: harness.services,
    state: harness.state,
    workspaceRoot: harness.workspaceRoot,
    isResumed: false,
  });

  const events = await harness.telemetrySink.readEvents();
  const eventTypes = events.map((e: TelemetryEvent) => e.event_type);

  assert.ok(eventTypes.includes("run.started"), `Expected run.started; got ${JSON.stringify(eventTypes)}`);
  assert.ok(eventTypes.includes("run.completed"), `Expected run.completed; got ${JSON.stringify(eventTypes)}`);
  assert.equal(finalState.nextStage, "done");

  const startedEvent = events.find((e: TelemetryEvent) => e.event_type === "run.started");
  assert.ok(startedEvent, "run.started event missing");
  assert.equal(startedEvent.summary, `Pipeline started. Route: ${harness.state.route}.`);

  const completedEvent = events.find((e: TelemetryEvent) => e.event_type === "run.completed");
  assert.ok(completedEvent, "run.completed event missing");
  assert.equal(completedEvent.summary, `Pipeline completed. Route: ${harness.state.route}.`);
  assert.equal(completedEvent.status, "PASS");

  const stageStartedEvents = events.filter((e: TelemetryEvent) => e.event_type === "stage.started");
  assert.ok(stageStartedEvents.length > 0, "No stage.started events");
  assert.ok(
    stageStartedEvents[0]!.summary.startsWith("Stage "),
    `Unexpected summary: ${stageStartedEvents[0]!.summary}`,
  );
  assert.ok(stageStartedEvents[0]!.summary.includes("Route:"), "stage.started summary missing Route");
});

// ---------------------------------------------------------------------------
// run.resumed — when pipeline resumes from prior checkpoint
// ---------------------------------------------------------------------------

test("runPipeline emits run.resumed (not run.started) when isResumed is true", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);

  harness.completeStage("accept", "report");
  harness.state = { ...harness.state, nextStage: "report" };
  await writeReportArtifacts(harness);

  await runPipeline({
    services: harness.services,
    state: harness.state,
    workspaceRoot: harness.workspaceRoot,
    isResumed: true,
  });

  const events = await harness.telemetrySink.readEvents();
  const eventTypes = events.map((e: TelemetryEvent) => e.event_type);

  assert.ok(eventTypes.includes("run.resumed"), `Expected run.resumed; got ${JSON.stringify(eventTypes)}`);
  assert.ok(!eventTypes.includes("run.started"), "Should not emit run.started on resume");

  const resumedEvent = events.find((e: TelemetryEvent) => e.event_type === "run.resumed");
  assert.equal(resumedEvent!.summary, `Pipeline resumed. Route: ${harness.state.route}.`);
});
