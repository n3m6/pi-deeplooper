// Markdown render functions for run-log.md and metrics-summary.md.

import type { Route, RunState, StageName, TelemetryEvent } from "../../application/port/index.js";

export function renderRunLog(runId: string, state: RunState, events: TelemetryEvent[]): string {
  const started = events.find((event) => event.event_type === "run.started")?.ts ?? state.startedAt;
  const finished = [...events]
    .reverse()
    .find((e) => e.event_type === "run.completed" || e.event_type === "run.aborted")?.ts;
  const resumes = events.filter((event) => event.event_type === "run.resumed").length;
  const currentStatus = resolveRunStatus(events, finished);
  const timelineRows = events.map(renderTimelineRow);
  const failureRows = events.filter(isFailureOrLoopEvent).map(renderFailureRow);
  const currentSignal = state.nextStage === "done" ? "Run complete." : `Next stage: ${state.nextStage}.`;

  return [
    `# Run Log — ${runId}`,
    "",
    "## Run Overview",
    "",
    `- **Run ID:** ${runId}`,
    `- **Route:** ${state.route}`,
    `- **Status:** ${currentStatus}`,
    `- **Started:** ${started}`,
    `- **Completed / Aborted:** ${finished ?? "—"}`,
    `- **Resume count:** ${resumes}`,
    `- **Stages completed:** ${state.stagesCompleted.length > 0 ? state.stagesCompleted.join(", ") : "—"}`,
    `- **Next stage:** ${state.nextStage}`,
    "",
    "## Current Status",
    "",
    currentSignal,
    "",
    "## Timeline",
    "",
    "| Time (UTC) | Seq | Scope | Event | Status | Summary | Artifacts |",
    "| ---------- | --- | ----- | ----- | ------ | ------- | --------- |",
    ...(timelineRows.length > 0 ? timelineRows : ["| — | — | run | — | — | No events yet. | — |"]),
    "",
    "## Active Slice Snapshot",
    "",
    `- **Current slice:** ${state.currentSlice ?? "—"}`,
    `- **Current stage:** ${state.nextStage === "done" ? "done" : state.nextStage}`,
    `- **Slices done:** ${state.slicesDone.length}`,
    `- **Acceptance state:** ${events.some((e) => e.stage === "accept" && e.event_type === "stage.completed") ? "complete" : "pending"}`,
    `- **Outstanding blockers:** ${failureRows.length > 0 ? failureRows.length : "none"}`,
    "",
    "## Failure and Loop Index",
    "",
    "| Type | Stage | Phase | Round | Summary | Artifact |",
    "| ---- | ----- | ----- | ----- | ------- | -------- |",
    ...(failureRows.length > 0 ? failureRows : ["_(Empty when no failures or loops have occurred.)_"]),
    "",
    "## Artifact Index",
    "",
    "- `state.json` — current recovery state",
    "- `config.md` — route and metadata",
    "- `goals.md` — distilled intent",
    "- `slice-queue.md` — vertical slice queue",
    "- `telemetry/events.jsonl` — full event stream",
    "",
  ].join("\n");
}

export function renderMetricsSummary(runId: string, state: RunState, events: TelemetryEvent[]): string {
  const stageDurations = buildStageDurations(events);
  const childCalls = aggregateChildCalls(events);
  const reviewRounds = aggregateReviewRounds(events);
  const gateRows = aggregateGateRows(events);
  const evidenceRows = aggregateEvidence(events);
  const route = state.route;
  const runTerminalEvent = [...events]
    .reverse()
    .find((event) => event.event_type === "run.completed" || event.event_type === "run.aborted");
  const finalStatus = resolveRunFinalStatus(runTerminalEvent, state);
  const started = events.find((event) => event.event_type === "run.started")?.ts ?? state.startedAt;
  const ended = runTerminalEvent?.ts;

  return [
    `# Metrics Summary — ${runId}`,
    "",
    "## Run",
    "",
    `- **Route:** ${route}`,
    `- **Final status:** ${finalStatus}`,
    `- **Total duration:** ${durationSeconds(started, ended)} s`,
    `- **Stages completed:** ${state.stagesCompleted.length} of 10`,
    `- **Resume count:** ${events.filter((event) => event.event_type === "run.resumed").length}`,
    `- **Backward loop count:** ${state.backwardLoops}`,
    "",
    "## Stage Durations",
    "",
    "| Stage | Phase | Duration (s) | Status |",
    "| ----- | ----- | ------------ | ------ |",
    ...stageDurations,
    "",
    "## Child Agent Calls",
    "",
    "| Stage | Child Agent | Calls | Pass | Fail |",
    "| ----- | ----------- | ----- | ---- | ---- |",
    ...(childCalls.length > 0 ? childCalls : ["| — | — | 0 | 0 | 0 |"]),
    "",
    "## Review Rounds",
    "",
    "| Stage | Type | Rounds |",
    "| ----- | ---- | ------ |",
    ...(reviewRounds.length > 0 ? reviewRounds : ["| — | — | 0 |"]),
    "",
    "## Retry and Loop Counts",
    "",
    `- **Stage retries:** ${events.filter((event) => event.event_type === "stage.retried").length}`,
    `- **E2E remediation rounds:** ${countStage(events, "e2e-regression", "stage.retried")}`,
    `- **Regression remediation rounds:** ${countStage(events, "baseline-regression", "stage.retried")}`,
    `- **Acceptance loop rounds:** ${countStage(events, "accept", "stage.retried")}`,
    `- **Review round cap hits:** ${events.filter((event) => event.context?.terminal_review_state === "unclean-cap").length}`,
    `- **Backward loops:** ${state.backwardLoops}`,
    "",
    "## Human Gate Outcomes",
    "",
    "| Stage | Presentations | Rejections | Approvals |",
    "| ----- | ------------- | ---------- | --------- |",
    ...(gateRows.length > 0 ? gateRows : ["| — | 0 | 0 | 0 |"]),
    "",
    "## Test Evidence Quality",
    "",
    "| Phase | Deterministic | Flaky | Harness Noisy | Ambiguous | Redundant | No-Test Tasks | No-Test Audit Overrides |",
    "| ----- | ------------- | ----- | ------------- | --------- | --------- | ------------- | ----------------------- |",
    ...(evidenceRows.length > 0 ? evidenceRows : ["| 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |"]),
    "",
    "## Code Health",
    "",
    `- **Coverage status:** ${state.verifyStatus ?? "SKIPPED"}`,
    `- **Design terminal review state:** ${
      events
        .filter((e) => e.stage === "design" && e.context?.terminal_review_state)
        .map((e) => e.context?.terminal_review_state)
        .join(", ") || "none"
    }`,
    "",
  ].join("\n");
}

export function createRunEventSummary(stage: StageName | undefined, route: Route, verb: string): string {
  return stage ? `Stage ${stage} ${verb}. Route: ${route}.` : `Pipeline ${verb}. Route: ${route}.`;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function resolveRunFinalStatus(runTerminalEvent: TelemetryEvent | undefined, state: RunState): string {
  if (runTerminalEvent?.event_type === "run.aborted") return "aborted";
  if (state.nextStage !== "done" || runTerminalEvent?.status === "PARTIAL") return "stopped-partial";
  if (state.verifyStatus === "FAIL") return "completed-fail";
  if (state.verifyStatus === "PARTIAL") return "completed-partial";
  return "completed-pass";
}

function resolveRunStatus(events: TelemetryEvent[], finished: string | undefined): string {
  if (!finished) return "in-progress";
  return events.some((e) => e.event_type === "run.aborted") ? "aborted" : "completed";
}

function isFailureOrLoopEvent(event: TelemetryEvent): boolean {
  return event.event_type.startsWith("backward_loop") || event.event_type === "stage.failed";
}

function renderTimelineRow(event: TelemetryEvent): string {
  const scope = event.stage ? `stage:${event.stage}` : "run";
  const artifacts = event.artifacts && event.artifacts.length > 0 ? event.artifacts.join(", ") : "—";
  return `| ${timeOnly(event.ts)} | ${event.sequence} | ${scope} | ${event.event_type} | ${event.status} | ${event.summary} | ${artifacts} |`;
}

function renderFailureRow(event: TelemetryEvent): string {
  const type = event.event_type.startsWith("backward_loop") ? "backward_loop" : event.event_type;
  const artifact = event.artifacts?.[0] ?? "—";
  return `| ${type} | ${event.stage ?? "—"} | ${event.phase ?? "—"} | ${event.review_round ?? "—"} | ${event.summary} | ${artifact} |`;
}

function buildStageDurations(events: TelemetryEvent[]): string[] {
  const starts = new Map<string, TelemetryEvent>();
  const rows: string[] = [];

  for (const event of events) {
    const key = `${event.stage ?? "run"}:${event.phase ?? 0}:${event.stage_instance ?? 0}`;
    if (event.event_type === "stage.started") {
      starts.set(key, event);
      continue;
    }
    if (!event.event_type.startsWith("stage.") || !event.stage) {
      continue;
    }
    const start = starts.get(key);
    const duration = start ? durationSeconds(start.ts, event.ts) : "skipped";
    rows.push(`| ${event.stage} | ${event.phase ?? "—"} | ${duration} | ${event.status} |`);
  }

  return rows.length > 0 ? rows : ["| goals | — | skipped | skip |"];
}

function aggregateChildCalls(events: TelemetryEvent[]): string[] {
  const rows: string[] = [];
  for (const event of events) {
    if (!event.stage || !event.context?.child_agent_calls || typeof event.context.child_agent_calls !== "object") {
      continue;
    }
    for (const [child, value] of Object.entries(event.context.child_agent_calls as Record<string, unknown>)) {
      const calls = typeof value === "number" ? value : 0;
      rows.push(`| ${event.stage} | ${child} | ${calls} | ${calls} | 0 |`);
    }
  }
  return rows;
}

function aggregateReviewRounds(events: TelemetryEvent[]): string[] {
  return events
    .filter((event) => Boolean(event.stage) && typeof event.context?.review_rounds === "number")
    .map((event) => {
      const reviewType = typeof event.context?.review_type === "string" ? event.context.review_type : "reviewer";
      const reviewRounds = typeof event.context?.review_rounds === "number" ? event.context.review_rounds : 0;
      return `| ${event.stage ?? "—"} | ${reviewType} | ${reviewRounds} |`;
    });
}

function aggregateGateRows(events: TelemetryEvent[]): string[] {
  const totals = new Map<StageName, { presented: number; rejected: number; approved: number }>();
  for (const event of events) {
    if (!event.stage || !event.event_type.startsWith("gate.")) {
      continue;
    }
    const current = totals.get(event.stage) ?? { presented: 0, rejected: 0, approved: 0 };
    if (event.event_type === "gate.presented") {
      current.presented += 1;
    } else if (event.event_type === "gate.rejected") {
      current.rejected += 1;
    } else if (event.event_type === "gate.approved") {
      current.approved += 1;
    }
    totals.set(event.stage, current);
  }
  return [...totals.entries()].map(
    ([stage, counts]) => `| ${stage} | ${counts.presented} | ${counts.rejected} | ${counts.approved} |`,
  );
}

function aggregateEvidence(events: TelemetryEvent[]): string[] {
  const phases = new Map<
    number,
    {
      deterministic: number;
      flaky: number;
      harnessNoisy: number;
      ambiguous: number;
      redundant: number;
      noTestTasks: number;
      noTestAuditOverrides: number;
    }
  >();
  for (const event of events) {
    if (!event.phase || !event.context?.evidence_quality || typeof event.context.evidence_quality !== "object") {
      continue;
    }
    const current = phases.get(event.phase) ?? {
      deterministic: 0,
      flaky: 0,
      harnessNoisy: 0,
      ambiguous: 0,
      redundant: 0,
      noTestTasks: 0,
      noTestAuditOverrides: 0,
    };
    const evidence = event.context.evidence_quality as Record<string, unknown>;
    current.deterministic += numberValue(evidence.deterministic);
    current.flaky += numberValue(evidence.flaky);
    current.harnessNoisy += numberValue(evidence.harnessNoisy);
    current.ambiguous += numberValue(evidence.ambiguous);
    current.redundant += numberValue(evidence.redundant);
    current.noTestTasks += numberValue(evidence.noTestTasks);
    current.noTestAuditOverrides += numberValue(evidence.noTestAuditOverrides);
    phases.set(event.phase, current);
  }

  return [...phases.entries()].map(
    ([phase, evidence]) =>
      `| ${phase} | ${evidence.deterministic} | ${evidence.flaky} | ${evidence.harnessNoisy} | ${evidence.ambiguous} | ${evidence.redundant} | ${evidence.noTestTasks} | ${evidence.noTestAuditOverrides} |`,
  );
}

function countStage(events: TelemetryEvent[], stage: string, eventType: string): number {
  return events.filter((event) => event.stage === stage && event.event_type === eventType).length;
}

function durationSeconds(startedAt: string | undefined, endedAt: string | undefined): string {
  if (!startedAt || !endedAt) {
    return "0";
  }
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return "0";
  }
  return String(Math.max(0, Math.round((end - start) / 1000)));
}

function timeOnly(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toISOString().slice(11, 19);
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
