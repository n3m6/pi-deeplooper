/**
 * DEEPLOOPER Resume Protocol — reconstruct RunState from artifacts on disk.
 *
 * Priority:
 *   1. state.json — engine's machine state (authoritative; loaded by state-repository.ts).
 *   2. Artifacts — derived from presence/status of well-known files.
 *
 * Artifact markers (in order):
 *   goals.md             → goals PASS
 *   research/summary.md  → research PASS
 *   design.md            → design PASS
 *   structure.md         → skeleton PASS (structure mapper ran)
 *   skeleton-results.md  → skeleton PASS (build ran; secondary check)
 *   baseline-results.md  → baseline PASS
 *   slice-queue.md       → slice-loop started (check queue state for completion)
 *   stage9-summary.md    → verify PASS / PARTIAL (slice-loop exhausted)
 *   global-acceptance-results.md → accept PASS
 *   stage10-summary.md   → report PASS
 *
 * NOTE: state.json is kept as the engine's own machine state (consistent with how
 * pi-deepwork works). The DEEPLOOPER spec's state.md is informational only.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { SliceQueue } from "../../domain/slice/slice-queue.js";
import { nextStageFor } from "../../domain/stage/transition-policy.js";
import { loadState } from "./state-repository.js";
import { fileExists, getRunArtifacts } from "./artifact-repository.js";
import type {
  FailurePolicy,
  InteractionMode,
  RunState,
  StageName,
  VerifyStatus,
} from "../../application/port/index.js";
import type { RunArtifacts } from "./artifact-repository.js";

export async function resumeOrInferState(options: {
  workspaceRoot: string;
  runId: string;
  interactionMode: InteractionMode;
  failurePolicy: FailurePolicy;
}): Promise<RunState | undefined> {
  const artifacts = getRunArtifacts(options.workspaceRoot, options.runId);
  const state = await loadState(artifacts.stateFile);
  if (state) {
    return { ...state, resumeSource: "resume" };
  }
  return inferStateFromArtifacts(artifacts, options.interactionMode, options.failurePolicy);
}

export async function inferStateFromArtifacts(
  artifacts: RunArtifacts,
  interactionMode: InteractionMode,
  failurePolicy: FailurePolicy,
): Promise<RunState | undefined> {
  const completed: StageName[] = [];
  let last: StageName | undefined;
  let verifyStatus: VerifyStatus | undefined;

  // Slice-loop state derived from slice-queue.md.
  let slicesDone: string[] = [];
  let slicesBlocked: string[] = [];
  const pendingReconcile = false;

  // Walk artifact markers in pipeline order.
  if (await markerPasses(artifacts.goalsFile)) {
    appendUnique(completed, "goals");
    last = "goals";
  }
  if (!last) return undefined;

  if (await markerPasses(artifacts.researchSummaryFile)) {
    appendUnique(completed, "research");
    last = "research";
  }

  if (last === "research" && (await markerPasses(artifacts.designFile))) {
    appendUnique(completed, "design");
    last = "design";
  }

  if (last === "design") {
    const structurePasses = await markerPasses(artifacts.structureFile);
    const skeletonResultsPasses = await markerPasses(artifacts.skeletonResultsFile);
    if (structurePasses || skeletonResultsPasses) {
      appendUnique(completed, "skeleton");
      last = "skeleton";
    }
  }

  if (last === "skeleton" && (await markerPasses(artifacts.baselineResultsFile))) {
    appendUnique(completed, "baseline");
    last = "baseline";
  }

  if (last === "baseline") {
    // Check slice-queue.md for slice-loop progress.
    const queueMd = await readSafe(artifacts.sliceQueueFile);
    if (queueMd) {
      const queue = SliceQueue.parse(queueMd);
      slicesDone = queue.slices.filter((s) => s.status === "done").map((s) => s.id);
      slicesBlocked = queue.slices.filter((s) => s.status === "blocked" || s.status === "escalated").map((s) => s.id);

      // slice-loop PASS when queue is exhausted (no pending/ready/building).
      if (queue.isExhausted()) {
        appendUnique(completed, "slice-loop");
        last = "slice-loop";
      } else {
        // Slice-loop started but not exhausted → resume back into slice-loop.
        appendUnique(completed, "slice-loop");
        // Don't advance last — next stage should be "slice-loop".
        last = "baseline";
      }
    }
  }

  // verify
  const verifyContent = await readSafe(artifacts.stage9SummaryFile);
  if (verifyContent) {
    const parsed = parseStatus(verifyContent);
    if (parsed && parsed !== "FAIL") {
      verifyStatus = parsed;
      appendUnique(completed, "verify");
      last = "verify";
    }
  }

  // accept
  const acceptContent = await readSafe(artifacts.globalAcceptanceResultsFile);
  if (acceptContent && last === "verify") {
    const parsed = parseStatus(acceptContent);
    if (parsed && parsed !== "FAIL") {
      appendUnique(completed, "accept");
      last = "accept";
    }
  }

  // report
  if (last === "accept" && (await fileExists(artifacts.stage10SummaryFile))) {
    appendUnique(completed, "report");
    last = "report";
  }

  if (!last) return undefined;

  const nextStage = nextStageFor(last, {
    ...(verifyStatus ? { verifyStatus } : {}),
  });

  const now = new Date().toISOString();
  return {
    runId: path.basename(artifacts.runDir),
    route: "full",
    lastCompletedStage: last,
    nextStage,
    stagesCompleted: completed,
    backwardLoops: 0,
    resumeSource: "artifacts",
    interactionMode,
    failurePolicy,
    ...(verifyStatus ? { verifyStatus } : {}),
    // Slice-loop state.
    currentSlice: null,
    slicesDone,
    slicesBlocked,
    requeueCounts: {},
    pendingReconcile,
    startedAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

async function markerPasses(filePath: string): Promise<boolean> {
  if (!(await fileExists(filePath))) return false;
  const content = await readSafe(filePath);
  return Boolean(content) && !containsFailMarker(content);
}

function containsFailMarker(content: string): boolean {
  return /###\s+(?:Overall\s+)?Status\s+[—-]\s+FAIL\b/i.test(content);
}

function parseStatus(content: string): VerifyStatus | undefined {
  const m =
    content.match(/###\s+Overall\s+Status\s+[—-]\s+(PASS|PARTIAL|FAIL)\b/i)?.[1]?.toUpperCase() ??
    content.match(/###\s+Status\s+[—-]\s+(PASS|PARTIAL|FAIL)\b/i)?.[1]?.toUpperCase();
  return m === "PASS" || m === "PARTIAL" || m === "FAIL" ? m : undefined;
}

function appendUnique(stages: StageName[], stage: StageName): void {
  if (!stages.includes(stage)) {
    stages.push(stage);
  }
}

async function readSafe(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}
