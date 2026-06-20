/**
 * DEEPLOOPER Report stage — generate the final pipeline run report.
 */

import type { StageModule, StageOutcome, StageRuntime } from "../port/index.js";
import { dispatchLeaf, readArtifact, safeReadArtifact, writeArtifact } from "./utils.js";

export const reportStage: StageModule = {
  stage: "report",
  async run(runtime: StageRuntime): Promise<StageOutcome> {
    const config = await readArtifact(runtime, { kind: "config" });
    const goals = await readArtifact(runtime, { kind: "goals" });
    const baseline = await safeReadArtifact(runtime, { kind: "baselineResults" });
    const verification = await safeReadArtifact(runtime, { kind: "stage9Summary" });
    const sliceQueue = await safeReadArtifact(runtime, { kind: "sliceQueue" });
    const globalAcceptance = await safeReadArtifact(runtime, { kind: "globalAcceptanceResults" });
    const lessons = await safeReadArtifact(runtime, { kind: "lessons" });
    const perSliceResults = await readPerSliceResults(runtime);

    const report = await dispatchLeaf(
      runtime,
      "dl-reporter",
      [
        "=== CONFIG ===",
        config,
        "",
        "=== GOALS ===",
        goals,
        "",
        "=== BASELINE RESULTS ===",
        baseline,
        "",
        "=== SLICE QUEUE ===",
        sliceQueue,
        "",
        "=== PER-SLICE RESULTS ===",
        perSliceResults,
        "",
        "=== VERIFICATION RESULT ===",
        verification,
        "",
        "=== GLOBAL ACCEPTANCE RESULTS ===",
        globalAcceptance,
        "",
        "=== LESSONS ===",
        lessons || "(none)",
      ].join("\n"),
    );

    await writeArtifact(runtime, { kind: "stage10Summary" }, report.text);
    return {
      status: "PASS",
      filesWritten: ["stage10-summary.md"],
      summary: "Final report generated.",
      reportContent: report.text,
      route: "full",
    };
  },
};

async function readPerSliceResults(runtime: StageRuntime): Promise<string> {
  const repo = runtime.services.artifactRepo;
  const phases = await repo.listPhases();
  const blocks: string[] = [];
  for (const phase of phases) {
    const label = `phase-${String(phase).padStart(2, "0")}`;
    const impl = (await repo.read({ kind: "phaseFile", phase, name: "stage7-summary.md" })) ?? "N/A";
    const integration = (await repo.read({ kind: "phaseFile", phase, name: "stage7-integration-summary.md" })) ?? "N/A";
    const doneCheck = (await repo.read({ kind: "phaseFile", phase, name: "done-check-results.md" })) ?? "N/A";
    blocks.push(
      [
        `## ${label}`,
        `### Implementation`,
        impl,
        "",
        `### Integration`,
        integration,
        "",
        `### Done-Check`,
        doneCheck,
        "",
      ].join("\n"),
    );
  }
  return blocks.join("\n\n");
}
