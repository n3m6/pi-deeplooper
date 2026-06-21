import type {
  BackwardLoopClassification,
  DispatchResult,
  StageOutcome,
  StageStatus,
} from "../../../application/port/index.js";
import { coerceEnum, STAGE_STATUSES, BACKWARD_LOOP_CLASSIFICATIONS } from "../union-guard.js";

// ---------------------------------------------------------------------------
// StageReturnPayload type (defined here to avoid a circular dep with stage-return.ts)
// ---------------------------------------------------------------------------

export interface StageReturnPayload {
  status: StageStatus;
  filesWritten: string[];
  summary: string;
  route?: string;
  phase?: number;
  reportContent?: string;
  telemetry?: Record<string, unknown>;
  backwardLoop?: {
    classification: BackwardLoopClassification;
    summary: string;
    guidance?: string;
  };
}

// ---------------------------------------------------------------------------
// Primitive type guard
// ---------------------------------------------------------------------------

/** Type guard for string values — used across all three return-tool coercers. */
export function isString(value: unknown): value is string {
  return typeof value === "string";
}

// ---------------------------------------------------------------------------
// StageReturnPayload coercion helpers
// ---------------------------------------------------------------------------

function normalizeStatus(value: unknown): StageStatus {
  return coerceEnum(value, STAGE_STATUSES, "FAIL");
}

function normalizeBackwardLoop(value: unknown): BackwardLoopClassification {
  return coerceEnum(value, BACKWARD_LOOP_CLASSIFICATIONS, "NO_LOOP");
}

/** Coerces the optional `backwardLoop` sub-object to the typed payload shape. */
function coerceBackwardLoop(raw: Record<string, unknown>): NonNullable<StageReturnPayload["backwardLoop"]> {
  return {
    classification: normalizeBackwardLoop(raw.classification),
    summary: isString(raw.summary) ? raw.summary : "No backward-loop summary provided.",
    ...(isString(raw.guidance) ? { guidance: raw.guidance } : {}),
  };
}

/**
 * Coerces an unknown value (typically `tool.execute` params or stored details)
 * to a well-typed `StageReturnPayload`.
 *
 * All fields are normalized to safe defaults when missing or of the wrong type.
 */
export function coerceStageReturnPayload(input: unknown): StageReturnPayload {
  const value = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const backwardLoopRaw =
    value.backwardLoop && typeof value.backwardLoop === "object"
      ? (value.backwardLoop as Record<string, unknown>)
      : undefined;

  return {
    status: normalizeStatus(value.status),
    filesWritten: Array.isArray(value.filesWritten) ? value.filesWritten.filter(isString) : [],
    summary: isString(value.summary) ? value.summary : "No summary provided.",
    ...(isString(value.route) ? { route: value.route } : {}),
    ...(typeof value.phase === "number" ? { phase: value.phase } : {}),
    ...(isString(value.reportContent) ? { reportContent: value.reportContent } : {}),
    ...(value.telemetry && typeof value.telemetry === "object"
      ? { telemetry: value.telemetry as Record<string, unknown> }
      : {}),
    ...(backwardLoopRaw ? { backwardLoop: coerceBackwardLoop(backwardLoopRaw) } : {}),
  };
}

// ---------------------------------------------------------------------------
// StageOutcome builders
// ---------------------------------------------------------------------------

/** Maps a fully typed `StageReturnPayload` to the application-facing `StageOutcome`. */
export function structuredToOutcome(payload: StageReturnPayload): StageOutcome {
  const outcome: StageOutcome = {
    status: payload.status,
    filesWritten: payload.filesWritten,
    summary: payload.summary,
  };
  if (payload.route === "full") {
    outcome.route = payload.route;
  }
  if (typeof payload.phase === "number") {
    outcome.phase = payload.phase;
  }
  if (payload.reportContent) {
    outcome.reportContent = payload.reportContent;
  }
  if (payload.telemetry) {
    outcome.telemetry = payload.telemetry;
  }
  if (payload.backwardLoop) {
    outcome.backwardLoop = {
      classification: payload.backwardLoop.classification,
      summary: payload.backwardLoop.summary,
      ...(payload.backwardLoop.guidance ? { guidance: payload.backwardLoop.guidance } : {}),
    };
  }
  return outcome;
}

/**
 * Converts a raw `DispatchResult` to a `StageOutcome`, falling back to a FAIL outcome
 * when no `stage_return` tool call is present.
 */
export function normalizeStageReturn(result: DispatchResult, errorMessage?: string): StageOutcome {
  const details = result.customToolCalls.find((toolCall) => toolCall.name === "stage_return")?.result.details;
  const structured = details ? coerceStageReturnPayload(details) : undefined;
  if (structured) {
    return structuredToOutcome(structured);
  }

  const reason = result.endReason ?? "agent_end";
  return {
    status: "FAIL",
    filesWritten: [],
    summary: errorMessage ?? result.errorMessage ?? missingStageReturnSummary(reason),
    telemetry: {
      terminal_review_state: "unclean-cap",
      missing_stage_return: true,
      dispatch_end_reason: reason,
    },
  };
}

// ---------------------------------------------------------------------------
// Error message helpers
// ---------------------------------------------------------------------------

function missingStageReturnSummary(reason: NonNullable<DispatchResult["endReason"]>): string {
  switch (reason) {
    case "aborted":
      return "Dispatched session was aborted before calling stage_return.";
    case "max_turns":
      return "Dispatched session exhausted its turn budget before calling stage_return.";
    case "timeout":
      return "Dispatched session timed out before calling stage_return.";
    case "session_error":
      return "Dispatched session errored before calling stage_return.";
    case "stage_return":
    case "agent_end":
      return "Dispatched session ended without calling stage_return.";
  }
}
