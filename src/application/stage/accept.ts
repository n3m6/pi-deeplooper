/**
 * DEEPLOOPER Global Accept stage.
 *
 * Runs the acceptance tester against the full set of completed slices.
 * On red/actionable failure:
 *   - Dispatches dl-reflector in global-remediation mode.
 *   - Reflector may append R-NNN remediation slices to slice-queue.md.
 *   - Returns status:"FAIL" with telemetry.remediationSlicesAdded=true
 *     so the transition policy routes back to slice-loop.
 *
 * Writes global-acceptance-results.md (run-level, not per-phase).
 * On clean pass (or no acceptance configured) → return PASS → pipeline routes to report.
 */

import { SliceQueue } from "../../domain/slice/slice-queue.js";
import { parseMarkdownSections } from "../../infra/codec/markdown-codec.js";
import type { ArtifactId, StageModule, StageOutcome, StageRuntime } from "../port/index.js";
import {
  appendReflectorLessons,
  artifactRelPath,
  dispatchGenericCoding,
  dispatchLeaf,
  readArtifact,
  safeReadArtifact,
  writeArtifact,
} from "./utils.js";

const MAX_ACCEPTANCE_LOOP_ROUNDS = 3;

export const acceptStage: StageModule = {
  stage: "accept",
  async run(runtime: StageRuntime): Promise<StageOutcome> {
    const repo = runtime.services.artifactRepo;

    const goals = await readArtifact(runtime, { kind: "goals" });
    const requirements = await readArtifact(runtime, { kind: "requirements" });
    const design = await safeReadArtifact(runtime, { kind: "design" });
    const structure = await safeReadArtifact(runtime, { kind: "structure" });
    const sliceQueueMd = await safeReadArtifact(runtime, { kind: "sliceQueue" });
    const lessons = await safeReadArtifact(runtime, { kind: "lessons" });

    // Read verification result as the overall acceptance contract baseline.
    const verificationResult = await safeReadArtifact(runtime, { kind: "stage9Summary" });

    // Gather per-phase execution manifests and stage summaries for context.
    const allStage7 = await readAllPhaseArtifacts(runtime, "stage7-summary.md");
    const allExecManifests = await readAllPhaseArtifacts(runtime, "execution-manifest.md");

    // 1. dl-coverage-planner — produce global acceptance plan.
    const coveragePlan = await dispatchLeaf(
      runtime,
      "dl-coverage-planner",
      [
        "=== MODE ===",
        "global",
        "",
        "=== GOALS ===",
        goals,
        "",
        "=== REQUIREMENTS ===",
        requirements,
        "",
        "=== DESIGN CONTEXT ===",
        design,
        "",
        "=== STRUCTURE CONTEXT ===",
        structure,
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
        "=== VERIFICATION RESULT ===",
        verificationResult,
      ].join("\n"),
    );

    const coveragePlanId: ArtifactId = { kind: "runFile", name: "global-coverage-plan.md" };
    await writeArtifact(runtime, coveragePlanId, coveragePlan.text);
    const filesWritten: string[] = [artifactRelPath(runtime, coveragePlanId)];

    // 2. Run acceptance tests via generic coding agent.
    let acceptanceOutcome: StageOutcome = {
      status: "FAIL",
      filesWritten: [],
      summary: "Acceptance testing did not run.",
    };
    let round = 1;
    while (round <= MAX_ACCEPTANCE_LOOP_ROUNDS) {
      acceptanceOutcome = await dispatchGenericCoding(
        runtime,
        [
          "You are running global acceptance testing for the DEEPLOOPER pipeline run.",
          "Only create or update acceptance/integration/e2e test files. Do not modify production code.",
          "Use the global coverage plan, slice queue, and goals as the contract.",
          "Run the relevant project tests, then return with stage_return.",
          "",
          "Required outputs:",
          "- Write needed test files under the workspace.",
          `- Summarize results in .pipeline/deeplooper-${runtime.state.runId}/global-acceptance-results.md.`,
          "",
          `Run ID: ${runtime.state.runId}`,
          `Coverage plan: ${repo.resolvePath(coveragePlanId)}`,
          "",
          "Return telemetry.evidence_quality with counts.",
        ].join("\n"),
        { cwd: runtime.workspaceRoot },
      );
      if (acceptanceOutcome.status === "PASS" || round === MAX_ACCEPTANCE_LOOP_ROUNDS) {
        break;
      }
      round += 1;
    }
    filesWritten.push(...acceptanceOutcome.filesWritten);

    // 3. Write global-acceptance-results.md.
    const globalAcceptId: ArtifactId = { kind: "globalAcceptanceResults" };
    const existingGlobalAccept = await repo.read(globalAcceptId);
    if (!existingGlobalAccept) {
      const summary =
        acceptanceOutcome.status === "PASS"
          ? `# Global Acceptance Results\n\n### Overall Status — PASS\n\n${acceptanceOutcome.summary}\n`
          : `# Global Acceptance Results\n\n### Overall Status — FAIL\n\n${acceptanceOutcome.summary}\n`;
      await writeArtifact(runtime, globalAcceptId, summary);
      filesWritten.push(artifactRelPath(runtime, globalAcceptId));
    }

    if (acceptanceOutcome.status === "PASS") {
      return {
        status: "PASS",
        filesWritten,
        summary: "Global acceptance testing passed.",
        telemetry: {
          ...acceptanceOutcome.telemetry,
          acceptance_loop_rounds: round,
          child_agent_calls: { "dl-coverage-planner": 1 },
        },
      };
    }

    // FAIL — dispatch dl-reflector in global-remediation mode.
    const globalAcceptMd = (await repo.read(globalAcceptId)) ?? acceptanceOutcome.summary;
    const reflect = await dispatchLeaf(
      runtime,
      "dl-reflector",
      [
        "=== MODE ===",
        "global-remediation",
        "",
        "=== GLOBAL ACCEPTANCE RESULTS ===",
        globalAcceptMd,
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
    const reflectSections = parseMarkdownSections(reflect.text);
    const existingQueue = sliceQueueMd ? SliceQueue.parse(sliceQueueMd) : SliceQueue.empty();
    const { queue: updatedQueue, reopened, added } = existingQueue.applyRemediationFromMarkdown(reflect.text);
    const remediationSlicesAdded = reopened.length > 0 || added.length > 0;

    if (remediationSlicesAdded) {
      await writeArtifact(runtime, { kind: "sliceQueue" }, updatedQueue.serialize());
      filesWritten.push("slice-queue.md");

      await appendReflectorLessons(runtime, reflectSections["Lessons"]);

      return {
        status: "FAIL",
        filesWritten,
        summary: "Global acceptance failed; remediation slices added — routing back to slice-loop.",
        telemetry: {
          acceptance_loop_rounds: round,
          remediationSlicesAdded: true,
          slicesReopened: reopened,
          slicesAdded: added,
          child_agent_calls: { "dl-coverage-planner": 1, "dl-reflector": 1 },
        },
      };
    }

    // No actionable remediation — escalate.
    return {
      status: "FAIL",
      filesWritten,
      summary: "Global acceptance failed with no actionable remediation.",
      telemetry: {
        acceptance_loop_rounds: round,
        remediationSlicesAdded: false,
        child_agent_calls: { "dl-coverage-planner": 1, "dl-reflector": 1 },
      },
      backwardLoop: {
        classification: "LOOP_DESIGN",
        summary: "Acceptance found non-remediable failures; design needs revision.",
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
