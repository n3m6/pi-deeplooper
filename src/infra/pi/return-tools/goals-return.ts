import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { GoalsReturnPayload } from "../../../application/port/index.js";
import { isString } from "./normalize.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const goalsReturnSchema = Type.Object({
  goalsMarkdown: Type.String({ description: "Full content of goals.md." }),
  route: StringEnum(["full"] as const, { description: "Pipeline route (always full in DEEPLOOPER)." }),
  coverageThreshold: Type.Optional(Type.Integer({ description: "Coverage gate percentage (0–100)." })),
  testGlobs: Type.Optional(Type.Array(Type.String(), { description: "Non-default test glob patterns." })),
});

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Creates the `goals_return` custom tool.
 *
 * The goals stage calls this exactly once after synthesizing goals.md, the
 * route determination, and any optional coverage/test-glob overrides.
 */
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
