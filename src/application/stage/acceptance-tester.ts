/**
 * In DEEPLOOPER, acceptance testing is handled directly in accept.ts as a global
 * pass over all completed slices. This module is kept as a stub so that any
 * existing test scaffolding continues to compile.
 */
import type { StageOutcome, StageRuntime } from "../port/index.js";

// eslint-disable-next-line @typescript-eslint/require-await
export async function runAcceptanceTesterSubstage(_runtime: StageRuntime): Promise<StageOutcome> {
  return {
    status: "FAIL",
    filesWritten: [],
    summary: "runAcceptanceTesterSubstage is not used in DEEPLOOPER; see accept.ts.",
  };
}
