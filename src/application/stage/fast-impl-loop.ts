import type { ArtifactId, StageOutcome, StageRuntime } from "../port/index.js";
import { runFastImplCodeSubstage } from "./fast-impl-code.js";
import { runFastImplTestSubstage } from "./fast-impl-test.js";
import { runFastImplVerifySubstage } from "./fast-impl-verify.js";

export async function runFastImplLoopSubstage(
  runtime: StageRuntime,
  options: {
    taskId: string;
    worktreeRoot: string;
    taskSpecId: ArtifactId;
    /** Guidance from an outer review loop (e.g. skeleton reviewer) passed into the first code attempt. */
    repairGuidance?: string;
  },
): Promise<StageOutcome> {
  let attempt = 1;
  let latestTelemetry = {};
  // On the first attempt, carry any externally-provided guidance; on subsequent attempts, replace
  // it with the previous attempt's verify failure so the worker knows exactly what to fix.
  let currentRepairGuidance: string | undefined = options.repairGuidance;

  while (attempt <= 2) {
    const code = await runFastImplCodeSubstage(runtime, {
      ...options,
      attempt,
      ...(currentRepairGuidance !== undefined ? { repairGuidance: currentRepairGuidance } : {}),
    });
    if (code.status === "FAIL") {
      return code;
    }

    const tests = await runFastImplTestSubstage(runtime, { ...options, attempt });
    if (tests.status === "FAIL") {
      return tests;
    }

    const verify = await runFastImplVerifySubstage(runtime, { ...options, attempt });
    latestTelemetry = { ...code.telemetry, ...tests.telemetry, ...verify.telemetry };
    if (verify.status === "PASS") {
      return {
        status: "PASS",
        filesWritten: [...code.filesWritten, ...tests.filesWritten, ...verify.filesWritten],
        summary: `Task ${options.taskId} passed the fast implementation loop.`,
        telemetry: latestTelemetry,
      };
    }

    if (attempt === 2) {
      return {
        status: "FAIL",
        filesWritten: [...code.filesWritten, ...tests.filesWritten, ...verify.filesWritten],
        summary: verify.summary,
        telemetry: latestTelemetry,
      };
    }

    // Feed the verify failure into attempt 2 so the coding worker knows exactly what failed.
    currentRepairGuidance = verify.summary;
    attempt += 1;
  }

  return {
    status: "FAIL",
    filesWritten: [],
    summary: `Task ${options.taskId} exceeded the fast implementation loop retry budget.`,
    telemetry: latestTelemetry,
  };
}
