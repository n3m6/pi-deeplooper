import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WorktreeManager, type TaskWorktree } from "../../src/infra/git/version-control.js";

test("prepare creates missing run branch from HEAD before adding task worktree", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-deeplooper-worktree-"));
  const calls: string[][] = [];
  const manager = new WorktreeManager(
    {
      async exec(_command, args) {
        calls.push(args);
        if (args[0] === "rev-parse" && args[2] === "deeplooper/dl-20260601-040000") {
          return { stdout: "", stderr: "missing branch", code: 1, killed: false };
        }
        return { stdout: "ok", stderr: "", code: 0, killed: false };
      },
    },
    workspace,
    workspace,
    "dl-20260601-040000",
  );

  await manager.prepare(1, "01");

  assert.deepEqual(calls.slice(2, 5), [
    ["rev-parse", "--verify", "deeplooper/dl-20260601-040000"],
    ["rev-parse", "--verify", "HEAD"],
    ["branch", "deeplooper/dl-20260601-040000", "HEAD"],
  ]);
  assert.deepEqual(calls.at(-1), [
    "worktree",
    "add",
    "-b",
    "dl-task/dl-20260601-040000/phase-01/01",
    path.join(path.dirname(workspace), ".deeplooper-worktrees", "dl-20260601-040000", "phase-01", "01"),
    "deeplooper/dl-20260601-040000",
  ]);
});

test("squashMerge aborts and reports conflicts without cleanup", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-deeplooper-worktree-"));
  const calls: string[][] = [];
  const manager = new WorktreeManager(
    {
      async exec(_command, args) {
        calls.push(args);
        if (args[0] === "merge" && args[1] === "--squash") {
          return { stdout: "", stderr: "conflict", code: 1, killed: false };
        }
        return { stdout: "", stderr: "", code: 0, killed: false };
      },
    },
    workspace,
    workspace,
    "dl-20260601-050000",
  );
  const worktree: TaskWorktree = {
    branch: "task-branch",
    worktreeRoot: path.join(workspace, "task"),
    taskId: "01",
    phase: 1,
  };

  const result = await manager.squashMerge(worktree, "merge task");

  assert.equal(result.ok, false);
  assert.match(result.conflictOutput ?? "", /conflict/);
  assert.deepEqual(calls.slice(0, 3), [
    ["merge", "--squash", "task-branch"],
    ["merge", "--abort"],
    ["reset", "--merge"],
  ]);
});

test("squashMerge skips commit when only unstaged scratch files are dirty", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-deeplooper-worktree-"));
  const calls: string[][] = [];
  const manager = new WorktreeManager(
    {
      async exec(_command, args) {
        calls.push(args);
        if (args[0] === "diff" && args.includes("--cached")) {
          return { stdout: "", stderr: "", code: 0, killed: false };
        }
        if (args[0] === "status") {
          return { stdout: " M .pipeline/run/state.json", stderr: "", code: 0, killed: false };
        }
        return { stdout: "", stderr: "", code: 0, killed: false };
      },
    },
    workspace,
    workspace,
    "dl-20260601-055000",
  );
  const worktree: TaskWorktree = {
    branch: "task-branch",
    worktreeRoot: path.join(workspace, "task"),
    taskId: "01",
    phase: 1,
  };

  const result = await manager.squashMerge(worktree, "merge task");

  assert.equal(result.ok, true);
  assert.deepEqual(calls.slice(0, 4), [
    ["merge", "--squash", "task-branch"],
    ["diff", "--cached", "--quiet"],
    ["worktree", "remove", "--force", worktree.worktreeRoot],
    ["branch", "-D", worktree.branch],
  ]);
  assert.equal(
    calls.some((args) => args.includes("commit")),
    false,
  );
  assert.equal(
    calls.some((args) => args[0] === "status"),
    false,
  );
});

test("worktree rebase helpers report continue failures for abandon path", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-deeplooper-worktree-"));
  const manager = new WorktreeManager(
    {
      async exec(_command, args) {
        if (args.includes("--continue")) {
          return { stdout: "", stderr: "still conflicted", code: 1, killed: false };
        }
        return { stdout: "", stderr: "", code: 0, killed: false };
      },
    },
    workspace,
    workspace,
    "dl-20260601-060000",
  );
  const worktree: TaskWorktree = {
    branch: "task-branch",
    worktreeRoot: path.join(workspace, "task"),
    taskId: "01",
    phase: 1,
  };

  const result = await manager.continueRebase(worktree);

  assert.equal(result.ok, false);
  assert.match(result.output ?? "", /still conflicted/);
});
