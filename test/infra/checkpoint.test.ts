import { test } from "node:test";
import assert from "node:assert/strict";

import { CheckpointManager } from "../../src/infra/git/version-control.js";

const RUN_ID = "dl-20260602-000000";

test("createRunBranch initializes an unborn repository with an empty run commit", async () => {
  const calls: string[][] = [];
  const checkpoint = new CheckpointManager(
    {
      async exec(_command, args) {
        calls.push(args);
        if (args[0] === "rev-parse" && args.includes("HEAD")) {
          return { stdout: "", stderr: "fatal: ambiguous argument HEAD", code: 1, killed: false };
        }
        return { stdout: "", stderr: "", code: 0, killed: false };
      },
    },
    "/repo",
    RUN_ID,
  );

  const result = await checkpoint.createRunBranch(RUN_ID);

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ["rev-parse", "--verify", "HEAD"],
    ["checkout", "--orphan", "deeplooper/dl-20260602-000000"],
    [
      "-c",
      "user.name=deeplooper",
      "-c",
      "user.email=deeplooper@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "deeplooper: initialize dl-20260602-000000",
    ],
  ]);
});

test("stageBoundaryCheckpoint commits pipeline artifacts even when no code changed", async () => {
  const calls: string[][] = [];
  const checkpoint = new CheckpointManager(
    {
      async exec(_command, args) {
        calls.push(args);
        if (args[0] === "diff" && args.includes("--name-only")) {
          return { stdout: ".pipeline/dl-20260602-000000/goals.md\n", stderr: "", code: 0, killed: false };
        }
        return { stdout: "", stderr: "", code: 0, killed: false };
      },
    },
    "/repo",
    RUN_ID,
  );

  const result = await checkpoint.stageBoundaryCheckpoint("goals", "complete");

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ["add", "-A", "--", ".", ":(exclude).pipeline", ":(exclude).pipeline/**"],
    ["add", "-A", "-f", "--", ".pipeline/dl-20260602-000000"],
    ["diff", "--cached", "--name-only"],
    [
      "-c",
      "user.name=deeplooper",
      "-c",
      "user.email=deeplooper@example.invalid",
      "commit",
      "-m",
      "deeplooper: stage goals complete",
    ],
  ]);
});

test("stageBoundaryCheckpoint stages non-pipeline changes together with artifacts", async () => {
  const calls: string[][] = [];
  const checkpoint = new CheckpointManager(
    {
      async exec(_command, args) {
        calls.push(args);
        if (args[0] === "diff" && args.includes("--name-only")) {
          return {
            stdout: "README.md\n.pipeline/dl-20260602-000000/goals.md\n",
            stderr: "",
            code: 0,
            killed: false,
          };
        }
        return { stdout: "", stderr: "", code: 0, killed: false };
      },
    },
    "/repo",
    RUN_ID,
  );

  const result = await checkpoint.stageBoundaryCheckpoint("goals", "complete");

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ["add", "-A", "--", ".", ":(exclude).pipeline", ":(exclude).pipeline/**"],
    ["add", "-A", "-f", "--", ".pipeline/dl-20260602-000000"],
    ["diff", "--cached", "--name-only"],
    [
      "-c",
      "user.name=deeplooper",
      "-c",
      "user.email=deeplooper@example.invalid",
      "commit",
      "-m",
      "deeplooper: stage goals complete",
    ],
  ]);
});

test("stageBoundaryCheckpoint returns nothing-to-checkpoint when diff is empty", async () => {
  const calls: string[][] = [];
  const checkpoint = new CheckpointManager(
    {
      async exec(_command, args) {
        calls.push(args);
        // diff --cached --name-only returns empty: nothing staged
        return { stdout: "", stderr: "", code: 0, killed: false };
      },
    },
    "/repo",
    RUN_ID,
  );

  const result = await checkpoint.stageBoundaryCheckpoint("goals", "complete");

  assert.equal(result.ok, true);
  assert.equal(result.warning, "nothing to checkpoint");
  assert.deepEqual(calls, [
    ["add", "-A", "--", ".", ":(exclude).pipeline", ":(exclude).pipeline/**"],
    ["add", "-A", "-f", "--", ".pipeline/dl-20260602-000000"],
    ["diff", "--cached", "--name-only"],
  ]);
});
