/**
 * Pure, width-aware render helpers for the DEEPLOOPER TUI widgets.
 * All functions accept explicit state and return string[].
 * No I/O, no side effects — fully testable in isolation.
 */

import { MAX_BACKWARD_LOOPS } from "../../domain/run/index.js";
import type { RunState, StageName } from "../../application/port/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const STAGE_ORDER: StageName[] = [
  "goals",
  "research",
  "design",
  "skeleton",
  "baseline",
  "slice-loop",
  "verify",
  "accept",
  "report",
];

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const ACTIVITY_BOX_MAX_LINES = 6;
export const BREADCRUMB_STRIP_MAX_LINES = 3;
export const TASK_BOARD_MAX_ROWS = 6;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunView {
  state?: RunState;
  currentStage?: StageName;
  stageStartedAt?: number;
  lastSummary?: string;
  runStartedAt?: number;
  spinnerFrame?: number;
}

export interface TaskActivity {
  correlationId: string;
  label: string;
  startedAt: number;
  lastTool: string | undefined;
  turnCount: number;
  ringBuffer: string[];
}

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Formats an elapsed millisecond duration as mm:ss. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** Truncates a string to the given width, appending … if needed. */
export function truncateToWidth(line: string, width: number): string {
  if (line.length <= width) return line;
  return line.slice(0, width - 1) + "…";
}

/** Returns the spinner character for the given frame counter. */
export function nextSpinnerFrame(current: number): string {
  return SPINNER_FRAMES[current % SPINNER_FRAMES.length] ?? "⠋";
}

// ---------------------------------------------------------------------------
// Dashboard widget (always visible during a run)
// ---------------------------------------------------------------------------

export function renderDashboardLines(
  view: RunView,
  tasks: ReadonlyMap<string, TaskActivity>,
  nowMs = Date.now(),
): string[] {
  if (!view.state) {
    return ["deeplooper - starting..."];
  }

  const state = view.state;
  const spinner = nextSpinnerFrame(view.spinnerFrame ?? 0);

  const runElapsed = view.runStartedAt !== undefined ? formatDuration(nowMs - view.runStartedAt) : "--:--";
  const header = `${spinner} deeplooper - ${state.runId} - ${state.route} - ${runElapsed}`;

  const stageRow = STAGE_ORDER.map((stage) => {
    const isDone = state.stagesCompleted.includes(stage);
    const isCurrent = view.currentStage === stage;
    let marker: string;
    if (isCurrent) {
      marker = "▶";
    } else if (isDone) {
      marker = "✓";
    } else {
      marker = " ";
    }
    return `${stage}${marker}`;
  }).join("  ");

  const stageStartedMs = view.stageStartedAt;
  const runningFor = stageStartedMs !== undefined ? formatDuration(nowMs - stageStartedMs) : "--:--";
  const currentLabel = view.currentStage ?? state.nextStage;
  const sliceLine = state.currentSlice
    ? `slice ${state.currentSlice} - slices done: ${state.slicesDone.length} - ${currentLabel} (${runningFor})`
    : `${currentLabel} (${runningFor})`;

  const loopLine = `loops: backward ${state.backwardLoops}/${MAX_BACKWARD_LOOPS}`;

  const lastLabel = state.lastCompletedStage === "none" ? "none" : state.lastCompletedStage;
  const lastLine = view.lastSummary ? `last: ${lastLabel} - ${view.lastSummary}` : `last: ${lastLabel}`;

  const lines: string[] = [header, stageRow, sliceLine, loopLine, lastLine];

  // Per-task board: only render when >= 2 concurrent sessions are active
  const taskEntries = [...tasks.values()];
  if (taskEntries.length >= 2) {
    lines.push("tasks:");
    const shown = taskEntries.slice(0, TASK_BOARD_MAX_ROWS);
    for (const task of shown) {
      const elapsed = formatDuration(nowMs - task.startedAt);
      const tool = task.lastTool ? ` [${task.lastTool}]` : "";
      lines.push(`  ${task.label}${tool} · turn ${task.turnCount} · ${elapsed}`);
    }
    if (taskEntries.length > TASK_BOARD_MAX_ROWS) {
      lines.push(`  +${taskEntries.length - TASK_BOARD_MAX_ROWS} more`);
    }
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Breadcrumb strip widget (visible when sessions are active)
// ---------------------------------------------------------------------------

export function renderBreadcrumbStripLines(crumbs: readonly string[], maxLines = BREADCRUMB_STRIP_MAX_LINES): string[] {
  const recent = crumbs.slice(-maxLines);
  if (recent.length === 0) return [];
  return [...recent];
}

// ---------------------------------------------------------------------------
// Activity box widget (visible when sessions are active, bordered)
// ---------------------------------------------------------------------------

export function renderActivityBoxLines(activity: TaskActivity | undefined, width = 120, nowMs = Date.now()): string[] {
  if (!activity) return [];

  const safeWidth = Math.max(20, width);
  const elapsed = formatDuration(nowMs - activity.startedAt);
  const headerText = ` ${activity.label} · turn ${activity.turnCount} · ${elapsed} `;

  // Top border: ─── <header> ──────────────
  const fillCount = Math.max(0, safeWidth - headerText.length - 3);
  const topBorder = truncateToWidth(`───${headerText}${"─".repeat(fillCount)}`, safeWidth);

  const outputLines: string[] = [topBorder];

  const shown = activity.ringBuffer.slice(-ACTIVITY_BOX_MAX_LINES);
  for (const line of shown) {
    outputLines.push(truncateToWidth(`  ${line}`, safeWidth));
  }

  outputLines.push(truncateToWidth("─".repeat(safeWidth), safeWidth));

  return outputLines;
}
