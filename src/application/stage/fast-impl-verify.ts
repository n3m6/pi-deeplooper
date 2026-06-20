import type { ArtifactId, StageOutcome, StageRuntime } from "../port/index.js";
import { dispatchGenericCoding, readArtifact } from "./utils.js";
import { runCodeReviewSubstage } from "./code-review.js";

export async function runFastImplVerifySubstage(
  runtime: StageRuntime,
  options: {
    taskId: string;
    worktreeRoot: string;
    taskSpecId: ArtifactId;
    attempt: number;
  },
): Promise<StageOutcome> {
  const taskSpec = await readArtifact(runtime, options.taskSpecId);
  const verification = await dispatchGenericCoding(
    runtime,
    [
      "Run targeted verification for the task implementation in this worktree.",
      "Do not edit files in this step.",
      "Run the smallest meaningful set of checks to validate the task and report the outcome.",
      `Task: ${options.taskId}`,
      `Attempt: ${options.attempt}`,
      `Worktree root: ${options.worktreeRoot}`,
      "",
      taskSpec,
    ].join("\n"),
    { cwd: options.worktreeRoot, tools: ["read", "bash", "grep", "find", "ls"] },
  );

  if (verification.status !== "PASS") {
    return verification;
  }

  const review = await runCodeReviewSubstage(runtime, options);
  if (review.status !== "PASS") {
    return {
      status: "FAIL",
      filesWritten: review.filesWritten,
      summary: `Verification passed but code review found blocking issues: ${review.summary}`,
      ...(review.telemetry ? { telemetry: review.telemetry } : {}),
    };
  }

  return {
    status: "PASS",
    filesWritten: review.filesWritten,
    summary: "Verification and code review passed.",
    telemetry: {
      ...verification.telemetry,
      ...review.telemetry,
    },
  };
}
