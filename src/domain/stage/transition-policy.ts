// Pure stage transition policy for DEEPLOOPER — no side effects.
// No node:* or pi imports.

import type { NextStage, StageName, VerifyStatus } from "../value/index.js";

export interface NextStageContext {
  verifyStatus?: VerifyStatus;
  /** When true, verify/accept route back to slice-loop for remediation. */
  remediationSlicesAdded?: boolean;
}

/**
 * DEEPLOOPER stage graph:
 *   goals → research → design → skeleton → baseline → slice-loop
 *   slice-loop →(exhausted)→ verify
 *   slice-loop →(LOOP_DESIGN/GOALS)→ design or goals  (escalation, handled by pipeline-loop)
 *   verify →(PASS)→ accept
 *   verify →(remediation)→ slice-loop
 *   accept →(all green)→ report
 *   accept →(remediation)→ slice-loop
 *   report → done
 */
export function nextStageFor(stage: StageName, context: NextStageContext = {}): NextStage {
  switch (stage) {
    case "goals":
      return "research";
    case "research":
      return "design";
    case "design":
      return "skeleton";
    case "skeleton":
      return "baseline";
    case "baseline":
      return "slice-loop";
    case "slice-loop":
      return "verify";
    case "verify":
      return context.remediationSlicesAdded ? "slice-loop" : "accept";
    case "accept":
      return context.remediationSlicesAdded ? "slice-loop" : "report";
    case "report":
      return "done";
  }
}
