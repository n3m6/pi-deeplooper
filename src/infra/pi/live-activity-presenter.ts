/**
 * LiveActivityPresenter — central coordinator for the three deeplooper TUI widgets.
 *
 * Widgets (all placement: "aboveEditor"):
 *   deeplooper:dashboard — always visible, updated by ~1s heartbeat
 *   deeplooper:strip     — breadcrumb strip, visible while sessions are active
 *   deeplooper:box       — bordered activity box, visible while sessions are active
 *
 * All side effects are gated on ctx.hasUI so headless runs are unaffected.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { DomainEvent } from "../../domain/event/index.js";
import type { RunState } from "../../application/port/index.js";
import type { ActivityPresenter, SessionActivity } from "./session-activity.js";
import { eventLabelFor } from "./event-label.js";
import {
  ACTIVITY_BOX_MAX_LINES,
  BREADCRUMB_STRIP_MAX_LINES,
  renderActivityBoxLines,
  renderBreadcrumbStripLines,
  renderDashboardLines,
  type RunView,
  type TaskActivity,
} from "./widget-render.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DASHBOARD_KEY = "deeplooper:dashboard";
const STRIP_KEY = "deeplooper:strip";
const BOX_KEY = "deeplooper:box";
/** Legacy key used by the pre-refactor single-widget; cleared on start. */
const LEGACY_KEY = "deeplooper";

const HEARTBEAT_MS = 1000;
const BOX_THROTTLE_MS = 150;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the TUI strip label for a domain event, or undefined to skip.
 *
 * Delegates to eventLabelFor() for shared cases. Overrides only where the strip
 * intentionally differs from the transcript breadcrumbs:
 *   - slice.started: uses ": " (breadcrumb uses " starting: ")
 *   - slice.completed, requeue.requested, requeue.exhausted: not shown in the strip
 */
function stripLineFor(event: DomainEvent): string | undefined {
  if (event.type === "slice.started") {
    return `slice ${event.sliceId}: ${event.sliceTitle}`;
  }
  if (event.type === "slice.completed" || event.type === "requeue.requested" || event.type === "requeue.exhausted") {
    return undefined;
  }
  return eventLabelFor(event)?.line;
}

// ---------------------------------------------------------------------------
// LiveActivityPresenter
// ---------------------------------------------------------------------------

export class LiveActivityPresenter implements ActivityPresenter {
  private view: RunView = {};
  private readonly tasks = new Map<string, TaskActivity>();
  private readonly crumbs: string[] = [];
  private lastActiveCorrelationId: string | undefined;
  private boxRepaintPending = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private boxThrottleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly ctx: ExtensionCommandContext) {}

  // ---------------------------------------------------------------------------
  // ActivityPresenter implementation
  // ---------------------------------------------------------------------------

  onDomainEvent(event: DomainEvent): void {
    this.applyEventToView(event);
    const crumb = stripLineFor(event);
    if (crumb) {
      this.crumbs.push(crumb);
      // Keep the crumb list bounded (4x the visible strip size)
      const limit = BREADCRUMB_STRIP_MAX_LINES * 4;
      if (this.crumbs.length > limit) {
        this.crumbs.splice(0, this.crumbs.length - limit);
      }
    }
    this.repaintDashboard();
    if (this.tasks.size > 0) {
      this.repaintStrip();
    }
  }

  onRunStateRefresh(state: RunState): void {
    this.view = { ...this.view, state };
    this.repaintDashboard();
  }

  onSessionStart(correlationId: string, label: string): void {
    this.tasks.set(correlationId, {
      correlationId,
      label,
      startedAt: Date.now(),
      lastTool: undefined,
      turnCount: 0,
      ringBuffer: [],
    });
    this.lastActiveCorrelationId = correlationId;
    this.repaintAll();
  }

  onSessionActivity(correlationId: string, activity: SessionActivity): void {
    const task = this.tasks.get(correlationId);
    if (!task) return;
    this.lastActiveCorrelationId = correlationId;

    switch (activity.kind) {
      case "turn_start":
        task.turnCount = activity.turnCount;
        this.repaintAll();
        break;

      case "tool_start": {
        task.lastTool = activity.toolName;
        const label = activity.command ? `${activity.toolName}: ${activity.command}` : activity.toolName;
        this.pushToRingBuffer(task, label);
        this.repaintAll();
        break;
      }

      case "tool_output_chunk": {
        for (const line of activity.tail) {
          this.pushToRingBuffer(task, line);
        }
        this.scheduleBoxRepaint();
        break;
      }

      case "tool_end":
        // Just let the next heartbeat pick this up
        break;

      case "assistant_delta":
        this.pushToRingBuffer(task, `↩ ${activity.text}`);
        this.repaintAll();
        break;
    }
  }

  onSessionEnd(correlationId: string): void {
    this.tasks.delete(correlationId);
    if (this.lastActiveCorrelationId === correlationId) {
      this.lastActiveCorrelationId = [...this.tasks.keys()].at(-1);
    }
    if (!this.ctx.hasUI) return;
    if (this.tasks.size === 0) {
      this.ctx.ui.setWidget(STRIP_KEY, undefined, { placement: "aboveEditor" });
      this.ctx.ui.setWidget(BOX_KEY, undefined, { placement: "aboveEditor" });
    } else {
      this.repaintAll();
    }
    this.repaintDashboard();
  }

  start(): void {
    if (!this.ctx.hasUI) return;
    // Clear legacy key so the old single-widget doesn't linger
    this.ctx.ui.setWidget(LEGACY_KEY, undefined);
    // Initial render
    this.repaintDashboard();
    // Heartbeat: advances the spinner and keeps elapsed timers live
    this.heartbeatTimer = setInterval(() => {
      this.view = {
        ...this.view,
        spinnerFrame: ((this.view.spinnerFrame ?? 0) + 1) % 10,
      };
      this.repaintDashboard();
    }, HEARTBEAT_MS);
  }

  stop(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.boxThrottleTimer !== undefined) {
      clearTimeout(this.boxThrottleTimer);
      this.boxThrottleTimer = undefined;
    }
    if (!this.ctx.hasUI) return;
    this.ctx.ui.setWidget(DASHBOARD_KEY, undefined, { placement: "aboveEditor" });
    this.ctx.ui.setWidget(STRIP_KEY, undefined, { placement: "aboveEditor" });
    this.ctx.ui.setWidget(BOX_KEY, undefined, { placement: "aboveEditor" });
    this.ctx.ui.setWidget(LEGACY_KEY, undefined);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private applyEventToView(event: DomainEvent): void {
    switch (event.type) {
      case "run.started":
      case "run.resumed":
        this.view = { ...this.view, runStartedAt: Date.now() };
        break;
      case "stage.started": {
        const { currentStage: _cs, stageStartedAt: _ss, ...rest } = this.view;
        this.view = { ...rest, currentStage: event.stage, stageStartedAt: Date.now() };
        break;
      }
      case "stage.completed": {
        const { currentStage: _cs, stageStartedAt: _ss, ...rest } = this.view;
        this.view = { ...rest, lastSummary: event.outcome.summary };
        break;
      }
      case "stage.failed": {
        const { currentStage: _cs, stageStartedAt: _ss, ...rest } = this.view;
        this.view = { ...rest, lastSummary: event.summary };
        break;
      }
      default:
        break;
    }
  }

  private pushToRingBuffer(task: TaskActivity, line: string): void {
    task.ringBuffer.push(line);
    // Keep the buffer bounded (2x the visible activity box size)
    const limit = ACTIVITY_BOX_MAX_LINES * 2;
    if (task.ringBuffer.length > limit) {
      task.ringBuffer.splice(0, task.ringBuffer.length - limit);
    }
  }

  private repaintDashboard(): void {
    if (!this.ctx.hasUI) return;
    this.ctx.ui.setWidget(DASHBOARD_KEY, renderDashboardLines(this.view, this.tasks), {
      placement: "aboveEditor",
    });
  }

  private repaintStrip(): void {
    if (!this.ctx.hasUI) return;
    const lines = renderBreadcrumbStripLines(this.crumbs);
    if (lines.length === 0) return;
    this.ctx.ui.setWidget(STRIP_KEY, lines, { placement: "aboveEditor" });
  }

  private repaintBox(): void {
    if (!this.ctx.hasUI) return;
    const activity = this.lastActiveCorrelationId ? this.tasks.get(this.lastActiveCorrelationId) : undefined;
    const lines = renderActivityBoxLines(activity);
    if (lines.length === 0) {
      this.ctx.ui.setWidget(BOX_KEY, undefined, { placement: "aboveEditor" });
    } else {
      this.ctx.ui.setWidget(BOX_KEY, lines, { placement: "aboveEditor" });
    }
  }

  private repaintAll(): void {
    this.repaintDashboard();
    this.repaintStrip();
    this.repaintBox();
    this.boxRepaintPending = false;
  }

  private scheduleBoxRepaint(): void {
    if (this.boxRepaintPending) return;
    this.boxRepaintPending = true;
    this.boxThrottleTimer = setTimeout(() => {
      this.boxRepaintPending = false;
      this.repaintBox();
    }, BOX_THROTTLE_MS);
  }
}
