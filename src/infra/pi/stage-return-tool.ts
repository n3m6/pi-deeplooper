import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type {
  BackwardLoopClassification,
  DispatchResult,
  GoalsReturnPayload,
  InterviewEntry,
  StageOutcome,
  StageStatus,
} from "../../application/port/index.js";

export const backwardLoopSchema = Type.Object({
  classification: StringEnum(["LOCAL_SLICE", "LOOP_DESIGN", "LOOP_GOALS", "NO_LOOP"] as const, {
    description: "Backward-loop classification, if remediation should escape the current stage.",
  }),
  summary: Type.String(),
  guidance: Type.Optional(Type.String()),
});

export const stageReturnSchema = Type.Object({
  status: StringEnum(["PASS", "FAIL", "PARTIAL", "SKIP"] as const),
  filesWritten: Type.Array(Type.String()),
  summary: Type.String(),
  route: Type.Optional(Type.String()),
  phase: Type.Optional(Type.Integer()),
  reportContent: Type.Optional(Type.String()),
  telemetry: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  backwardLoop: Type.Optional(backwardLoopSchema),
});

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

export function createStageReturnTool(
  sink: StageReturnPayload[],
): ToolDefinition<typeof stageReturnSchema, StageReturnPayload> {
  return defineTool({
    name: "stage_return",
    label: "Stage Return",
    description: "Terminate a structured stage-like sub-run with a deterministic result payload.",
    promptSnippet: "Return the final structured result for this stage-like task.",
    parameters: stageReturnSchema,
    // eslint-disable-next-line @typescript-eslint/require-await -- SDK interface requires async signature
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult<StageReturnPayload>> {
      const payload = coerceStageReturnPayload(params);
      sink.push(payload);
      return {
        content: [{ type: "text", text: "Recorded structured stage result." }],
        details: payload,
      };
    },
  });
}

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

function coerceStageReturnPayload(input: unknown): StageReturnPayload {
  const value = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const backwardLoopValue =
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
    ...(backwardLoopValue
      ? {
          backwardLoop: {
            classification: normalizeBackwardLoop(backwardLoopValue.classification),
            summary: isString(backwardLoopValue.summary)
              ? backwardLoopValue.summary
              : "No backward-loop summary provided.",
            ...(isString(backwardLoopValue.guidance) ? { guidance: backwardLoopValue.guidance } : {}),
          },
        }
      : {}),
  };
}

function normalizeStatus(value: unknown): StageStatus {
  return value === "PASS" || value === "FAIL" || value === "PARTIAL" || value === "SKIP" ? value : "FAIL";
}

function normalizeBackwardLoop(value: unknown): BackwardLoopClassification {
  return value === "LOCAL_SLICE" || value === "LOOP_DESIGN" || value === "LOOP_GOALS" || value === "NO_LOOP"
    ? value
    : "NO_LOOP";
}

// ---------------------------------------------------------------------------
// Goals return tool — structured delivery of goals.md content + config fields
// ---------------------------------------------------------------------------

const goalsReturnSchema = Type.Object({
  goalsMarkdown: Type.String({ description: "Full content of goals.md." }),
  route: StringEnum(["full"] as const, { description: "Pipeline route (always full in DEEPLOOPER)." }),
  coverageThreshold: Type.Optional(Type.Integer({ description: "Coverage gate percentage (0–100)." })),
  testGlobs: Type.Optional(Type.Array(Type.String(), { description: "Non-default test glob patterns." })),
});

export function createGoalsReturnTool(): ToolDefinition<typeof goalsReturnSchema, GoalsReturnPayload> {
  return defineTool({
    name: "goals_return",
    label: "Goals Return",
    description:
      "Submit the synthesized goals document and route determination. Call this once when synthesis is complete.",
    promptSnippet: "Submit the synthesized goals content and route.",
    parameters: goalsReturnSchema,
    // eslint-disable-next-line @typescript-eslint/require-await -- SDK interface requires async signature
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult<GoalsReturnPayload>> {
      const payload: GoalsReturnPayload = {
        goalsMarkdown: isString(params.goalsMarkdown) ? params.goalsMarkdown : "",
        route: "full" as const,
        ...(typeof params.coverageThreshold === "number"
          ? { coverageThreshold: Math.round(params.coverageThreshold) }
          : {}),
        ...(Array.isArray(params.testGlobs) ? { testGlobs: params.testGlobs.filter(isString) } : {}),
      };
      return {
        content: [{ type: "text", text: "Recorded goals synthesis result." }],
        details: payload,
      };
    },
  });
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

// ---------------------------------------------------------------------------
// Interview return tool — structured delivery of the assembled interview record
// ---------------------------------------------------------------------------

const INTERVIEW_SOURCES = [
  "user-answer",
  "repo-finding",
  "user-confirmed-finding",
  "automation-default",
  "automation-fallback",
] as const;

const interviewReturnSchema = Type.Object({
  entries: Type.Array(
    Type.Object({
      branch: Type.String({ description: "Coverage branch name (e.g. constraints)." }),
      source: StringEnum(INTERVIEW_SOURCES, { description: "How this branch was resolved." }),
      content: Type.String({ description: "Resolved content verbatim, or None specified." }),
    }),
    { description: "One entry per resolved coverage branch." },
  ),
});

export function createInterviewReturnTool(): ToolDefinition<
  typeof interviewReturnSchema,
  { entries: InterviewEntry[] }
> {
  return defineTool({
    name: "interview_return",
    label: "Interview Return",
    description:
      "Submit the assembled interview record. Call this exactly once when all coverage branches are resolved.",
    promptSnippet: "Submit the complete interview record.",
    parameters: interviewReturnSchema,
    // eslint-disable-next-line @typescript-eslint/require-await -- SDK interface requires async signature
    async execute(
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      _ctx,
    ): Promise<AgentToolResult<{ entries: InterviewEntry[] }>> {
      const entries: InterviewEntry[] = (Array.isArray(params.entries) ? params.entries : []).map((entry) => ({
        branch: isString(entry.branch) ? entry.branch : "",
        source: normalizeInterviewSource(entry.source),
        content: isString(entry.content) ? entry.content : "",
      }));
      return {
        content: [{ type: "text", text: "Recorded interview record." }],
        details: { entries },
      };
    },
  });
}

function normalizeInterviewSource(value: unknown): InterviewEntry["source"] {
  return value === "user-answer" ||
    value === "repo-finding" ||
    value === "user-confirmed-finding" ||
    value === "automation-default" ||
    value === "automation-fallback"
    ? value
    : "automation-fallback";
}

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
