/**
 * DEEPLOOPER Global Verify stage.
 *
 * Runs dl-verifier across the completed slice outputs.
 * On red/actionable failure:
 *   - Dispatches dl-reflector in global-remediation mode.
 *   - Reflector may append R-NNN remediation slices to slice-queue.md.
 *   - Returns status:"FAIL" with telemetry.remediationSlicesAdded=true
 *     so the transition policy routes back to slice-loop (instead of escalating).
 *
 * On clean pass → return PASS → pipeline routes to accept.
 */

import { SliceQueue } from "../../domain/slice/slice-queue.js";
import { parseMarkdownSections } from "../../infra/codec/markdown-codec.js";
import type { StageModule, StageOutcome, StageRuntime } from "../port/index.js";
import { appendReflectorLessons, dispatchLeaf, readArtifact, safeReadArtifact, writeArtifact } from "./utils.js";

export const verifyStage: StageModule = {
  stage: "verify",
  async run(runtime: StageRuntime): Promise<StageOutcome> {
    const goals = await readArtifact(runtime, { kind: "goals" });
    const requirements = await readArtifact(runtime, { kind: "requirements" });
    const baselineResults = await safeReadArtifact(runtime, { kind: "baselineResults" });
    const sliceQueueMd = await safeReadArtifact(runtime, { kind: "sliceQueue" });
    const lessons = await safeReadArtifact(runtime, { kind: "lessons" });

    // Gather all phase-level evidence across all completed slices.
    const allStage7 = await readAllPhaseArtifacts(runtime, "stage7-summary.md");
    const allIntegration = await readAllPhaseArtifacts(runtime, "integration-results.md");
    const allDoneChecks = await readAllPhaseArtifacts(runtime, "done-check-results.md");
    const allExecManifests = await readAllPhaseArtifacts(runtime, "execution-manifest.md");

    const verification = await dispatchLeaf(
      runtime,
      "dl-verifier",
      [
        "=== GOALS ===",
        goals,
        "",
        "=== REQUIREMENTS ===",
        requirements,
        "",
        "=== SLICE QUEUE ===",
        sliceQueueMd,
        "",
        "=== STAGE 7 SUMMARIES ===",
        allStage7,
        "",
        "=== EXECUTION MANIFESTS ===",
        allExecManifests,
        "",
        "=== INTEGRATION RESULTS ===",
        allIntegration,
        "",
        "=== DONE-CHECK RESULTS ===",
        allDoneChecks,
        "",
        "=== BASELINE RESULTS ===",
        baselineResults,
        "",
        "=== LESSONS ===",
        lessons || "(none)",
      ].join("\n"),
    );

    await writeArtifact(runtime, { kind: "stage9Summary" }, verification.text);
    const status = parseOverallStatus(verification.text);

    if (status === "PASS" || status === "PARTIAL") {
      return {
        status,
        filesWritten: ["stage9-summary.md"],
        summary: `Global verification ${status}.`,
        telemetry: { verify_status: status },
      };
    }

    // FAIL — check if reflector can add remediation slices.
    const reflect = await dispatchLeaf(
      runtime,
      "dl-reflector",
      [
        "=== MODE ===",
        "global-remediation",
        "",
        "=== VERIFICATION RESULT ===",
        verification.text,
        "",
        "=== SLICE QUEUE ===",
        sliceQueueMd,
        "",
        "=== GOALS ===",
        goals,
        "",
        "=== LESSONS ===",
        lessons || "(none)",
      ].join("\n"),
    );

    // dl-reflector is a read-only leaf, so the controller parses its return and writes
    // the queue (pattern B). Remediation slices are returned as `### R-NNN: <title>`
    // sections; remediation is "added" only when the queue actually grows.
    const reflectSections = parseMarkdownSections(reflect.text);
    const existingQueue = sliceQueueMd ? SliceQueue.parse(sliceQueueMd) : SliceQueue.empty();
    const updatedQueue = existingQueue.addRemediationSlicesFromMarkdown(reflect.text);
    const remediationSlicesAdded = updatedQueue.length > existingQueue.length;

    if (remediationSlicesAdded) {
      await writeArtifact(runtime, { kind: "sliceQueue" }, updatedQueue.serialize());

      // Persist any lessons the reflector returned (### Lessons block).
      await appendReflectorLessons(runtime, reflectSections["Lessons"]);

      return {
        status: "FAIL",
        filesWritten: ["stage9-summary.md", "slice-queue.md"],
        summary: "Verification failed; remediation slices added — routing back to slice-loop.",
        telemetry: { verify_status: "FAIL", remediationSlicesAdded: true },
      };
    }

    // No actionable remediation → escalate upstream.
    return {
      status: "FAIL",
      filesWritten: ["stage9-summary.md"],
      summary: "Global verification failed with no actionable remediation.",
      telemetry: { verify_status: "FAIL", remediationSlicesAdded: false },
      backwardLoop: {
        classification: "LOOP_DESIGN",
        summary: "Verifier found non-remediable issues; design needs revision.",
      },
    };
  },
};

async function readAllPhaseArtifacts(runtime: StageRuntime, fileName: string): Promise<string> {
  const repo = runtime.services.artifactRepo;
  const phases = await repo.listPhases();
  const contents: string[] = [];
  for (const phase of phases) {
    const content = await repo.read({ kind: "phaseFile", phase, name: fileName });
    const label = `phase-${String(phase).padStart(2, "0")}`;
    contents.push(`## ${label}\n${content ?? "None."}`);
  }
  return contents.join("\n\n");
}

export function parseOverallStatus(markdown: string): StageOutcome["status"] {
  const overall = markdown.match(/### Overall Status\s+[—-]\s+(PASS|PARTIAL|FAIL)/i)?.[1]?.toUpperCase();
  if (overall === "PASS" || overall === "PARTIAL" || overall === "FAIL") {
    return overall;
  }
  return /PASS\b/i.test(markdown) ? "PASS" : "FAIL";
}
