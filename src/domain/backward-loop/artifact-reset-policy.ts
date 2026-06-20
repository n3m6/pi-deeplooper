// Escalation policy for DEEPLOOPER backward loops.
// DEEPLOOPER never archives or deletes completed slices; it only escalates to design or goals.
// No node:* or pi imports.

import type { BackwardLoopClassification, StageName } from "../value/index.js";

/**
 * Returns the escalation target stage for a given backward-loop classification.
 * Only LOOP_DESIGN and LOOP_GOALS are valid escalation targets in DEEPLOOPER.
 * LOCAL_SLICE is handled inside slice-loop.ts and never reaches the pipeline loop.
 */
export function escalationTarget(classification: BackwardLoopClassification): StageName {
  switch (classification) {
    case "LOOP_GOALS":
      return "goals";
    case "LOOP_DESIGN":
    case "LOCAL_SLICE":
    case "NO_LOOP":
    default:
      return "design";
  }
}
