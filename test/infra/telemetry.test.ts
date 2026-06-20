import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureRunDirectories, getRunArtifacts } from "../../src/infra/fs/artifact-repository.js";
import { Run } from "../../src/domain/run/index.js";
import {
  JsonlTelemetrySink,
  TelemetryRecorder,
  renderMetricsSummary,
  renderRunLog,
} from "../../src/infra/telemetry/jsonl-telemetry-sink.js";

test("telemetry recorder appends jsonl and renders summaries", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-deeplooper-telemetry-"));
  const artifacts = getRunArtifacts(workspace, "dl-20260601-000000");
  await ensureRunDirectories(artifacts);
  const state = Run.start({
    runId: "dl-20260601-000000",
    interactionMode: "automated",
    failurePolicy: "best-effort",
    route: "full",
  }).toSnapshot();
  const recorder = new TelemetryRecorder(artifacts, state.runId);
  await recorder.initialize();
  await recorder.append({
    event_type: "run.started",
    status: "PASS",
    route: state.route,
    summary: "started",
  });
  await recorder.append({
    event_type: "stage.completed",
    status: "PASS",
    route: state.route,
    stage: "goals",
    phase: 1,
    stage_instance: 1,
    summary: "goals done",
    context: {
      review_rounds: 1,
    },
  });

  const events = await recorder.readEvents();
  assert.equal(events.length, 2);

  const runLog = renderRunLog(state.runId, state, events);
  const metrics = renderMetricsSummary(state.runId, state, events);
  assert.match(runLog, /Run Overview/);
  assert.match(metrics, /Stage Durations/);

  await recorder.regenerateRunLog(state);
  await recorder.regenerateMetrics(state);
  assert.match(await readFile(artifacts.runLogFile, "utf8"), /Run Overview/);
  assert.match(await readFile(artifacts.metricsFile, "utf8"), /Metrics Summary/);
});

test("sink maps checkpoint.created domain events into events.jsonl", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-deeplooper-telemetry-checkpoint-"));
  const artifacts = getRunArtifacts(workspace, "dl-20260601-000002");
  await ensureRunDirectories(artifacts);
  const sink = JsonlTelemetrySink.create(artifacts, "dl-20260601-000002");
  await sink.initialize();

  await sink.record({
    type: "checkpoint.created",
    stage: "goals",
    phase: 1,
    route: "full",
    summary: "Checkpoint committed after stage goals.",
  });

  const events = await sink.readEvents();
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event?.event_type, "checkpoint.created");
  assert.equal(event?.status, "PASS");
  assert.equal(event?.stage, "goals");
  assert.equal(event?.phase, 1);
  assert.equal(event?.route, "full");
  assert.equal(event?.summary, "Checkpoint committed after stage goals.");

  const persisted = await readFile(artifacts.eventsFile, "utf8");
  assert.match(persisted, /"event_type":"checkpoint.created"/);
});

test("metrics summary marks stopped runs as partial", () => {
  const state = Run.start({
    runId: "dl-20260601-000001",
    interactionMode: "automated",
    failurePolicy: "best-effort",
    route: "full",
  }).toSnapshot();
  const stoppedState = {
    ...state,
    route: "full" as const,
    lastCompletedStage: "goals" as const,
    nextStage: "research" as const,
    stagesCompleted: ["goals" as const],
  };

  const metrics = renderMetricsSummary(stoppedState.runId, stoppedState, [
    {
      schema_version: "1.0",
      event_id: "dl-20260601-000001-1",
      sequence: 1,
      ts: "2026-06-01T00:00:00.000Z",
      run_id: stoppedState.runId,
      writer_agent: "deeplooper",
      writer_scope: "orchestrator",
      event_type: "run.completed",
      status: "PARTIAL",
      route: "full",
      summary: "Pipeline stopped. Route: full.",
    },
  ]);

  assert.match(metrics, /Final status:\*\* stopped-partial/);
});
