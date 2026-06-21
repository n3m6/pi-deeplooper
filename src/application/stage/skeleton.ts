/**
 * Skeleton stage — builds the slice-0 scaffold in a worktree, then runs the
 * structure-mapper/reviewer review loop to produce structure.md.
 *
 * Resume behavior: early-PASS when structure.md already exists.
 *
 * Self-correction loop (MAX_SKELETON_REVIEW_ROUNDS):
 *   build → dl-skeleton-reviewer → SCAFFOLD_OK (merge) | OVER_IMPLEMENTATION (repair/carry) | SCAFFOLD_BROKEN (escalate)
 */

import { extractMarkdownDocument, extractFixGuidance, parsePipeTable } from "../../infra/codec/markdown-codec.js";
import { SliceQueue } from "../../domain/slice/slice-queue.js";
import { MAX_SKELETON_REVIEW_ROUNDS, effectiveReviewRounds } from "../../domain/run/index.js";
import { runAgentReviewLoop } from "../workflow/agent-review-loop.js";
import { runFastImplLoopSubstage } from "./fast-impl-loop.js";
import type { StageModule, StageOutcome, StageRuntime } from "../port/index.js";
import {
  artifactRelPath,
  dispatchFailureSummary,
  dispatchLeaf,
  isTransientDispatchFailure,
  readArtifact,
  recordAnomaly,
  safeReadArtifact,
  writeArtifact,
} from "./utils.js";

/** Classification returned by dl-skeleton-reviewer. */
type SkeletonClassification = "SCAFFOLD_OK" | "OVER_IMPLEMENTATION" | "SCAFFOLD_BROKEN";

function parseSkeletonClassification(reviewText: string): SkeletonClassification {
  const match = reviewText.match(/^Classification:\s*(SCAFFOLD_OK|OVER_IMPLEMENTATION|SCAFFOLD_BROKEN)\b/m);
  const cls = match?.[1];
  if (cls === "SCAFFOLD_OK") return "SCAFFOLD_OK";
  if (cls === "OVER_IMPLEMENTATION") return "OVER_IMPLEMENTATION";
  // Default to SCAFFOLD_BROKEN on parse failure — conservative: route to design, not a silent hard fail.
  return "SCAFFOLD_BROKEN";
}

export const skeletonStage: StageModule = {
  stage: "skeleton",
  async run(runtime): Promise<StageOutcome> {
    const repo = runtime.services.artifactRepo;
    const signal = runtime.services.eventContext.signal;

    // Early-PASS when structure.md exists AND the scaffold files it specifies are on disk.
    // If structure.md exists but the files are absent (e.g. after a design escalation that
    // changed the scaffold), fall through and rebuild.
    const structureExists = await repo.exists({ kind: "structure" });
    if (structureExists) {
      const structureMd = (await repo.read({ kind: "structure" })) ?? "";
      const missingScaffold = await findMissingScaffoldFiles(runtime, structureMd);

      if (missingScaffold.length === 0) {
        return {
          status: "PASS",
          filesWritten: [],
          summary: "structure.md already exists; skeleton early-PASS (resume/re-entry).",
          telemetry: { deterministic_fast_path: "resume-skip" },
        };
      }

      // Scaffold files are missing — emit an anomaly and fall through to rebuild.
      await recordAnomaly(
        runtime,
        "skeleton-scaffold-missing",
        "warning",
        `structure.md exists but ${missingScaffold.length} expected scaffold file(s) are absent from disk — rebuilding skeleton.`,
        { missingFiles: missingScaffold },
      );
    }

    const goals = await readArtifact(runtime, { kind: "goals" });
    const design = await readArtifact(runtime, { kind: "design" });
    const requirements = await safeReadArtifact(runtime, { kind: "requirements" });
    const research = await safeReadArtifact(runtime, { kind: "researchSummary" });

    // Detect tiny projects upfront so carry-forward logic is ready.
    const tinyProject = SliceQueue.isTinyProject(design);

    // Write the skeleton task spec so the coding worker can read it.
    const skeletonTaskContent = renderSkeletonTaskSpec({ goals, design, requirements, research });
    await writeArtifact(runtime, { kind: "skeletonTask" }, skeletonTaskContent);

    // Build the skeleton in a worktree using the fast-impl loop machinery.
    const repoRoot = await runtime.services.versionControl.resolveRepoRoot(signal);
    const worktree = await runtime.services.versionControl.prepareWorktree(0, "skeleton", repoRoot, signal);

    // Track whether the over-implementation carry-forward path was taken.
    let carryForward = false;
    // Count actual dl-skeleton-reviewer dispatches across all self-correction rounds.
    let reviewerCallCount = 0;

    try {
      // -----------------------------------------------------------------------
      // Bounded self-correction loop: build → dl-skeleton-reviewer → repair
      // -----------------------------------------------------------------------
      const maxRounds = effectiveReviewRounds(runtime.services.gates.reviewDepth, MAX_SKELETON_REVIEW_ROUNDS);
      let repairGuidance: string | undefined = undefined;
      let lastClassification: SkeletonClassification = "SCAFFOLD_BROKEN";
      let lastImplStatus: StageOutcome["status"] = "FAIL";

      for (let round = 1; round <= maxRounds; round++) {
        const implResult = await runFastImplLoopSubstage(runtime, {
          taskId: "skeleton",
          worktreeRoot: worktree.worktreeRoot,
          taskSpecId: { kind: "skeletonTask" },
          ...(repairGuidance !== undefined ? { repairGuidance } : {}),
        });
        lastImplStatus = implResult.status;

        // Dispatch dl-skeleton-reviewer (read-only) against the worktree regardless of implResult.
        // It can classify whether the issue is structural (SCAFFOLD_BROKEN) or over-implementation.
        const reviewerPrompt = buildSkeletonReviewerPrompt(worktree.worktreeRoot, goals, design, skeletonTaskContent);
        const reviewResult = await dispatchLeaf(runtime, "dl-skeleton-reviewer", reviewerPrompt, {
          cwd: worktree.worktreeRoot,
          tools: ["read", "bash", "grep", "find", "ls"],
        });

        const reviewFailure = dispatchFailureSummary(reviewResult, "dl-skeleton-reviewer");
        if (reviewFailure) {
          // Infra failure — hard FAIL without a design loop (not design's fault).
          return {
            status: "FAIL",
            filesWritten: ["skeleton-task.md"],
            summary: `Skeleton reviewer dispatch failed: ${reviewFailure}`,
          };
        }
        reviewerCallCount += 1;

        lastClassification = parseSkeletonClassification(reviewResult.text);
        const fixGuidance = extractFixGuidance(reviewResult.text);

        if (lastClassification === "SCAFFOLD_OK") {
          // Scaffold is correct stubs — proceed to merge.
          break;
        }

        if (lastClassification === "OVER_IMPLEMENTATION") {
          const implPassed = lastImplStatus === "PASS" || lastImplStatus === "PARTIAL";
          if (tinyProject && implPassed) {
            // Tiny project with working over-implementation: accept and carry forward.
            carryForward = true;
            break;
          }
          if (round < maxRounds) {
            // Still have rounds left — give repair guidance and retry.
            repairGuidance =
              fixGuidance !== "None." && fixGuidance.trim()
                ? fixGuidance
                : `Over-implementation detected in round ${round}. Reduce source files to minimal stubs — no business logic.`;
            continue;
          }
          // Exhausted local retries for over-implementation — hard FAIL (not design-rooted).
          return {
            status: "FAIL",
            filesWritten: ["skeleton-task.md"],
            summary: `Skeleton over-implementation could not be repaired after ${maxRounds} round(s). ${fixGuidance}`,
          };
        }

        // SCAFFOLD_BROKEN — structural/config/build problem rooted in the design.
        return {
          status: "FAIL",
          filesWritten: ["skeleton-task.md"],
          summary: `Skeleton build failed; design needs revision. ${fixGuidance}`,
          backwardLoop: {
            classification: "LOOP_DESIGN",
            summary: "Skeleton build failed; design needs revision.",
            guidance: fixGuidance !== "None." && fixGuidance.trim() ? fixGuidance : implResult.summary,
          },
        };
      }

      // -----------------------------------------------------------------------
      // Merge the worktree into the run branch (common to SCAFFOLD_OK and carry-forward).
      // -----------------------------------------------------------------------
      const changed = await runtime.services.versionControl.changedFiles(worktree.worktreeRoot, signal);
      if (changed.length > 0) {
        await runtime.services.versionControl.commitWorktreeChanges(
          worktree.worktreeRoot,
          `deeplooper: skeleton build`,
          signal,
        );
      }
      const merge = await runtime.services.versionControl.squashMerge(worktree, `deeplooper: skeleton build`, signal);
      if (!merge.ok) {
        return {
          status: "FAIL",
          filesWritten: ["skeleton-task.md"],
          summary: `Skeleton squash-merge conflict: ${merge.conflictOutput ?? "merge conflict"}`,
          backwardLoop: {
            classification: "LOOP_DESIGN",
            summary: "Skeleton merge failed; design needs revision.",
          },
        };
      }

      // -----------------------------------------------------------------------
      // For SCAFFOLD_BROKEN detected after exhausting rounds (unreachable via the
      // current loop but kept for safety): fallback return.
      // Only executed when maxRounds = 0 or the loop exited without break/return
      // via an unexpected path — treat as hard FAIL.
      // -----------------------------------------------------------------------
      if (lastClassification === "SCAFFOLD_BROKEN" && !carryForward) {
        return {
          status: "FAIL",
          filesWritten: ["skeleton-task.md"],
          summary: "Skeleton reviewer loop exhausted without a SCAFFOLD_OK verdict.",
          backwardLoop: {
            classification: "LOOP_DESIGN",
            summary: "Skeleton could not reach a valid scaffold; design needs revision.",
          },
        };
      }
    } finally {
      await runtime.services.versionControl.cleanupWorktree(worktree, signal).catch(() => {
        /* ignore cleanup failures */
      });
    }

    // -----------------------------------------------------------------------
    // Post-merge: write artifacts and run structure loop.
    // -----------------------------------------------------------------------

    // Carry-forward path: mark all design slices done so slice-loop skips them.
    if (carryForward) {
      let queue = SliceQueue.buildInitial(design);
      for (const slice of queue.slices) {
        queue = queue.markDone(slice.id);
      }
      await writeArtifact(runtime, { kind: "sliceQueue" }, queue.serialize());
    }

    // Write skeleton-results.md.
    const skeletonResultsContent = renderSkeletonResults("PASS", carryForward ? "carry-forward" : undefined);
    await writeArtifact(runtime, { kind: "skeletonResults" }, skeletonResultsContent);

    // Run structure-mapper + structure-reviewer review loop.
    const review = await runAgentReviewLoop(runtime, {
      maxRounds: 5,
      stageName: "skeleton",
      runReview: async () => {
        const structure = await safeReadArtifact(runtime, { kind: "structure" });
        if (!structure) {
          // Structure not yet mapped — run structure-mapper first.
          const mapResult = await dispatchLeaf(
            runtime,
            "dl-structure-mapper",
            ["=== GOALS ===", goals, "", "=== DESIGN ===", design, "", "=== RESEARCH SUMMARY ===", research ?? ""].join(
              "\n",
            ),
          );
          const mapFailure = dispatchFailureSummary(mapResult, "Structure mapping failed");
          if (mapFailure) {
            return { failure: mapFailure, transient: isTransientDispatchFailure(mapResult) };
          }
          await writeArtifact(runtime, { kind: "structure" }, extractMarkdownDocument(mapResult.text, "# Structure"));
        }

        const structureText = await readArtifact(runtime, { kind: "structure" });
        const reviewResult = await dispatchLeaf(
          runtime,
          "dl-structure-reviewer",
          ["=== GOALS ===", goals, "", "=== DESIGN ===", design, "", "=== STRUCTURE ===", structureText ?? ""].join(
            "\n",
          ),
        );
        const reviewFailure = dispatchFailureSummary(reviewResult, "Structure review failed");
        if (reviewFailure) return { failure: reviewFailure, transient: isTransientDispatchFailure(reviewResult) };
        return { text: reviewResult.text };
      },
      onFail: async (reviewText) => {
        const remapResult = await dispatchLeaf(
          runtime,
          "dl-structure-mapper",
          [
            "=== GOALS ===",
            goals,
            "",
            "=== DESIGN ===",
            design,
            "",
            "=== RESEARCH SUMMARY ===",
            research ?? "",
            "",
            "=== REVIEW FEEDBACK ===",
            reviewText,
          ].join("\n"),
        );
        const remapFailure = dispatchFailureSummary(remapResult, "Structure re-map failed");
        if (remapFailure) return { failure: remapFailure, transient: isTransientDispatchFailure(remapResult) };
        await writeArtifact(runtime, { kind: "structure" }, extractMarkdownDocument(remapResult.text, "# Structure"));
      },
    });

    if (review.status === "FAIL") {
      return {
        status: "FAIL",
        filesWritten: ["skeleton-task.md", "skeleton-results.md"],
        summary: review.summary ?? "Structure review loop did not converge.",
        telemetry: { review_rounds: review.reviewRounds, terminal_review_state: "unclean-cap" },
        backwardLoop: {
          classification: "LOOP_DESIGN",
          summary: "Structure review could not converge; design needs revision.",
        },
      };
    }

    // Write stage7-summary.md inside the skeleton dir (via runFile).
    const stage7SummaryId = { kind: "runFile" as const, name: "skeleton/stage7-summary.md" };
    await writeArtifact(runtime, stage7SummaryId, renderStage7Summary());

    const extraFiles = carryForward ? [artifactRelPath(runtime, { kind: "sliceQueue" })] : [];
    const filesWritten = [
      artifactRelPath(runtime, { kind: "skeletonTask" }),
      artifactRelPath(runtime, { kind: "skeletonResults" }),
      "structure.md",
      artifactRelPath(runtime, stage7SummaryId),
      ...extraFiles,
      ...review.filesWritten,
    ];

    return {
      status: "PASS",
      filesWritten,
      summary: carryForward
        ? "Skeleton over-implementation accepted as carry-forward (tiny project). All slices marked done."
        : "Skeleton built and structure.md approved.",
      telemetry: {
        review_rounds: review.reviewRounds,
        terminal_review_state: "clean",
        ...(carryForward ? { deterministic_fast_path: "carry-forward-tiny" } : {}),
        child_agent_calls: {
          "dl-skeleton-reviewer": reviewerCallCount,
          "dl-structure-mapper": 1,
          "dl-structure-reviewer": review.reviewRounds,
        },
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function renderSkeletonTaskSpec(context: {
  goals: string | undefined;
  design: string | undefined;
  requirements: string | undefined;
  research: string | undefined;
}): string {
  return [
    "# Skeleton Task Spec",
    "",
    "## Purpose",
    "Build the initial scaffolding for the project based on the design.",
    "Create directory layout, config files, and empty module stubs.",
    "Do NOT implement logic — only set up the structure.",
    "",
    "## Goals",
    context.goals ?? "See goals.md",
    "",
    "## Design",
    context.design ?? "See design.md",
    "",
    "## Requirements",
    context.requirements ?? "See requirements.md",
    "",
    "## Research Summary",
    context.research ?? "See research/summary.md",
    "",
    "## Success Criteria",
    "- All top-level directories from the design exist.",
    "- Stub files / empty modules are in place.",
    "- The project builds (or installs) without errors.",
    "- No business logic is implemented yet.",
  ].join("\n");
}

function renderSkeletonResults(status: "PASS" | "FAIL", variant?: "carry-forward"): string {
  const note =
    variant === "carry-forward"
      ? "Over-implementation accepted as carry-forward for tiny project. All vertical slices have been pre-marked done in slice-queue.md."
      : "Directory structure, config files, and empty stubs are in place.";
  return [`### Skeleton Status — ${status}`, "", "The skeleton build has completed.", note].join("\n");
}

function buildSkeletonReviewerPrompt(
  worktreeRoot: string,
  goals: string,
  design: string,
  skeletonTask: string,
): string {
  return [
    "=== GOALS ===",
    goals,
    "",
    "=== DESIGN ===",
    design,
    "",
    "=== SKELETON TASK SPEC ===",
    skeletonTask,
    "",
    "=== WORKTREE ROOT ===",
    worktreeRoot,
  ].join("\n");
}

function renderStage7Summary(): string {
  return [
    "### Status — PASS",
    "",
    "# Stage 7 Summary — Skeleton",
    "",
    "Skeleton scaffolding built and structure.md approved.",
  ].join("\n");
}

/**
 * Parse expected CREATE files from structure.md's File Map table and return the subset
 * that are absent from the workspace. Returns [] when all files are present (or when
 * structure.md has no parseable File Map table).
 */
async function findMissingScaffoldFiles(runtime: StageRuntime, structureMd: string): Promise<string[]> {
  const repo = runtime.services.artifactRepo;

  // The File Map section is a pipe table under "## File Map" or inside a Slice section.
  // Rows look like: | `path/to/file.ts` | CREATE | Purpose |
  const rows = parsePipeTable(structureMd);
  const missing: string[] = [];

  for (const row of rows) {
    // Skip header/separator rows and rows where the action column doesn't say CREATE.
    if (row.length < 2) continue;
    const rawPath = (row[0] ?? "").replace(/`/g, "").trim();
    const action = (row[1] ?? "").trim().toUpperCase();
    if (!rawPath || !action.includes("CREATE")) continue;

    // Check if the file exists in the workspace.
    const content = await repo.readWorkspaceFile(rawPath);
    if (content === undefined) {
      missing.push(rawPath);
    }
  }

  return missing;
}
