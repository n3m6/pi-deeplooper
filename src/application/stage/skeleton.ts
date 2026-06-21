/**
 * Skeleton stage — builds the slice-0 scaffold in a worktree, then runs the
 * structure-mapper/reviewer review loop to produce structure.md.
 *
 * Resume behavior: early-PASS when structure.md already exists.
 */

import { parsePipeTable } from "../../infra/codec/markdown-codec.js";
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

    // Write the skeleton task spec so dl-skeleton can read it.
    const skeletonTaskContent = renderSkeletonTaskSpec({ goals, design, requirements, research });
    await writeArtifact(runtime, { kind: "skeletonTask" }, skeletonTaskContent);

    // Build the skeleton in a worktree using the fast-impl loop machinery.
    const repoRoot = await runtime.services.versionControl.resolveRepoRoot(signal);
    const worktree = await runtime.services.versionControl.prepareWorktree(0, "skeleton", repoRoot, signal);

    try {
      const implResult = await runFastImplLoopSubstage(runtime, {
        taskId: "skeleton",
        worktreeRoot: worktree.worktreeRoot,
        taskSpecId: { kind: "skeletonTask" },
      });

      if (implResult.status !== "PASS") {
        return {
          status: "FAIL",
          filesWritten: ["skeleton-task.md"],
          summary: `Skeleton build failed: ${implResult.summary}`,
          backwardLoop: {
            classification: "LOOP_DESIGN",
            summary: "Skeleton build failed; design needs revision.",
            guidance: implResult.summary,
          },
        };
      }

      // Commit and squash-merge the skeleton worktree.
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
    } finally {
      await runtime.services.versionControl.cleanupWorktree(worktree, signal).catch(() => {
        /* ignore cleanup failures */
      });
    }

    // Write skeleton-results.md.
    const skeletonResultsContent = renderSkeletonResults("PASS");
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
          await writeArtifact(runtime, { kind: "structure" }, mapResult.text);
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
        await writeArtifact(runtime, { kind: "structure" }, remapResult.text);
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
    const filesWritten = [
      artifactRelPath(runtime, { kind: "skeletonTask" }),
      artifactRelPath(runtime, { kind: "skeletonResults" }),
      "structure.md",
      artifactRelPath(runtime, stage7SummaryId),
      ...review.filesWritten,
    ];

    return {
      status: "PASS",
      filesWritten,
      summary: "Skeleton built and structure.md approved.",
      telemetry: {
        review_rounds: review.reviewRounds,
        terminal_review_state: "clean",
        child_agent_calls: {
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

function renderSkeletonResults(status: "PASS" | "FAIL"): string {
  return [
    `### Skeleton Status — ${status}`,
    "",
    "The skeleton build has completed.",
    "Directory structure, config files, and empty stubs are in place.",
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
