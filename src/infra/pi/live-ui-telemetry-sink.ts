/**
 * LiveUiTelemetrySink — TelemetrySink decorator that drives the pi UI surfaces
 * (transcript milestone messages, toast notifications) in addition to
 * forwarding every call to the wrapped JSONL sink.
 *
 * Widget rendering and strip management have moved to LiveActivityPresenter.
 * This sink only drives the permanent transcript (pi.sendMessage) and toasts
 * (ctx.ui.notify) for milestone events, then delegates the rest to the
 * presenter via onDomainEvent / onRunStateRefresh.
 *
 * All UI side effects are gated behind ctx.hasUI so automated/headless runs
 * (--mode text, smoke tests) are unaffected. The inner sink runs first for
 * every call, keeping on-disk artifacts byte-identical to a no-UI run.
 */

import type { ExtensionAPI, ExtensionCommandContext, MessageRenderer } from "@earendil-works/pi-coding-agent";

import type { DomainEvent } from "../../domain/event/index.js";
import type { RunState, TelemetryEvent, TelemetrySink } from "../../application/port/index.js";
import type { ActivityPresenter } from "./session-activity.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEEPLOOPER_PROGRESS_CUSTOM_TYPE = "deeplooper-progress";

// ---------------------------------------------------------------------------
// Types (kept for backward-compatible re-use by tests and external callers)
// ---------------------------------------------------------------------------

export interface BreadcrumbResult {
  line: string;
  level?: "info" | "warning" | "error";
}

// ---------------------------------------------------------------------------
// breadcrumbFor — pure helper for the strip buffer (broader set)
// ---------------------------------------------------------------------------

/**
 * Maps a DomainEvent to a breadcrumb line used by the strip widget.
 * Returns undefined for high-frequency events that are not user-facing.
 *
 * NOTE: Not all events returned here go to the permanent transcript.
 * See isMilestoneEvent() for the transcript filter.
 */
export function breadcrumbFor(event: DomainEvent): BreadcrumbResult | undefined {
  switch (event.type) {
    case "run.started":
      return { line: `Deeplooper started - route ${event.route}`, level: "info" };
    case "run.resumed":
      return { line: `Deeplooper resumed - route ${event.route}`, level: "info" };
    case "run.completed":
      return { line: `Deeplooper ${event.status}`, level: "info" };
    case "run.aborted":
      return { line: `Deeplooper aborted - ${event.error}`, level: "error" };
    case "stage.started":
      return { line: `starting ${event.stage}` };
    case "stage.completed":
      return { line: `OK ${event.stage} - ${event.outcome.summary}` };
    case "stage.failed":
      return { line: `FAIL ${event.stage} - ${event.summary}`, level: "error" };
    case "stage.skipped":
      return { line: `skip ${event.stage} (${event.summary})` };
    case "backward_loop.decided":
      return { line: `loop back to ${event.targetStage}` };
    case "backward_loop.reset":
      return { line: `loop back to ${event.targetStage}` };
    case "backward_loop.failed":
      return { line: `backward-loop cap reached`, level: "error" };
    case "gate.presented":
      return { line: `approval needed at ${event.stage}`, level: "warning" };
    case "gate.approved":
      return { line: `gate ${event.stage} approved` };
    case "gate.rejected":
      return { line: `gate ${event.stage} rejected` };
    case "slice.started":
      return { line: `slice ${event.sliceId} starting: ${event.sliceTitle}` };
    case "slice.completed":
      return { line: `slice ${event.sliceId} ${event.status}` };
    case "requeue.requested":
      return { line: `slice ${event.sliceId} requeued (attempt ${event.requeueCount})` };
    case "requeue.exhausted":
      return { line: `slice ${event.sliceId} exhausted requeues — escalating`, level: "warning" };
    case "review.round.started":
      return { line: `${event.stage} review round ${event.reviewRound}/${event.maxRounds}` };
    case "task.completed":
      return { line: `task ${event.taskId} ${event.status === "PASS" ? "done" : "FAIL"} (wave ${event.wave})` };
    // High-frequency — no transcript breadcrumb.
    case "dispatch.started":
    case "dispatch.completed":
    case "review.round.completed":
    case "task.started":
    case "backward_loop.requested":
    case "requeue.decided":
      return undefined;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// isMilestoneEvent — subset of events that produce a permanent transcript entry
// ---------------------------------------------------------------------------

/**
 * Returns true for events that should create a permanent transcript entry via
 * pi.sendMessage. This is a strict subset of the events that breadcrumbFor
 * returns a result for; noisy events like stage.started go to the strip only.
 */
export function isMilestoneEvent(event: DomainEvent): boolean {
  switch (event.type) {
    case "run.started":
    case "run.resumed":
    case "run.completed":
    case "run.aborted":
    case "stage.completed":
    case "stage.failed":
    case "stage.skipped":
    case "gate.presented":
    case "gate.approved":
    case "gate.rejected":
    case "backward_loop.decided":
    case "backward_loop.reset":
    case "backward_loop.failed":
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Message renderer (transcript breadcrumbs)
// ---------------------------------------------------------------------------

/**
 * Custom renderer for DEEPLOOPER_PROGRESS_CUSTOM_TYPE messages.
 *
 * Returns a minimal Component-compatible object whose render() method splits
 * the message content on newlines. @earendil-works/pi-tui is not a direct dep
 * so we satisfy the Component interface structurally at runtime.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Component type from pi-tui not a direct dep; runtime shape satisfies render(width: number): string[]
export const DEEPLOOPER_PROGRESS_RENDERER: MessageRenderer = (message, _options, _theme): any => {
  const rawContent = (message as { content?: string }).content ?? "";
  const content = typeof rawContent === "string" ? rawContent : "";
  return {
    render(_width: number): string[] {
      return content.split("\n");
    },
  };
};

// ---------------------------------------------------------------------------
// LiveUiTelemetrySink
// ---------------------------------------------------------------------------

/** Inner sink interface: the full TelemetrySink port plus the initialize() method
 *  that JsonlTelemetrySink exposes (not part of the port, called from index.ts). */
export interface InitializableTelemetrySink extends TelemetrySink {
  initialize(): Promise<void>;
}

/**
 * TelemetrySink decorator. Wraps an InitializableTelemetrySink (typically
 * JsonlTelemetrySink), forwards every call verbatim, and additionally drives:
 *  - pi.sendMessage    — one transcript entry per milestone event
 *  - ctx.ui.notify     — toast for gate / failure / terminal events
 *  - presenter         — receives every domain event for widget + strip updates
 */
export class LiveUiTelemetrySink implements TelemetrySink {
  constructor(
    private readonly inner: InitializableTelemetrySink,
    private readonly pi: ExtensionAPI,
    private readonly ctx: ExtensionCommandContext,
    private readonly presenter?: ActivityPresenter,
  ) {}

  initialize(): Promise<void> {
    return this.inner.initialize();
  }

  readEvents(): Promise<TelemetryEvent[]> {
    return this.inner.readEvents();
  }

  async record(event: DomainEvent): Promise<void> {
    await this.inner.record(event);
    if (!this.ctx.hasUI) return;

    // Milestone events → permanent transcript entry + optional toast
    if (isMilestoneEvent(event)) {
      const crumb = breadcrumbFor(event);
      if (crumb) {
        this.pi.sendMessage({
          customType: DEEPLOOPER_PROGRESS_CUSTOM_TYPE,
          content: crumb.line,
          display: true,
        });
        if (crumb.level) {
          this.ctx.ui.notify(crumb.line, crumb.level);
        }
      }
    }

    // All events → presenter for strip buffer + widget rendering
    this.presenter?.onDomainEvent(event);
  }

  async regenerateRunLog(state: RunState): Promise<void> {
    await this.inner.regenerateRunLog(state);
    if (this.ctx.hasUI) {
      this.presenter?.onRunStateRefresh(state);
    }
  }

  async regenerateMetrics(state: RunState): Promise<void> {
    return this.inner.regenerateMetrics(state);
  }
}
