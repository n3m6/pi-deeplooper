/**
 * FakeVersionControl — in-memory stub for pure-mode replay.
 *
 * All 12 VersionControl port methods are no-ops or return safe defaults so that
 * pure-mode replay can run the full pipeline without any git I/O.
 *
 * prepareWorktree mirrors the worktreeRootPath formula from version-control.ts
 * (siblings of repoRoot, not children) so that the dispatch-key path normaliser
 * resolves the same placeholder for both record and replay runs.
 */

import path from "node:path";

import type { CheckpointResult, StageName, TaskWorktreeHandle, VersionControl } from "../../application/port/index.js";

export class FakeVersionControl implements VersionControl {
  constructor(
    private readonly workspaceRoot: string,
    private readonly runId: string,
  ) {}

  createRunBranch(_runId: string, _signal?: AbortSignal): Promise<void> {
    return Promise.resolve();
  }

  checkpoint(
    _stage: StageName,
    _action: "complete" | "skipped" | "failed" | "finalized",
    _signal?: AbortSignal,
  ): Promise<CheckpointResult> {
    return Promise.resolve({ ok: true, skipped: true });
  }

  resolveRepoRoot(_signal?: AbortSignal): Promise<string> {
    return Promise.resolve(this.workspaceRoot);
  }

  prepareWorktree(phase: number, taskId: string, repoRoot: string, _signal?: AbortSignal): Promise<TaskWorktreeHandle> {
    // Mirror worktreeRootPath: siblings of repoRoot under .deeplooper-worktrees/<runId>
    const worktreeRoot = path.join(
      path.dirname(repoRoot),
      ".deeplooper-worktrees",
      this.runId,
      `phase-${String(phase).padStart(2, "0")}`,
      taskId,
    );
    const branch = `dl-task/${this.runId}/phase-${String(phase).padStart(2, "0")}/${taskId}`;
    return Promise.resolve({ branch, worktreeRoot, taskId, phase });
  }

  squashMerge(
    _worktree: TaskWorktreeHandle,
    _commitMessage: string,
    _signal?: AbortSignal,
  ): Promise<{ ok: boolean; conflictOutput?: string }> {
    return Promise.resolve({ ok: true });
  }

  rebaseWorktree(_worktree: TaskWorktreeHandle, _signal?: AbortSignal): Promise<{ ok: boolean; output?: string }> {
    return Promise.resolve({ ok: true });
  }

  continueRebase(_worktree: TaskWorktreeHandle, _signal?: AbortSignal): Promise<{ ok: boolean; output?: string }> {
    return Promise.resolve({ ok: true });
  }

  commitWorktreeChanges(_worktreeRoot: string, _message: string, _signal?: AbortSignal): Promise<void> {
    return Promise.resolve();
  }

  changedFiles(_cwd: string, _signal?: AbortSignal): Promise<string[]> {
    return Promise.resolve([]);
  }

  changedLineCount(_cwd: string, _signal?: AbortSignal): Promise<number> {
    return Promise.resolve(0);
  }

  listWorkspaceFiles(_cwd: string, _signal?: AbortSignal): Promise<string[]> {
    return Promise.resolve([]);
  }

  cleanupWorktree(_worktree: TaskWorktreeHandle, _signal?: AbortSignal): Promise<void> {
    return Promise.resolve();
  }

  stage7RegressionReusable(_signal?: AbortSignal): Promise<{ reusable: boolean; reason: string }> {
    // Mirrors the real implementation's no-phase-commit reason so the verifier prompt hashes
    // identically between recording (empty git repo) and pure-mode replay.
    return Promise.resolve({
      reusable: false,
      reason: "no-phase-commit: no deeplooper phase commit found; running full suite",
    });
  }
}
