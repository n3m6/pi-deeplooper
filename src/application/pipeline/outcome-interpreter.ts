/**
 * OutcomeInterpreter — applies stage transitions for DEEPLOOPER.
 *
 * Handles: applyStageTransition.
 * The old accept/verify fix-routing helpers are removed — remediation in DEEPLOOPER
 * is handled via remediation slices appended to the queue, not backward loops.
 */

import { Run } from "../../domain/run/index.js";
import { nextStageFor } from "../../domain/stage/transition-policy.js";
import type { ArtifactRepository, RunState, StageName, StageOutcome } from "../port/index.js";

export function applyStageTransition(
  state: RunState,
  stage: StageName,
  outcome: StageOutcome,
  _artifactRepo?: ArtifactRepository,
): RunState {
  const run = Run.rehydrate(state);
  const remediationSlicesAdded = outcome.telemetry?.remediationSlicesAdded === true;

  switch (stage) {
    case "goals": {
      run.completeStage("goals", nextStageFor("goals"));
      return run.toSnapshot();
    }
    case "research": {
      run.completeStage("research", nextStageFor("research"));
      return run.toSnapshot();
    }
    case "design": {
      run.completeStage("design", nextStageFor("design"));
      // NOTE: pendingReconcile is intentionally NOT cleared here. It is set on a
      // Design/Goals escalation and must survive design → skeleton → baseline so
      // slice-loop (the consumer) can reconcile the queue against the new design.
      // slice-loop clears the flag once it has reconciled.
      return run.toSnapshot();
    }
    case "skeleton": {
      run.completeStage("skeleton", nextStageFor("skeleton"));
      return run.toSnapshot();
    }
    case "baseline": {
      run.completeStage("baseline", nextStageFor("baseline"));
      return run.toSnapshot();
    }
    case "slice-loop": {
      run.completeStage("slice-loop", nextStageFor("slice-loop"));
      return run.toSnapshot();
    }
    case "verify": {
      const verifyStatus = extractVerifyStatus(outcome, state.verifyStatus);
      run.completeStage(
        "verify",
        nextStageFor("verify", { remediationSlicesAdded }),
        verifyStatus ? { verifyStatus } : undefined,
      );
      return run.toSnapshot();
    }
    case "accept": {
      run.completeStage("accept", nextStageFor("accept", { remediationSlicesAdded }));
      return run.toSnapshot();
    }
    case "report": {
      run.completeStage("report", nextStageFor("report"));
      return run.toSnapshot();
    }
    default:
      return run.toSnapshot();
  }
}

function extractVerifyStatus(
  outcome: StageOutcome,
  fallback: import("../../domain/value/index.js").VerifyStatus | undefined,
): import("../../domain/value/index.js").VerifyStatus | undefined {
  const raw = outcome.telemetry?.verify_status;
  return raw === "PASS" || raw === "PARTIAL" || raw === "FAIL" ? raw : fallback;
}
