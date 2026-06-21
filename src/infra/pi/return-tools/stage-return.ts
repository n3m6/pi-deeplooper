import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { coerceStageReturnPayload, type StageReturnPayload } from "./normalize.js";

export type { StageReturnPayload };

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Creates the `stage_return` custom tool.
 *
 * The tool records the structured payload in `sink` and returns immediately.
 * The dispatcher's `instrumentCustomTools` wrapper signals `stageReturn` promise
 * resolution when it detects this tool name, causing the session to be aborted.
 */
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
