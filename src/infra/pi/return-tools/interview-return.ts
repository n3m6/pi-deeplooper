import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { InterviewEntry } from "../../../application/port/index.js";
import { coerceEnum, INTERVIEW_SOURCES } from "../union-guard.js";
import { isString } from "./normalize.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

function normalizeInterviewSource(value: unknown): InterviewEntry["source"] {
  return coerceEnum(value, INTERVIEW_SOURCES, "automation-fallback");
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Creates the `interview_return` custom tool.
 *
 * The interview workflow calls this exactly once after all coverage branches
 * have been resolved (via human answers, repo findings, or automation defaults).
 */
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
