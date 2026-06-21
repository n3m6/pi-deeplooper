import type { ArtifactId, StageOutcome, StageRuntime } from "../port/index.js";
import { dispatchGenericCoding, readArtifact } from "./utils.js";
import { renderAcceptanceRepairContext } from "./acceptance-feedback.js";

export async function runFastImplCodeSubstage(
  runtime: StageRuntime,
  options: {
    taskId: string;
    worktreeRoot: string;
    taskSpecId: ArtifactId;
    attempt: number;
    /** Corrective guidance from the previous attempt's verify failure, or from an outer review loop. */
    repairGuidance?: string;
  },
): Promise<StageOutcome> {
  const taskSpec = await readArtifact(runtime, options.taskSpecId);
  const acceptanceRepairContext = await renderAcceptanceRepairContext(runtime);
  return dispatchGenericCoding(
    runtime,
    [
      "Implement the production-code portion of this task in the provided worktree.",
      "Do not edit test files in this step.",
      "Keep the implementation minimal and constrained to the task spec.",
      "All file operations must stay inside the provided worktree. If the task spec contains an absolute path to the original workspace, treat it as a repository-relative path under this worktree instead.",
      `Task: ${options.taskId}`,
      `Attempt: ${options.attempt}`,
      `Worktree root: ${options.worktreeRoot}`,
      acceptanceRepairContext,
      ...(options.repairGuidance ? ["", "=== REPAIR GUIDANCE FROM PREVIOUS ATTEMPT ===", options.repairGuidance] : []),
      "",
      taskSpec,
      "",
      "Run any targeted verification you need before returning. Call stage_return with PASS or FAIL, filesWritten, and a concise summary.",
    ].join("\n"),
    { cwd: options.worktreeRoot },
  );
}
