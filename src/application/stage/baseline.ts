import type { StageModule, StageOutcome } from "../port/index.js";
import { dispatchLeaf, readArtifact, writeArtifact } from "./utils.js";

export const baselineStage: StageModule = {
  stage: "baseline",
  async run(runtime): Promise<StageOutcome> {
    // Early-PASS when baseline-results.md already exists (resume / idempotent).
    const existing = await runtime.services.artifactRepo.exists({ kind: "baselineResults" });
    if (existing) {
      return {
        status: "PASS",
        filesWritten: [],
        summary: "Baseline results already exist; skipping re-check.",
        telemetry: { deterministic_fast_path: "resume-skip" },
      };
    }

    const goals = await readArtifact(runtime, { kind: "goals" });
    const config = await readArtifact(runtime, { kind: "config" });

    const result = await dispatchLeaf(
      runtime,
      "dl-baseline-checker",
      ["=== GOALS ===", goals, "", "=== CONFIG ===", config, "", "=== WORKSPACE ROOT ===", runtime.workspaceRoot].join(
        "\n",
      ),
    );

    await writeArtifact(runtime, { kind: "baselineResults" }, result.text);
    const status = parseBaselineStatus(result.text);

    return {
      status,
      filesWritten: ["baseline-results.md"],
      summary: `Baseline check ${status}.`,
      telemetry: { child_agent_calls: { "dl-baseline-checker": 1 } },
    };
  },
};

function parseBaselineStatus(text: string): "PASS" | "PARTIAL" | "FAIL" {
  if (/Baseline Status\s*[—-]\s*CLEAN/i.test(text)) {
    return "PASS";
  }
  if (/Baseline Status\s*[—-]\s*FAIL/i.test(text)) {
    return "FAIL";
  }
  return "PARTIAL";
}
