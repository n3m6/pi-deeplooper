/**
 * StubChangesVersionControl — wraps any VersionControl and overrides
 * changedFiles / changedLineCount to always return [] / 0.
 *
 * Used during cassette recording and replay so that the code-review dispatch
 * key is stable regardless of the actual worktree state at key-computation time.
 * Without this, the recorded key diverges from the replay key whenever
 * git status returns different files between runs (e.g. recording used real git,
 * replay uses FakeVersionControl).
 */

import type { CheckpointResult, StageName, TaskWorktreeHandle, VersionControl } from "../../application/port/index.js";

export class StubChangesVersionControl implements VersionControl {
  constructor(private readonly inner: VersionControl) {}

  createRunBranch(runId: string, signal?: AbortSignal): Promise<void> {
    return this.inner.createRunBranch(runId, signal);
  }

  checkpoint(
    stage: StageName,
    action: "complete" | "skipped" | "failed" | "finalized",
    signal?: AbortSignal,
  ): Promise<CheckpointResult> {
    return this.inner.checkpoint(stage, action, signal);
  }

  resolveRepoRoot(signal?: AbortSignal): Promise<string> {
    return this.inner.resolveRepoRoot(signal);
  }

  prepareWorktree(phase: number, taskId: string, repoRoot: string, signal?: AbortSignal): Promise<TaskWorktreeHandle> {
    return this.inner.prepareWorktree(phase, taskId, repoRoot, signal);
  }

  squashMerge(
    worktree: TaskWorktreeHandle,
    commitMessage: string,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; conflictOutput?: string }> {
    return this.inner.squashMerge(worktree, commitMessage, signal);
  }

  rebaseWorktree(worktree: TaskWorktreeHandle, signal?: AbortSignal): Promise<{ ok: boolean; output?: string }> {
    return this.inner.rebaseWorktree(worktree, signal);
  }

  continueRebase(worktree: TaskWorktreeHandle, signal?: AbortSignal): Promise<{ ok: boolean; output?: string }> {
    return this.inner.continueRebase(worktree, signal);
  }

  commitWorktreeChanges(worktreeRoot: string, message: string, signal?: AbortSignal): Promise<void> {
    return this.inner.commitWorktreeChanges(worktreeRoot, message, signal);
  }

  changedFiles(_cwd: string, _signal?: AbortSignal): Promise<string[]> {
    return Promise.resolve([]);
  }

  changedLineCount(_cwd: string, _signal?: AbortSignal): Promise<number> {
    return Promise.resolve(0);
  }

  listWorkspaceFiles(cwd: string, signal?: AbortSignal): Promise<string[]> {
    return this.inner.listWorkspaceFiles(cwd, signal);
  }

  cleanupWorktree(worktree: TaskWorktreeHandle, signal?: AbortSignal): Promise<void> {
    return this.inner.cleanupWorktree(worktree, signal);
  }

  stage7RegressionReusable(signal?: AbortSignal): Promise<{ reusable: boolean; reason: string }> {
    return this.inner.stage7RegressionReusable(signal);
  }
}
