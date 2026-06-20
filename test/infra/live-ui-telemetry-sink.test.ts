import { test } from "node:test";
import assert from "node:assert/strict";

import type { DomainEvent } from "../../src/domain/event/index.js";
import { Run } from "../../src/domain/run/index.js";
import type { RunState, TelemetryEvent } from "../../src/application/port/index.js";
import {
  breadcrumbFor,
  isMilestoneEvent,
  LiveUiTelemetrySink,
  DEEPLOOPER_PROGRESS_CUSTOM_TYPE,
  type InitializableTelemetrySink,
} from "../../src/infra/pi/live-ui-telemetry-sink.js";
import { renderDashboardLines } from "../../src/infra/pi/widget-render.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ActivityPresenter, SessionActivity } from "../../src/infra/pi/session-activity.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

class StubTelemetrySink implements InitializableTelemetrySink {
  readonly recordedEvents: DomainEvent[] = [];
  readonly regeneratedStates: RunState[] = [];
  initialized = false;

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  async record(event: DomainEvent): Promise<void> {
    this.recordedEvents.push(event);
  }

  async regenerateRunLog(state: RunState): Promise<void> {
    this.regeneratedStates.push(state);
  }

  async regenerateMetrics(_state: RunState): Promise<void> {}

  async readEvents(): Promise<TelemetryEvent[]> {
    return [];
  }
}

interface UiSpy {
  notifyCalls: Array<{ message: string; level: string }>;
  widgetCalls: Array<string[]>;
  setWidget(key: string, lines: string[]): void;
  notify(message: string, level: string): void;
}

interface PiSpy {
  sentMessages: Array<{ customType: string; content: string; display: boolean }>;
  sendMessage(msg: { customType: string; content: string; display: boolean }): void;
}

function createFakeCtx(hasUI: boolean): { ctx: ExtensionCommandContext; ui: UiSpy } {
  const ui: UiSpy = {
    notifyCalls: [],
    widgetCalls: [],
    setWidget(_key: string, lines: unknown) {
      if (Array.isArray(lines)) {
        ui.widgetCalls.push(lines as string[]);
      }
    },
    notify(message: string, level: string) {
      ui.notifyCalls.push({ message, level });
    },
  };

  const ctx = {
    hasUI,
    cwd: "/tmp",
    ui: ui as unknown as ExtensionCommandContext["ui"],
    signal: undefined,
    model: undefined,
    modelRegistry: {} as never,
    isIdle: () => true,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    getContextUsage: () => undefined,
    compact: () => undefined,
    getSystemPrompt: () => "",
    waitForIdle: async () => undefined,
    newSession: async () => ({ cancelled: false }),
    fork: async () => ({ cancelled: false }),
    navigateTree: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
    reload: async () => undefined,
    sessionManager: {
      getCwd: () => "/tmp",
      getSessionDir: () => "/tmp",
      getSessionId: () => "test",
      getSessionFile: () => undefined,
      getLeafId: () => null,
      getLeafEntry: () => undefined,
      getEntry: () => undefined,
      getLabel: () => undefined,
      getBranch: () => [],
      getHeader: () => null,
      getEntries: () => [],
      getTree: () => [],
      getSessionName: () => undefined,
    },
    mode: "tui" as const,
    getSystemPromptOptions: () => ({
      cwd: "/tmp",
      contextFiles: [],
      skills: [],
      selectedTools: [],
      toolSnippets: [],
      promptGuidelines: [],
      appendSystemPrompt: [],
    }),
  } as unknown as ExtensionCommandContext;

  return { ctx, ui };
}

function createFakePi(): { pi: ExtensionAPI; spy: PiSpy } {
  const spy: PiSpy = {
    sentMessages: [],
    sendMessage(msg: { customType: string; content: string; display: boolean }) {
      spy.sentMessages.push(msg);
    },
  };

  const pi = {
    sendMessage: spy.sendMessage.bind(spy),
  } as unknown as ExtensionAPI;

  return { pi, spy };
}

class StubActivityPresenter implements ActivityPresenter {
  readonly domainEvents: import("../../src/domain/event/index.js").DomainEvent[] = [];
  readonly runStateRefreshes: import("../../src/application/port/index.js").RunState[] = [];
  readonly sessionStarts: Array<{ correlationId: string; label: string }> = [];
  readonly sessionActivities: Array<{ correlationId: string; activity: SessionActivity }> = [];
  readonly sessionEnds: string[] = [];
  started = false;
  stopped = false;

  onDomainEvent(event: import("../../src/domain/event/index.js").DomainEvent): void {
    this.domainEvents.push(event);
  }
  onRunStateRefresh(state: import("../../src/application/port/index.js").RunState): void {
    this.runStateRefreshes.push(state);
  }
  onSessionStart(correlationId: string, label: string): void {
    this.sessionStarts.push({ correlationId, label });
  }
  onSessionActivity(correlationId: string, activity: SessionActivity): void {
    this.sessionActivities.push({ correlationId, activity });
  }
  onSessionEnd(correlationId: string): void {
    this.sessionEnds.push(correlationId);
  }
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
}

function makeFullRunState(overrides?: Partial<RunState>): RunState {
  const base = Run.start({
    runId: "dl-20260601-000000",
    userTask: "test task",
    interactionMode: "automated",
    failurePolicy: "best-effort",
    route: "full",
  }).toSnapshot();
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// breadcrumbFor — pure helper tests
// ---------------------------------------------------------------------------

test("breadcrumbFor returns run.started with info level", () => {
  const crumb = breadcrumbFor({ type: "run.started", runId: "r1", route: "full" });
  assert.ok(crumb);
  assert.equal(crumb.level, "info");
  assert.match(crumb.line, /Deeplooper started/);
  assert.match(crumb.line, /full/);
});

test("breadcrumbFor returns run.resumed with info level", () => {
  const crumb = breadcrumbFor({ type: "run.resumed", runId: "r1", route: "full" });
  assert.ok(crumb);
  assert.equal(crumb.level, "info");
  assert.match(crumb.line, /resumed/);
});

test("breadcrumbFor returns run.completed with info level", () => {
  const crumb = breadcrumbFor({ type: "run.completed", runId: "r1", route: "full", status: "PASS" });
  assert.ok(crumb);
  assert.equal(crumb.level, "info");
  assert.match(crumb.line, /PASS/);
});

test("breadcrumbFor returns run.aborted with error level", () => {
  const crumb = breadcrumbFor({ type: "run.aborted", runId: "r1", route: "full", error: "connection lost" });
  assert.ok(crumb);
  assert.equal(crumb.level, "error");
  assert.match(crumb.line, /aborted/);
  assert.match(crumb.line, /connection lost/);
});

test("breadcrumbFor returns stage.completed without a level", () => {
  const crumb = breadcrumbFor({
    type: "stage.completed",
    stage: "goals",
    phase: 1,
    stageInstance: 1,
    route: "full",
    outcome: {
      status: "PASS",
      filesWritten: [],
      summary: "Goals captured.",
    },
    startedAt: "2026-06-01T00:00:00Z",
    endedAt: "2026-06-01T00:00:05Z",
  });
  assert.ok(crumb);
  assert.equal(crumb.level, undefined);
  assert.match(crumb.line, /OK goals/);
  assert.match(crumb.line, /Goals captured/);
});

test("breadcrumbFor returns stage.failed with error level", () => {
  const crumb = breadcrumbFor({
    type: "stage.failed",
    stage: "design",
    phase: 1,
    stageInstance: 1,
    route: "full",
    summary: "Review cap hit.",
  });
  assert.ok(crumb);
  assert.equal(crumb.level, "error");
  assert.match(crumb.line, /FAIL design/);
});

test("breadcrumbFor returns gate.presented with warning level", () => {
  const crumb = breadcrumbFor({
    type: "gate.presented",
    stage: "goals",
    phase: 1,
    stageInstance: 1,
    route: "full",
    summary: "Awaiting approval.",
  });
  assert.ok(crumb);
  assert.equal(crumb.level, "warning");
  assert.match(crumb.line, /approval needed at goals/);
});

test("breadcrumbFor returns backward_loop.decided without a level", () => {
  const crumb = breadcrumbFor({
    type: "backward_loop.decided",
    stage: "slice-loop",
    phase: 1,
    stageInstance: 1,
    route: "full",
    targetStage: "design",
    request: { classification: "LOOP_DESIGN", summary: "Plan needs revision." },
  });
  assert.ok(crumb);
  assert.equal(crumb.level, undefined);
  assert.match(crumb.line, /loop back to design/);
});

test("breadcrumbFor returns backward_loop.failed with error level", () => {
  const crumb = breadcrumbFor({
    type: "backward_loop.failed",
    stage: "slice-loop",
    phase: 1,
    stageInstance: 1,
    route: "full",
    classification: "LOOP_DESIGN",
    maxLoops: 3,
  });
  assert.ok(crumb);
  assert.equal(crumb.level, "error");
  assert.match(crumb.line, /cap reached/);
});

test("breadcrumbFor returns a breadcrumb for stage.started", () => {
  const crumb = breadcrumbFor({
    type: "stage.started",
    stage: "research",
    phase: 1,
    stageInstance: 1,
    route: "full",
  });
  assert.ok(crumb !== undefined);
  assert.match(crumb.line, /research/);
});

test("breadcrumbFor returns undefined for backward_loop.requested (silent)", () => {
  const crumb = breadcrumbFor({
    type: "backward_loop.requested",
    stage: "slice-loop",
    phase: 1,
    stageInstance: 1,
    route: "full",
    request: { classification: "LOOP_DESIGN", summary: "Need replan." },
  });
  assert.equal(crumb, undefined);
});

// ---------------------------------------------------------------------------
// renderDashboardLines — pure helper tests (moved to widget-render.ts)
// ---------------------------------------------------------------------------

test("renderDashboardLines returns starting line when no state", () => {
  const lines = renderDashboardLines({}, new Map());
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /starting/);
});

test("renderDashboardLines full route: no skipped stages, shows ✓ for completed, ▶ for current", () => {
  const state = makeFullRunState({
    route: "full",
    stagesCompleted: ["goals", "research"],
    // currentPhase:  1
    lastCompletedStage: "research",
    nextStage: "design",
    backwardLoops: 1,
  });

  const lines = renderDashboardLines(
    { state, currentStage: "design", stageStartedAt: Date.now() - 30_000, runStartedAt: Date.now() - 120_000 },
    new Map(),
    Date.now(),
  );

  assert.equal(lines.length, 5);
  // Header contains run ID and route
  assert.match(lines[0] ?? "", /dl-20260601-000000/);
  assert.match(lines[0] ?? "", /full/);

  // Stage row: goals✓ research✓ design▶ — no dashes (full route)
  const stageRow = lines[1] ?? "";
  assert.match(stageRow, /goals✓/);
  assert.match(stageRow, /research✓/);
  assert.match(stageRow, /design▶/);
  assert.doesNotMatch(stageRow, /design-/);
  assert.doesNotMatch(stageRow, /structure-/);

  // Slice/stage line shows current stage
  assert.match(lines[2] ?? "", /design/);

  // Loop counters
  assert.match(lines[3] ?? "", /backward 1\/3/);

  // Last
  assert.match(lines[4] ?? "", /last: research/);
});

test("renderDashboardLines full route: design▶ shown when current stage is design", () => {
  const state = makeFullRunState({
    route: "full",
    stagesCompleted: ["goals", "research"],
    lastCompletedStage: "research",
    nextStage: "design",
  });

  const lines = renderDashboardLines({ state, currentStage: "design" }, new Map(), Date.now());
  const stageRow = lines[1] ?? "";

  assert.match(stageRow, /design▶/);
  assert.match(stageRow, /skeleton /);
});

test("renderDashboardLines marks a re-executed completed stage as current (▶ wins over ✓)", () => {
  // Verify-fix/accept-fix loops route back to "slice-loop", which stays in
  // stagesCompleted via appendUniqueStage. The active stage must still render ▶.
  const state = makeFullRunState({
    route: "full",
    stagesCompleted: ["goals", "research", "design", "skeleton", "design", "slice-loop"],
    // currentPhase:  1
    lastCompletedStage: "verify",
    nextStage: "slice-loop",
  });

  const lines = renderDashboardLines({ state, currentStage: "slice-loop" }, new Map(), Date.now());
  const stageRow = lines[1] ?? "";

  assert.match(stageRow, /slice-loop▶/);
  assert.doesNotMatch(stageRow, /slice-loop✓/);
  // Earlier completed stages that are not the active one keep their ✓.
  assert.match(stageRow, /goals✓/);
  assert.match(stageRow, /design✓/);
});

test("renderDashboardLines shows last summary when available", () => {
  const state = makeFullRunState({
    lastCompletedStage: "goals",
    nextStage: "research",
    stagesCompleted: ["goals"],
  });

  const lines = renderDashboardLines({ state, lastSummary: "Goals captured and approved. Route: full." }, new Map());
  assert.match(lines[4] ?? "", /Goals captured/);
});

test("renderDashboardLines elapsed timer uses fixed nowMs", () => {
  const started = 1_000_000;
  const now = started + 90_000; // 1m30s

  const state = makeFullRunState({ nextStage: "goals", stagesCompleted: [] });
  const lines = renderDashboardLines(
    { state, runStartedAt: started, stageStartedAt: started + 60_000 },
    new Map(),
    now,
  );

  assert.match(lines[0] ?? "", /01:30/); // run elapsed
  assert.match(lines[2] ?? "", /00:30/); // stage running
});

// ---------------------------------------------------------------------------
// isMilestoneEvent — filter tests
// ---------------------------------------------------------------------------

test("isMilestoneEvent returns true for run lifecycle events", () => {
  assert.ok(isMilestoneEvent({ type: "run.started", runId: "r1", route: "full" }));
  assert.ok(isMilestoneEvent({ type: "run.resumed", runId: "r1", route: "full" }));
  assert.ok(isMilestoneEvent({ type: "run.completed", runId: "r1", route: "full", status: "PASS" }));
  assert.ok(isMilestoneEvent({ type: "run.aborted", runId: "r1", route: "full", error: "boom" }));
});

test("isMilestoneEvent returns true for terminal stage outcomes (completed/failed/skipped) but not stage.started", () => {
  assert.ok(
    isMilestoneEvent({
      type: "stage.completed",
      stage: "goals",
      phase: 1,
      stageInstance: 1,
      route: "full",
      outcome: { status: "PASS", filesWritten: [], summary: "done" },
      startedAt: "2026-06-01T00:00:00Z",
      endedAt: "2026-06-01T00:00:05Z",
    }),
  );
  assert.ok(
    isMilestoneEvent({
      type: "stage.failed",
      stage: "design",
      phase: 1,
      stageInstance: 1,
      route: "full",
      summary: "failed",
    }),
  );
  // stage.skipped (e.g. design/structure on the quick-fix route) must also be a
  // permanent transcript milestone, consistent with completed and failed.
  assert.ok(
    isMilestoneEvent({
      type: "stage.skipped",
      stage: "design",
      phase: 1,
      stageInstance: 1,
      route: "full",
      summary: "skipped on quick-fix route",
    }),
  );
  assert.equal(
    isMilestoneEvent({ type: "stage.started", stage: "goals", phase: 1, stageInstance: 1, route: "full" }),
    false,
  );
});

test("isMilestoneEvent returns true for gate events", () => {
  assert.ok(
    isMilestoneEvent({
      type: "gate.presented",
      stage: "goals",
      phase: 1,
      stageInstance: 1,
      route: "full",
      summary: "x",
    }),
  );
  assert.ok(
    isMilestoneEvent({
      type: "gate.approved",
      stage: "goals",
      phase: 1,
      stageInstance: 1,
      route: "full",
      summary: "approved",
    }),
  );
  assert.ok(
    isMilestoneEvent({
      type: "gate.rejected",
      stage: "goals",
      phase: 1,
      stageInstance: 1,
      route: "full",
      summary: "rejected",
    }),
  );
});

test("isMilestoneEvent returns false for dispatch events", () => {
  assert.equal(
    isMilestoneEvent({ type: "dispatch.started", stage: "goals", phase: 1, route: "full", childAgent: "x" }),
    false,
  );
  assert.equal(
    isMilestoneEvent({
      type: "dispatch.completed",
      stage: "goals",
      phase: 1,
      route: "full",
      childAgent: "x",
      status: "PASS",
    }),
    false,
  );
});

// ---------------------------------------------------------------------------
// LiveUiTelemetrySink integration tests
// ---------------------------------------------------------------------------

test("LiveUiTelemetrySink.initialize() delegates to inner sink", async () => {
  const inner = new StubTelemetrySink();
  const { ctx } = createFakeCtx(false);
  const { pi } = createFakePi();
  const sink = new LiveUiTelemetrySink(inner, pi, ctx);

  await sink.initialize();
  assert.ok(inner.initialized);
});

test("LiveUiTelemetrySink.record() always forwards to inner sink", async () => {
  const inner = new StubTelemetrySink();
  const { ctx } = createFakeCtx(false); // hasUI: false
  const { pi } = createFakePi();
  const sink = new LiveUiTelemetrySink(inner, pi, ctx);

  const event: DomainEvent = { type: "run.started", runId: "r1", route: "full" };
  await sink.record(event);

  assert.equal(inner.recordedEvents.length, 1);
  assert.equal(inner.recordedEvents[0]?.type, "run.started");
});

test("LiveUiTelemetrySink.regenerateRunLog() forwards and caches state", async () => {
  const inner = new StubTelemetrySink();
  const { ctx } = createFakeCtx(false);
  const { pi } = createFakePi();
  const sink = new LiveUiTelemetrySink(inner, pi, ctx);
  const state = makeFullRunState();

  await sink.regenerateRunLog(state);

  assert.equal(inner.regeneratedStates.length, 1);
  assert.equal(inner.regeneratedStates[0]?.runId, state.runId);
});

test("LiveUiTelemetrySink.regenerateMetrics() forwards to inner sink", async () => {
  const inner = new StubTelemetrySink();
  const { ctx } = createFakeCtx(false);
  const { pi } = createFakePi();
  const sink = new LiveUiTelemetrySink(inner, pi, ctx);
  const state = makeFullRunState();

  // Should not throw and inner should be called
  await sink.regenerateMetrics(state);
  // No errors means forward happened (StubTelemetrySink.regenerateMetrics is a no-op but doesn't throw)
});

test("LiveUiTelemetrySink.readEvents() delegates to inner sink", async () => {
  const inner = new StubTelemetrySink();
  const { ctx } = createFakeCtx(false);
  const { pi } = createFakePi();
  const sink = new LiveUiTelemetrySink(inner, pi, ctx);

  const result = await sink.readEvents();
  assert.deepEqual(result, []);
});

test("LiveUiTelemetrySink with hasUI:false skips UI calls", async () => {
  const inner = new StubTelemetrySink();
  const { ctx, ui } = createFakeCtx(false);
  const { pi, spy } = createFakePi();
  const sink = new LiveUiTelemetrySink(inner, pi, ctx);

  await sink.record({ type: "run.started", runId: "r1", route: "full" });

  assert.equal(ui.notifyCalls.length, 0);
  assert.equal(ui.widgetCalls.length, 0);
  assert.equal(spy.sentMessages.length, 0);
});

test("LiveUiTelemetrySink with hasUI:true sends breadcrumbs for milestone events", async () => {
  const inner = new StubTelemetrySink();
  const { ctx, ui } = createFakeCtx(true);
  const { pi, spy } = createFakePi();
  const sink = new LiveUiTelemetrySink(inner, pi, ctx);

  // run.started should produce a breadcrumb with info level
  await sink.record({ type: "run.started", runId: "r1", route: "full" });

  assert.equal(spy.sentMessages.length, 1);
  const msg = spy.sentMessages[0];
  assert.ok(msg);
  assert.equal(msg.customType, DEEPLOOPER_PROGRESS_CUSTOM_TYPE);
  assert.equal(msg.display, true);
  assert.match(msg.content, /Deeplooper started/);

  assert.equal(ui.notifyCalls.length, 1);
  assert.equal(ui.notifyCalls[0]?.level, "info");
});

test("LiveUiTelemetrySink stage.started does not produce a transcript milestone (strip only)", async () => {
  const inner = new StubTelemetrySink();
  const { ctx } = createFakeCtx(true);
  const { pi, spy } = createFakePi();
  const presenter = new StubActivityPresenter();
  const sink = new LiveUiTelemetrySink(inner, pi, ctx, presenter);

  await sink.record({ type: "stage.started", stage: "goals", phase: 1, stageInstance: 1, route: "full" });

  // stage.started is strip-only, not a transcript milestone
  assert.equal(spy.sentMessages.length, 0);
  // but the presenter does receive the event
  assert.equal(presenter.domainEvents.length, 1);
  assert.equal(presenter.domainEvents[0]?.type, "stage.started");
});

test("LiveUiTelemetrySink gate.presented triggers warning notification", async () => {
  const inner = new StubTelemetrySink();
  const { ctx, ui } = createFakeCtx(true);
  const { pi } = createFakePi();
  const sink = new LiveUiTelemetrySink(inner, pi, ctx);

  await sink.record({
    type: "gate.presented",
    stage: "goals",
    phase: 1,
    stageInstance: 1,
    route: "full",
    summary: "Awaiting approval.",
  });

  assert.equal(ui.notifyCalls.length, 1);
  assert.equal(ui.notifyCalls[0]?.level, "warning");
});

test("LiveUiTelemetrySink stage.failed triggers error notification", async () => {
  const inner = new StubTelemetrySink();
  const { ctx, ui } = createFakeCtx(true);
  const { pi } = createFakePi();
  const sink = new LiveUiTelemetrySink(inner, pi, ctx);

  await sink.record({
    type: "stage.failed",
    stage: "design",
    phase: 1,
    stageInstance: 1,
    route: "full",
    summary: "Review cap hit.",
  });

  assert.equal(ui.notifyCalls.length, 1);
  assert.equal(ui.notifyCalls[0]?.level, "error");
});

test("LiveUiTelemetrySink regenerateRunLog notifies presenter when hasUI:true", async () => {
  const inner = new StubTelemetrySink();
  const { ctx } = createFakeCtx(true);
  const { pi } = createFakePi();
  const presenter = new StubActivityPresenter();
  const sink = new LiveUiTelemetrySink(inner, pi, ctx, presenter);
  const state = makeFullRunState({ stagesCompleted: ["goals"], lastCompletedStage: "goals" });

  await sink.regenerateRunLog(state);

  // Presenter should receive the run state for widget refresh
  assert.equal(presenter.runStateRefreshes.length, 1);
  assert.equal(presenter.runStateRefreshes[0]?.runId, state.runId);
});

test("LiveUiTelemetrySink full event sequence produces milestone transcript entries only", async () => {
  const inner = new StubTelemetrySink();
  const { ctx, ui } = createFakeCtx(true);
  const { pi, spy } = createFakePi();
  const presenter = new StubActivityPresenter();
  const sink = new LiveUiTelemetrySink(inner, pi, ctx, presenter);

  const events: DomainEvent[] = [
    { type: "run.started", runId: "r1", route: "full" },
    { type: "stage.started", stage: "goals", phase: 1, stageInstance: 1, route: "full" },
    {
      type: "stage.completed",
      stage: "goals",
      phase: 1,
      stageInstance: 1,
      route: "full",
      outcome: { status: "PASS", filesWritten: [], summary: "Goals captured." },
      startedAt: "2026-06-01T00:00:00Z",
      endedAt: "2026-06-01T00:00:05Z",
    },
    {
      type: "backward_loop.decided",
      stage: "slice-loop",
      phase: 1,
      stageInstance: 1,
      route: "full",
      targetStage: "design",
      request: { classification: "LOOP_DESIGN", summary: "Plan revision needed." },
    },
    {
      type: "gate.presented",
      stage: "design",
      phase: 1,
      stageInstance: 1,
      route: "full",
      summary: "Approve design?",
    },
    { type: "run.completed", runId: "r1", route: "full", status: "PASS" },
  ];

  for (const event of events) {
    await sink.record(event);
  }

  // stage.started is strip-only (not a milestone) — 5 transcript messages
  assert.equal(spy.sentMessages.length, 5);

  const contents = spy.sentMessages.map((m) => m.content);
  assert.match(contents[0] ?? "", /Deeplooper started/);
  // stage.started does NOT appear in transcript; index 1 is now stage.completed
  assert.match(contents[1] ?? "", /OK goals/);
  assert.match(contents[2] ?? "", /loop back to design/);
  assert.match(contents[3] ?? "", /approval needed at design/);
  assert.match(contents[4] ?? "", /Deeplooper PASS/);

  // gate.presented triggers warning notify
  const warningNotify = ui.notifyCalls.find((n) => n.level === "warning");
  assert.ok(warningNotify);
  assert.match(warningNotify.message, /approval needed/);

  // All 6 events reach the presenter
  assert.equal(presenter.domainEvents.length, 6);
});

test("breadcrumbFor returns undefined for dispatch.started (widget-only)", () => {
  const crumb = breadcrumbFor({
    type: "dispatch.started",
    stage: "goals",
    phase: 1,
    route: "full",
    childAgent: "dl-goals-synthesizer",
  });
  assert.equal(crumb, undefined);
});

test("breadcrumbFor returns undefined for dispatch.completed (widget-only)", () => {
  const crumb = breadcrumbFor({
    type: "dispatch.completed",
    stage: "goals",
    phase: 1,
    route: "full",
    childAgent: "dl-goals-synthesizer",
    status: "PASS",
  });
  assert.equal(crumb, undefined);
});

test("LiveUiTelemetrySink forwards dispatch events to presenter (activity tracking moved to presenter)", async () => {
  const inner = new StubTelemetrySink();
  const { ctx } = createFakeCtx(true);
  const { pi } = createFakePi();
  const presenter = new StubActivityPresenter();
  const sink = new LiveUiTelemetrySink(inner, pi, ctx, presenter);

  const state = makeFullRunState({ nextStage: "goals", stagesCompleted: [] });
  await sink.regenerateRunLog(state);

  await sink.record({ type: "stage.started", stage: "goals", phase: 1, stageInstance: 1, route: "full" });
  await sink.record({
    type: "dispatch.started",
    stage: "goals",
    phase: 1,
    route: "full",
    childAgent: "dl-goals-synthesizer",
  });
  await sink.record({
    type: "stage.completed",
    stage: "goals",
    phase: 1,
    stageInstance: 1,
    route: "full",
    outcome: { status: "PASS", filesWritten: [], summary: "Done." },
    startedAt: "2026-06-01T00:00:00Z",
    endedAt: "2026-06-01T00:00:05Z",
  });

  // All domain events forwarded to presenter
  assert.equal(presenter.domainEvents.length, 3);
  assert.equal(presenter.domainEvents[1]?.type, "dispatch.started");
  assert.equal(presenter.domainEvents[2]?.type, "stage.completed");

  // run state refresh also forwarded
  assert.equal(presenter.runStateRefreshes.length, 1);
});
