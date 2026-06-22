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
import {
  appendReflectorLessons,
  dispatchLeaf,
  readArtifact,
  recordAnomaly,
  safeReadArtifact,
  writeArtifact,
} from "./utils.js";

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
    const allRegressionResults = await readAllPhaseArtifacts(runtime, "regression-results.md");

    // Controller decides whether cached Stage-7 regression results can be reused.
    // This decouples the verifier from pipeline bookkeeping conventions — it no longer
    // probes git history itself, which was the root cause of the spurious R-001 defect.
    const reuseDecision = await runtime.services.versionControl.stage7RegressionReusable(
      runtime.services.commandContext.signal,
    );
    const configuredScripts = await runtime.services.buildTool.availableScripts(runtime.workspaceRoot);

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
        "=== PHASE REGRESSION RESULTS ===",
        allRegressionResults,
        "",
        "=== BASELINE RESULTS ===",
        baselineResults,
        "",
        "=== LESSONS ===",
        lessons || "(none)",
        "",
        "=== STAGE7 REGRESSION REUSE ===",
        `reusable: ${String(reuseDecision.reusable)}`,
        `reason: ${reuseDecision.reason}`,
        "",
        "=== CONFIGURED SCRIPTS ===",
        configuredScripts.length > 0 ? configuredScripts.join(", ") : "(none)",
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
    // sections; remediation is "added" (or an existing done slice is reopened) only when
    // the queue actually changes. Prefer reopening a falsely-done slice over adding R-NNN.
    //
    // Process/meta criteria (e.g. "git commit exists") are filtered out: only criteria
    // that trace to a known acceptance criterion in the queue are allowed through.
    const reflectSections = parseMarkdownSections(reflect.text);
    const existingQueue = sliceQueueMd ? SliceQueue.parse(sliceQueueMd) : SliceQueue.empty();
    const knownCriteria = new Set(existingQueue.allAcceptanceCriteria());
    const allowCriterion = (ac: string) => knownCriteria.has(ac.trim()) || knownCriteria.has(ac);
    const {
      queue: updatedQueue,
      reopened,
      added,
      dropped,
    } = existingQueue.applyRemediationFromMarkdown(reflect.text, allowCriterion);
    if (dropped.length > 0) {
      await recordAnomaly(
        runtime,
        "remediation-criteria-filtered",
        "warning",
        `dl-reflector proposed ${String(dropped.length)} remediation criterion/criteria that do not trace to any ` +
          `known acceptance criterion in the slice queue. They were dropped to prevent process/meta criteria ` +
          `from entering the queue.`,
        { dropped },
      );
    }
    const remediationSlicesAdded = reopened.length > 0 || added.length > 0;

    if (remediationSlicesAdded) {
      await writeArtifact(runtime, { kind: "sliceQueue" }, updatedQueue.serialize());

      // Persist any lessons the reflector returned (### Lessons block).
      await appendReflectorLessons(runtime, reflectSections["Lessons"]);

      return {
        status: "FAIL",
        filesWritten: ["stage9-summary.md", "slice-queue.md"],
        summary: "Verification failed; remediation slices added — routing back to slice-loop.",
        telemetry: {
          verify_status: "FAIL",
          remediationSlicesAdded: true,
          slicesReopened: reopened,
          slicesAdded: added,
        },
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
