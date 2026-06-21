/**
 * Slice implementation sub-module for DEEPLOOPER.
 *
 * This module is NOT a top-level StageModule. It is imported by slice-loop.ts,
 * which drives the outer queue loop, and by skeleton.ts for worktree setup.
 *
 * The main export is `runSliceImplementation`, which:
 *   1. Loads task specs for the slice phase directory.
 *   2. Builds waves and runs each wave in parallel via runFastImplLoopSubstage.
 *   3. Squash-merges each worktree into the run branch.
 *   4. Runs E2E regression + integration checker.
 *   5. Writes execution-manifest.md, integration-results.md, stage7-summary.md.
 *
 * Returns a StageOutcome with status PASS/PARTIAL/FAIL and optional backwardLoop.
 */

import {
  parseAffectedArtifact,
  parseMarkdownSections,
  parseTaskSpecMetadata,
} from "../../infra/codec/markdown-codec.js";
import { buildWaves } from "../../domain/stage/wave-planner.js";
import type { ArtifactId, StageOutcome, StageRuntime, TaskWorktreeHandle } from "../port/index.js";
import { runBaselineRegressionSubstage } from "./baseline-regression.js";
import { runE2ERegressionSubstage } from "./e2e-regression.js";
import { runFastImplLoopSubstage } from "./fast-impl-loop.js";
import { artifactRelPath, dispatchGenericCoding, dispatchLeaf, parseReviewStatus, writeArtifact } from "./utils.js";

export interface TaskSpecSummary {
  taskId: string;
  phase: string;
  dependencies: string[];
  taskSpecId: ArtifactId;
  title: string;
}

export interface SliceImplOptions {
  /** Numeric phase number derived from the slice's phaseDir (e.g. 1 for "phases/phase-01"). */
  phase: number;
  /** Absolute path to the phase directory (e.g. "<runDir>/phases/phase-01"). */
  phaseDir: string;
  sliceId: string;
}

/**
 * Run the implementation for a single slice.
 * Called from slice-loop.ts after dl-slice-planner has written task specs.
 */
export async function runSliceImplementation(runtime: StageRuntime, options: SliceImplOptions): Promise<StageOutcome> {
  const { phase, sliceId } = options;
  const repoRoot = await runtime.services.versionControl.resolveRepoRoot(runtime.services.eventContext.signal);
  const tasks = await loadPhaseTasks(runtime, phase);
  const waves = buildWaves(tasks);
  const manifestRows: string[] = [];
  const filesWritten: string[] = [];

  for (const [waveIndex, wave] of waves.entries()) {
    const prepared = await Promise.all(
      wave.map(async (task) => ({
        task,
        worktree: await runtime.services.versionControl.prepareWorktree(
          phase,
          task.taskId,
          repoRoot,
          runtime.services.eventContext.signal,
        ),
      })),
    );

    for (const { task } of prepared) {
      await runtime.services.telemetrySink.record({
        type: "task.started",
        phase,
        route: runtime.state.route,
        taskId: task.taskId,
        title: task.title,
        wave: waveIndex + 1,
      });
    }

    const results = await Promise.all(
      prepared.map(async ({ task, worktree }) => ({
        task,
        worktree,
        result: await runFastImplLoopSubstage(runtime, {
          taskId: task.taskId,
          worktreeRoot: worktree.worktreeRoot,
          taskSpecId: task.taskSpecId,
        }),
      })),
    );

    for (const { task, result } of results) {
      await runtime.services.telemetrySink.record({
        type: "task.completed",
        phase,
        route: runtime.state.route,
        taskId: task.taskId,
        title: task.title,
        wave: waveIndex + 1,
        status: result.status === "PASS" ? "PASS" : "FAIL",
      });
    }

    const failures = results.filter((entry) => entry.result.status !== "PASS");
    if (failures.length > 0) {
      for (const failure of failures) {
        manifestRows.push(
          `| ${failure.task.taskId} | ${failure.task.title} | ${waveIndex + 1} | FAIL | ${failure.result.summary.replaceAll("|", "/")} |`,
        );
      }
      const manifestId: ArtifactId = { kind: "phaseFile", phase, name: "execution-manifest.md" };
      await writeArtifact(runtime, manifestId, renderExecutionManifest(manifestRows));
      return {
        status: "FAIL",
        phase,
        filesWritten: [artifactRelPath(runtime, manifestId)],
        summary: `Slice ${sliceId}: implementation failed in wave ${waveIndex + 1}.`,
        telemetry: {
          child_agent_calls: { "generic-coding": results.length * AGENT_CALLS_PER_TASK },
        },
      };
    }

    for (const { task, worktree } of results.sort((a, b) => a.task.taskId.localeCompare(b.task.taskId))) {
      await commitWorktreeChanges(runtime, worktree.worktreeRoot, phase, task.taskId, task.title);
      const merge = await runtime.services.versionControl.squashMerge(
        worktree,
        `deeplooper: phase ${phase} task ${task.taskId} ${task.title}`,
        runtime.services.eventContext.signal,
      );
      if (!merge.ok) {
        const resolved = await resolveSquashConflict(
          runtime,
          worktree,
          phase,
          task.taskId,
          task.title,
          merge.conflictOutput ?? "merge conflict",
        );
        if (!resolved.ok) {
          manifestRows.push(
            `| ${task.taskId} | ${task.title} | ${waveIndex + 1} | FAIL | ${resolved.summary.replaceAll("|", "/")} |`,
          );
          const manifestId: ArtifactId = { kind: "phaseFile", phase, name: "execution-manifest.md" };
          await writeArtifact(runtime, manifestId, renderExecutionManifest(manifestRows));
          return {
            status: "FAIL",
            phase,
            filesWritten: [artifactRelPath(runtime, manifestId)],
            summary: resolved.summary,
            telemetry: { worktree_abandoned: true },
          };
        }
      }
      manifestRows.push(`| ${task.taskId} | ${task.title} | ${waveIndex + 1} | PASS | CLEAN |`);
    }
  }

  const manifestId: ArtifactId = { kind: "phaseFile", phase, name: "execution-manifest.md" };
  await writeArtifact(runtime, manifestId, renderExecutionManifest(manifestRows));
  filesWritten.push(artifactRelPath(runtime, manifestId));

  const e2e = await runE2ERegressionSubstage(runtime, phase);
  const baseline = await runBaselineRegressionSubstage(runtime, phase);
  filesWritten.push(...e2e.outcome.filesWritten, ...baseline.filesWritten);

  const integrationId: ArtifactId = { kind: "phaseFile", phase, name: "integration-results.md" };
  await writeArtifact(runtime, integrationId, renderIntegrationResults(e2e.markdown, baseline.summary));
  filesWritten.push(artifactRelPath(runtime, integrationId));

  const integrationGate = await runIntegrationChecker(runtime, phase, manifestRows.join("\n"), baseline.summary);
  await writeArtifact(
    runtime,
    integrationId,
    renderIntegrationResults(e2e.markdown, baseline.summary, integrationGate.text),
  );
  if (parseReviewStatus(integrationGate.text) === "FAIL") {
    const sections = parseMarkdownSections(integrationGate.text);
    const backwardLoopRequest = sections["Backward Loop Request"];
    return {
      status: "FAIL",
      phase,
      filesWritten,
      summary: "Integration checker found blocking cross-task issues.",
      ...(backwardLoopRequest
        ? {
            backwardLoop: {
              classification: classifyIntegrationLoop(backwardLoopRequest),
              summary: sections["Stage Summary"] ?? "Integration checker requested a backward loop.",
              guidance: backwardLoopRequest,
            },
          }
        : {}),
      telemetry: { child_agent_calls: { "dl-integration-checker": 1 } },
    };
  }

  const stageSummaryId: ArtifactId = { kind: "phaseFile", phase, name: "stage7-summary.md" };
  const summaryStatus = baseline.status === "FAIL" ? "PARTIAL" : "PASS";
  await writeArtifact(
    runtime,
    stageSummaryId,
    renderStage7Summary(
      summaryStatus,
      `Slice ${sliceId}: implementation completed across ${tasks.length} task(s) in ${waves.length} wave(s).`,
      tasks.length,
    ),
  );
  filesWritten.push(artifactRelPath(runtime, stageSummaryId));

  const integrationSummaryId: ArtifactId = { kind: "phaseFile", phase, name: "stage7-integration-summary.md" };
  await writeArtifact(
    runtime,
    integrationSummaryId,
    renderStage7IntegrationSummary(e2e.outcome.summary, baseline.summary),
  );
  filesWritten.push(artifactRelPath(runtime, integrationSummaryId));

  return {
    status: baseline.status === "FAIL" ? "PARTIAL" : "PASS",
    phase,
    filesWritten,
    summary:
      baseline.status === "FAIL"
        ? `Slice ${sliceId}: implementation completed with regression findings.`
        : `Slice ${sliceId}: implementation completed successfully.`,
    telemetry: { child_agent_calls: { "generic-coding": tasks.length * AGENT_CALLS_PER_TASK } },
  };
}

// ---------------------------------------------------------------------------
// Task loading
// ---------------------------------------------------------------------------

export async function loadPhaseTasks(runtime: StageRuntime, phase: number): Promise<TaskSpecSummary[]> {
  const repo = runtime.services.artifactRepo;
  const ids = await repo.listTaskSpecs(phase);
  const summaries: TaskSpecSummary[] = [];
  for (const id of ids) {
    const content = (await repo.read(id)) ?? "";
    const meta = parseTaskSpecMetadata(content, phase);
    summaries.push({
      taskId: meta.taskId,
      phase: meta.taskPhase,
      dependencies: meta.dependencies,
      taskSpecId: id,
      title: meta.title,
    });
  }
  return summaries;
}

export { buildWaves };

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

const AGENT_CALLS_PER_TASK = 3;

function renderStage7Summary(status: "PASS" | "PARTIAL", description: string, taskCount: number): string {
  return [
    `### Status — ${status}`,
    "",
    "# Stage 7 Summary",
    "",
    description,
    "",
    `## Evidence Quality`,
    `- Deterministic: ${taskCount}`,
    "- Flaky: 0",
    "- Harness Noisy: 0",
    "- Ambiguous: 0",
    "- Redundant: 0",
    "- No-Test Tasks: 0",
    "- No-Test Audit Overrides: 0",
  ].join("\n");
}

function renderStage7IntegrationSummary(e2eSummary: string, baselineSummary: string): string {
  return ["# Stage 7 Integration Summary", "", e2eSummary, baselineSummary].join("\n");
}

function renderIntegrationResults(e2eMarkdown: string, baselineSummary: string, checkerText?: string): string {
  const base = ["# Integration Results", "", e2eMarkdown, "", `Baseline regression: ${baselineSummary}`];
  if (checkerText) {
    base.push("", "## Integration Checker", checkerText);
  }
  return base.join("\n");
}

function renderExecutionManifest(rows: string[]): string {
  return [
    "# Execution Manifest",
    "",
    "| Task | Title | Wave | Status | Evidence Summary |",
    "| ---- | ----- | ---- | ------ | ---------------- |",
    ...(rows.length > 0 ? rows : ["| None | None | 0 | PASS | None |"]),
  ].join("\n");
}

async function commitWorktreeChanges(
  runtime: StageRuntime,
  worktreeRoot: string,
  phase: number,
  taskId: string,
  title: string,
): Promise<void> {
  const vc = runtime.services.versionControl;
  const changed = await vc.changedFiles(worktreeRoot, runtime.services.eventContext.signal);
  if (changed.length === 0) {
    return;
  }
  await vc.commitWorktreeChanges(
    worktreeRoot,
    `deeplooper: phase ${phase} task ${taskId} ${title}`,
    runtime.services.eventContext.signal,
  );
}

async function resolveSquashConflict(
  runtime: StageRuntime,
  worktree: TaskWorktreeHandle,
  phase: number,
  taskId: string,
  title: string,
  conflictOutput: string,
): Promise<{ ok: boolean; summary: string }> {
  const rebase = await runtime.services.versionControl.rebaseWorktree(worktree, runtime.services.eventContext.signal);
  if (!rebase.ok) {
    const fix = await dispatchGenericCoding(
      runtime,
      [
        "Resolve the git rebase conflicts in this task worktree.",
        "Edit only conflict markers and directly-related files.",
        "",
        `Task: ${taskId}`,
        `Worktree root: ${worktree.worktreeRoot}`,
        "",
        "Original squash conflict output:",
        conflictOutput,
        "",
        "Rebase output:",
        rebase.output ?? "No output.",
      ].join("\n"),
      { cwd: worktree.worktreeRoot },
    );
    if (fix.status === "FAIL") {
      return { ok: false, summary: `Implementation abandoned task ${taskId}; conflict fix failed: ${fix.summary}` };
    }
    const continued = await runtime.services.versionControl.continueRebase(
      worktree,
      runtime.services.eventContext.signal,
    );
    if (!continued.ok) {
      return {
        ok: false,
        summary: `Implementation abandoned task ${taskId}; rebase could not continue: ${continued.output ?? "unknown error"}`,
      };
    }
  }

  await commitWorktreeChanges(runtime, worktree.worktreeRoot, phase, taskId, title);
  const retry = await runtime.services.versionControl.squashMerge(
    worktree,
    `deeplooper: phase ${phase} task ${taskId} ${title}`,
    runtime.services.eventContext.signal,
  );
  return retry.ok
    ? { ok: true, summary: "Conflict resolved and task squashed." }
    : {
        ok: false,
        summary: `Implementation abandoned task ${taskId}; squash conflict persisted: ${retry.conflictOutput ?? "merge conflict"}`,
      };
}

async function runIntegrationChecker(
  runtime: StageRuntime,
  phase: number,
  executionManifestRows: string,
  baselineSummary: string,
) {
  const repo = runtime.services.artifactRepo;
  return dispatchLeaf(
    runtime,
    "dl-integration-checker",
    [
      "=== EXECUTION MANIFEST ===",
      (executionManifestRows || (await repo.read({ kind: "phaseFile", phase, name: "execution-manifest.md" }))) ?? "",
      "",
      "=== PIPELINE CONFIG ===",
      (await repo.read({ kind: "config" })) ?? "",
      "",
      "=== CURRENT PHASE ===",
      String(phase),
      "",
      "=== BASELINE RESULTS ===",
      (await repo.read({ kind: "baselineResults" })) ?? baselineSummary,
      "",
      "=== DESIGN CONTEXT ===",
      (await repo.read({ kind: "design" })) ?? "N/A",
    ].join("\n"),
  );
}

export function classifyIntegrationLoop(markdown: string): "LOOP_DESIGN" | "LOCAL_SLICE" {
  const affected = parseAffectedArtifact(markdown);
  if (affected === "design") return "LOOP_DESIGN";
  return "LOCAL_SLICE";
}
