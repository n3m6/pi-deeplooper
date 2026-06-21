/**
 * Public surface for the stage/goals/interview return tools.
 *
 * Implementation is split across focused sub-modules in `return-tools/`:
 *   - stage-return.ts   — stage_return tool, schemas, StageReturnPayload type
 *   - goals-return.ts   — goals_return tool
 *   - interview-return.ts — interview_return tool
 *   - normalize.ts      — payload coercion, StageOutcome builders
 *
 * All symbols re-exported here so existing import paths remain valid.
 */

export type { StageReturnPayload } from "./return-tools/stage-return.js";
export { backwardLoopSchema, stageReturnSchema, createStageReturnTool } from "./return-tools/stage-return.js";
export { normalizeStageReturn, structuredToOutcome } from "./return-tools/normalize.js";
export { createGoalsReturnTool } from "./return-tools/goals-return.js";
export { createInterviewReturnTool } from "./return-tools/interview-return.js";
