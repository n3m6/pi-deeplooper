import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { CheckpointResult, StageName, TaskWorktreeHandle, VersionControl } from "../../application/port/index.js";

// ---------------------------------------------------------------------------
// CheckpointManager — creates run branches and stage-boundary commits.
// ---------------------------------------------------------------------------

export interface GitOperationResult {
  ok: boolean;
  result?: ExecResult;
  warning?: string;
}

const CODE_CHECKPOINT_PATHS = [".", ":(exclude).pipeline", ":(exclude).pipeline/**"];

export class CheckpointManager {
  constructor(
    private readonly pi: Pick<ExtensionAPI, "exec">,
    private readonly workspaceRoot: string,
    private readonly runId: string,
  ) {}

  async createRunBranch(runId: string, signal?: AbortSignal): Promise<GitOperationResult> {
    const branch = `deeplooper/${runId}`;
    const existingHead = await this.execGit(["rev-parse", "--verify", "HEAD"], signal);
    if (!existingHead.ok) {
      const orphan = await this.execGit(["checkout", "--orphan", branch], signal);
      if (!orphan.ok) {
        return orphan;
      }
      return this.execGit(
        [...commitIdentityArgs(), "commit", "--allow-empty", "-m", `deeplooper: initialize ${runId}`],
        signal,
      );
    }

    const base = await this.execGit(["rev-parse", "--verify", "main"], signal);
    const targetBase = base.ok ? "main" : "HEAD";
    return this.execGit(["checkout", "-b", branch, targetBase], signal);
  }

  async stageBoundaryCheckpoint(
    stage: StageName,
    action: "complete" | "skipped" | "failed" | "finalized",
    signal?: AbortSignal,
  ): Promise<GitOperationResult> {
    // Stage code changes (excluding all .pipeline/ scratch).
    const addCode = await this.execGit(["add", "-A", "--", ...CODE_CHECKPOINT_PATHS], signal);
    if (!addCode.ok) {
      return addCode;
    }

    // Force-add the active run directory, overriding any .gitignore in the target repo.
    const runDir = `.pipeline/${this.runId}`;
    const addArtifacts = await this.execGit(["add", "-A", "-f", "--", runDir], signal);
    if (!addArtifacts.ok) {
      return addArtifacts;
    }

    // Only commit when something was actually staged.
    const diff = await this.execGit(["diff", "--cached", "--name-only"], signal);
    if (!diff.ok) {
      return diff;
    }
    if (!diff.result?.stdout.trim()) {
      return { ok: true, warning: "nothing to checkpoint" };
    }

    return this.execGit([...commitIdentityArgs(), "commit", "-m", `deeplooper: stage ${stage} ${action}`], signal);
  }

  async currentBranch(signal?: AbortSignal): Promise<string | undefined> {
    const result = await this.execGit(["branch", "--show-current"], signal);
    return result.ok ? result.result?.stdout.trim() || undefined : undefined;
  }

  async resolveRepoRoot(signal?: AbortSignal): Promise<string> {
    const result = await this.execGit(["rev-parse", "--show-toplevel"], signal);
    if (!result.ok || !result.result?.stdout.trim()) {
      return this.workspaceRoot;
    }
    return result.result.stdout.trim();
  }

  getWorktreeRootParent(repoRoot: string): string {
    return path.dirname(repoRoot);
  }

  private async execGit(args: string[], signal?: AbortSignal): Promise<GitOperationResult> {
    try {
      const result = await this.pi.exec("git", args, {
        cwd: this.workspaceRoot,
        timeout: 60_000,
        ...(signal ? { signal } : {}),
      });
      if (result.code !== 0) {
        return {
          ok: false,
          result,
          warning: result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`,
        };
      }
      return { ok: true, result };
    } catch (error) {
      return {
        ok: false,
        warning: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export function commitIdentityArgs(): string[] {
  return ["-c", "user.name=deeplooper", "-c", "user.email=deeplooper@example.invalid"];
}

export function phaseBranchName(runId: string, phase: number, taskId: string): string {
  return `dl-task/${runId}/phase-${String(phase).padStart(2, "0")}/${taskId}`;
}

export function worktreeRootPath(runId: string, repoRoot: string, phase: number, taskId: string): string {
  return path.join(
    path.dirname(repoRoot),
    ".deeplooper-worktrees",
    runId,
    `phase-${String(phase).padStart(2, "0")}`,
    taskId,
  );
}

// ---------------------------------------------------------------------------
// WorktreeManager — manages git worktrees for parallel task execution.
// ---------------------------------------------------------------------------

export interface TaskWorktree {
  branch: string;
  worktreeRoot: string;
  taskId: string;
  phase: number;
}

export class WorktreeManager {
  constructor(
    private readonly pi: Pick<ExtensionAPI, "exec">,
    private readonly workspaceRoot: string,
    private readonly repoRoot: string,
    private readonly runId: string,
  ) {}

  async prepare(phase: number, taskId: string, signal?: AbortSignal): Promise<TaskWorktree> {
    const branch = phaseBranchName(this.runId, phase, taskId);
    const worktreeRoot = worktreeRootPath(this.runId, this.repoRoot, phase, taskId);
    await mkdir(path.dirname(worktreeRoot), { recursive: true });
    await this.cleanup({ branch, worktreeRoot, taskId, phase }, signal);
    await this.ensureRunBranch(signal);
    await this.exec(["worktree", "add", "-b", branch, worktreeRoot, `deeplooper/${this.runId}`], signal);
    return { branch, worktreeRoot, taskId, phase };
  }

  async cleanup(worktree: TaskWorktree, signal?: AbortSignal): Promise<void> {
    await this.exec(["worktree", "remove", "--force", worktree.worktreeRoot], signal, true);
    await this.exec(["branch", "-D", worktree.branch], signal, true);
  }

  async squashMerge(
    worktree: TaskWorktree,
    commitMessage: string,
    signal?: AbortSignal,
  ): Promise<{
    ok: boolean;
    conflictOutput?: string;
  }> {
    const merge = await this.exec(["merge", "--squash", worktree.branch], signal, true);
    if (merge.code !== 0) {
      await this.exec(["merge", "--abort"], signal, true);
      await this.exec(["reset", "--merge"], signal, true);
      return {
        ok: false,
        conflictOutput: [merge.stdout, merge.stderr].filter(Boolean).join("\n"),
      };
    }

    const staged = await this.exec(["diff", "--cached", "--quiet"], signal, true);
    if (staged.code === 0) {
      await this.cleanup(worktree, signal);
      return { ok: true };
    }

    await this.exec([...commitIdentityArgs(), "commit", "-m", commitMessage], signal);
    await this.cleanup(worktree, signal);
    return { ok: true };
  }

  async listChangedFiles(worktree: TaskWorktree, signal?: AbortSignal): Promise<string[]> {
    const diff = await this.exec(["-C", worktree.worktreeRoot, "status", "--short"], signal);
    return diff.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.slice(3));
  }

  async rebaseOnRunBranch(worktree: TaskWorktree, signal?: AbortSignal): Promise<{ ok: boolean; output?: string }> {
    const rebase = await this.exec(["-C", worktree.worktreeRoot, "rebase", `deeplooper/${this.runId}`], signal, true);
    return {
      ok: rebase.code === 0,
      output: [rebase.stdout, rebase.stderr].filter(Boolean).join("\n"),
    };
  }

  async continueRebase(worktree: TaskWorktree, signal?: AbortSignal): Promise<{ ok: boolean; output?: string }> {
    const add = await this.exec(["-C", worktree.worktreeRoot, "add", "-A"], signal, true);
    if (add.code !== 0) {
      return { ok: false, output: [add.stdout, add.stderr].filter(Boolean).join("\n") };
    }
    const rebase = await this.exec(
      ["-C", worktree.worktreeRoot, "-c", "core.editor=true", "rebase", "--continue"],
      signal,
      true,
    );
    return {
      ok: rebase.code === 0,
      output: [rebase.stdout, rebase.stderr].filter(Boolean).join("\n"),
    };
  }

  private async exec(args: string[], signal?: AbortSignal, tolerateFailure = false) {
    const result = await this.pi.exec("git", args, {
      cwd: this.workspaceRoot,
      timeout: 60_000,
      ...(signal ? { signal } : {}),
    });
    if (!tolerateFailure && result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
    }
    return result;
  }

  private async ensureRunBranch(signal?: AbortSignal): Promise<void> {
    const runBranch = `deeplooper/${this.runId}`;
    const existing = await this.exec(["rev-parse", "--verify", runBranch], signal, true);
    if (existing.code === 0) {
      return;
    }
    const head = await this.exec(["rev-parse", "--verify", "HEAD"], signal, true);
    if (head.code !== 0) {
      const orphan = await this.exec(["checkout", "--orphan", runBranch], signal, true);
      if (orphan.code !== 0) {
        throw new Error(orphan.stderr.trim() || orphan.stdout.trim() || `git checkout --orphan ${runBranch} failed`);
      }
      await this.exec(
        [...commitIdentityArgs(), "commit", "--allow-empty", "-m", `deeplooper: initialize ${this.runId}`],
        signal,
      );
      return;
    }
    await this.exec(["branch", runBranch, "HEAD"], signal);
  }
}

// ---------------------------------------------------------------------------
// GitVersionControl — implements the VersionControl port.
// ---------------------------------------------------------------------------

export class GitVersionControl implements VersionControl {
  private readonly checkpointMgr: CheckpointManager;

  constructor(
    private readonly pi: Pick<ExtensionAPI, "exec">,
    private readonly workspaceRoot: string,
    private readonly runId: string,
  ) {
    this.checkpointMgr = new CheckpointManager(pi, workspaceRoot, runId);
  }

  async createRunBranch(runId: string, signal?: AbortSignal): Promise<void> {
    await this.checkpointMgr.createRunBranch(runId, signal);
  }

  async checkpoint(
    stage: StageName,
    action: "complete" | "skipped" | "failed" | "finalized",
    signal?: AbortSignal,
  ): Promise<CheckpointResult> {
    const result = await this.checkpointMgr.stageBoundaryCheckpoint(stage, action, signal);
    if (!result.ok) {
      return result.warning !== undefined ? { ok: false, warning: result.warning } : { ok: false };
    }
    if (result.warning === "nothing to checkpoint") {
      return { ok: true, skipped: true, warning: result.warning };
    }
    return { ok: true };
  }

  async resolveRepoRoot(signal?: AbortSignal): Promise<string> {
    return this.checkpointMgr.resolveRepoRoot(signal);
  }

  async prepareWorktree(
    phase: number,
    taskId: string,
    repoRoot: string,
    signal?: AbortSignal,
  ): Promise<TaskWorktreeHandle> {
    const mgr = this.buildWorktreeManager(repoRoot);
    const worktree = await mgr.prepare(phase, taskId, signal);
    return {
      branch: worktree.branch,
      worktreeRoot: worktree.worktreeRoot,
      taskId: worktree.taskId,
      phase: worktree.phase,
    };
  }

  async squashMerge(
    worktree: TaskWorktreeHandle,
    commitMessage: string,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; conflictOutput?: string }> {
    const mgr = this.buildWorktreeManager(this.workspaceRoot);
    return mgr.squashMerge(worktree, commitMessage, signal);
  }

  async rebaseWorktree(worktree: TaskWorktreeHandle, signal?: AbortSignal): Promise<{ ok: boolean; output?: string }> {
    const mgr = this.buildWorktreeManager(this.workspaceRoot);
    return mgr.rebaseOnRunBranch(worktree, signal);
  }

  async continueRebase(worktree: TaskWorktreeHandle, signal?: AbortSignal): Promise<{ ok: boolean; output?: string }> {
    const mgr = this.buildWorktreeManager(this.workspaceRoot);
    return mgr.continueRebase(worktree, signal);
  }

  async commitWorktreeChanges(worktreeRoot: string, message: string, signal?: AbortSignal): Promise<void> {
    const opts = { cwd: worktreeRoot, timeout: 60_000, ...(signal ? { signal } : {}) };
    const add = await this.pi.exec("git", ["add", "-A"], opts);
    if (add.code !== 0) {
      throw new Error(add.stderr.trim() || add.stdout.trim() || "git add -A failed");
    }
    const commit = await this.pi.exec(
      "git",
      ["-c", "user.name=deeplooper", "-c", "user.email=deeplooper@example.invalid", "commit", "-m", message],
      opts,
    );
    if (commit.code !== 0) {
      throw new Error(commit.stderr.trim() || commit.stdout.trim() || "git commit failed");
    }
  }

  async changedFiles(cwd: string, signal?: AbortSignal): Promise<string[]> {
    const result = await this.pi.exec("git", ["status", "--short"], {
      cwd,
      timeout: 60_000,
      ...(signal ? { signal } : {}),
    });
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
  }

  async changedLineCount(cwd: string, signal?: AbortSignal): Promise<number> {
    const result = await this.pi.exec("git", ["diff", "--shortstat", "HEAD"], {
      cwd,
      timeout: 60_000,
      ...(signal ? { signal } : {}),
    });
    const insertions = Number.parseInt(result.stdout.match(/(\d+)\s+insertion/)?.[1] ?? "0", 10);
    const deletions = Number.parseInt(result.stdout.match(/(\d+)\s+deletion/)?.[1] ?? "0", 10);
    return insertions + deletions;
  }

  async listWorkspaceFiles(cwd: string, signal?: AbortSignal): Promise<string[]> {
    const result = await this.pi.exec("git", ["ls-files"], {
      cwd,
      timeout: 60_000,
      ...(signal ? { signal } : {}),
    });
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async cleanupWorktree(worktree: TaskWorktreeHandle, signal?: AbortSignal): Promise<void> {
    const mgr = this.buildWorktreeManager(this.workspaceRoot);
    await mgr.cleanup(worktree, signal);
  }

  async stage7RegressionReusable(signal?: AbortSignal): Promise<{ reusable: boolean; reason: string }> {
    const opts = { cwd: this.workspaceRoot, timeout: 30_000, ...(signal ? { signal } : {}) };

    // Find the last squash-merge commit produced by implement.ts.
    // Pattern: "deeplooper: phase <N> task …"
    const hashResult = await this.pi.exec("git", ["log", "-1", "--format=%H", "--grep=^deeplooper: phase"], opts);

    if (hashResult.code !== 0 || !hashResult.stdout.trim()) {
      return { reusable: false, reason: "no-phase-commit: no deeplooper phase commit found; running full suite" };
    }

    const hash = hashResult.stdout.trim();

    // Check whether any production source changed between that commit and HEAD,
    // excluding test files and pipeline scratch.
    const diffResult = await this.pi.exec(
      "git",
      [
        "log",
        "--oneline",
        `${hash}..HEAD`,
        "--",
        ".",
        ":(exclude)*.test.*",
        ":(exclude)*.spec.*",
        ":(exclude)**/test/**",
        ":(exclude)**/tests/**",
        ":(exclude)**/__tests__/**",
        ":(exclude).pipeline/**",
      ],
      opts,
    );

    if (diffResult.code !== 0) {
      return { reusable: false, reason: "diff-error: could not determine production changes; running full suite" };
    }

    if (diffResult.stdout.trim()) {
      return { reusable: false, reason: "production-changes: production source changed since Stage-7 commit" };
    }

    return { reusable: true, reason: `reuse-ok: no production changes since ${hash.slice(0, 8)}` };
  }

  private buildWorktreeManager(repoRoot: string): WorktreeManager {
    return new WorktreeManager(this.pi, this.workspaceRoot, repoRoot, this.runId);
  }
}
