import { selectReviewers } from "../../domain/stage/reviewer-selection-policy.js";
import type { ArtifactId, DispatchRequest, StageOutcome, StageRuntime, VersionControl } from "../port/index.js";
import { artifactRelPath, parseReviewStatus, readArtifact, subStageContext, writeArtifact } from "./utils.js";

export async function runCodeReviewSubstage(
  runtime: StageRuntime,
  options: {
    taskId: string;
    worktreeRoot: string;
    taskSpecId: ArtifactId;
  },
): Promise<StageOutcome> {
  const taskSpec = await readArtifact(runtime, options.taskSpecId);
  const changedFiles = await listChangedFiles(runtime, options.worktreeRoot);
  const changedLineCount = await countChangedLines(runtime, options.worktreeRoot);
  const reviewers = selectReviewers(runtime.state.route, changedFiles, changedLineCount);
  const requests: DispatchRequest[] = reviewers.map((reviewer) => {
    const target = runtime.services.agentDefinitions.get(reviewer.agentName);
    if (!target) {
      throw new Error(`Missing leaf agent definition: ${reviewer.agentName}`);
    }
    return {
      target,
      prompt: buildReviewPrompt(options.taskId, options.worktreeRoot, taskSpec, changedFiles, changedLineCount),
      cwd: options.worktreeRoot,
      tools: ["read", "bash", "grep", "find", "ls"],
      ...(runtime.services.eventContext.signal ? { signal: runtime.services.eventContext.signal } : {}),
    };
  });

  const ctx = subStageContext(runtime);
  for (const reviewer of reviewers) {
    await runtime.services.telemetrySink.record({
      type: "dispatch.started",
      ...ctx,
      childAgent: reviewer.agentName,
      taskId: options.taskId,
    });
  }
  const results = await runtime.services.dispatcher.dispatchParallel(requests);
  for (const [index, result] of results.entries()) {
    const reviewer = reviewers[index];
    if (reviewer) {
      await runtime.services.telemetrySink.record({
        type: "dispatch.completed",
        ...ctx,
        childAgent: reviewer.agentName,
        taskId: options.taskId,
        status: result.errorMessage ? "FAIL" : "PASS",
      });
    }
  }
  const filesWritten: string[] = [];
  const blockingFailures: string[] = [];
  const summaries: string[] = [];

  for (const [index, result] of results.entries()) {
    const reviewer = reviewers[index];
    if (!reviewer) {
      continue;
    }
    const reviewId: ArtifactId = {
      kind: "reviewFile",
      name: `code-review-task-${options.taskId}-${reviewer.agentName.replace(/^dl-/, "")}.md`,
    };
    await writeArtifact(runtime, reviewId, result.text);
    filesWritten.push(artifactRelPath(runtime, reviewId));
    const status = parseReviewStatus(result.text);
    const blockingSeverity = hasBlockingSeverity(result.text);
    const nonBlockingFailure = status === "FAIL" && !reviewer.advisory && !blockingSeverity;
    summaries.push(
      `${reviewer.agentName}: ${status}${reviewer.advisory ? " (advisory)" : ""}${nonBlockingFailure ? " (non-blocking severity)" : ""}`,
    );
    if (status === "FAIL" && !reviewer.advisory && blockingSeverity) {
      blockingFailures.push(reviewer.agentName);
    }
  }

  return {
    status: blockingFailures.length > 0 ? "FAIL" : "PASS",
    filesWritten,
    summary:
      blockingFailures.length > 0
        ? `Blocking code reviewers failed: ${blockingFailures.join(", ")}.`
        : "Code-review fanout passed.",
    telemetry: {
      child_agent_calls: Object.fromEntries(reviewers.map((reviewer) => [reviewer.agentName, 1])),
      review_rounds: 1,
      review_type: "code-review",
      review_status_summary: summaries.join("; "),
    },
  };
}

function hasBlockingSeverity(markdown: string): boolean {
  return /(?:^|\|)\s*(?:CRITICAL|HIGH)\s*(?=\||\b)/im.test(markdown);
}

function buildReviewPrompt(
  taskId: string,
  worktreeRoot: string,
  taskSpec: string,
  changedFiles: string[],
  changedLineCount: number,
): string {
  return [
    "Review the current task worktree for implementation issues.",
    "You are read-only for this review pass: do not edit files.",
    "Review against the task spec and observable behavior, not hypothetical improvements.",
    "",
    `Task: ${taskId}`,
    `Worktree root: ${worktreeRoot}`,
    `Changed line count: ${changedLineCount}`,
    "",
    "Changed files:",
    changedFiles.length > 0 ? changedFiles.map((file) => `- ${file}`).join("\n") : "None detected.",
    "",
    "Task spec:",
    taskSpec,
  ].join("\n");
}

function requireVersionControl(runtime: StageRuntime): VersionControl {
  if (!runtime.services.versionControl) {
    throw new Error("VersionControl port is not wired; ensure the composition root initialises it.");
  }
  return runtime.services.versionControl;
}

async function listChangedFiles(runtime: StageRuntime, worktreeRoot: string): Promise<string[]> {
  return requireVersionControl(runtime).changedFiles(worktreeRoot, runtime.services.eventContext.signal);
}

async function countChangedLines(runtime: StageRuntime, worktreeRoot: string): Promise<number> {
  return requireVersionControl(runtime).changedLineCount(worktreeRoot, runtime.services.eventContext.signal);
}
