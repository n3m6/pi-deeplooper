import {
  extractFixGuidance,
  parseMarkdownSections,
  parseReviewStatus,
  requireMarkdownSection,
} from "../../infra/codec/markdown-codec.js";
import type {
  ArtifactId,
  DispatchRequest,
  DispatchResult,
  GateRoundDetail,
  StageOutcome,
  StageRuntime,
  StageName,
  StageTelemetryContext,
  Route,
} from "../port/index.js";

export const GENERIC_CODING_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

export async function dispatchLeaf(
  runtime: StageRuntime,
  agentName: string,
  prompt: string,
  options?: {
    cwd?: string;
    tools?: string[];
    customTools?: DispatchRequest["customTools"];
    timeoutMs?: number;
    taskId?: string;
  },
): Promise<DispatchResult> {
  const target = runtime.services.agentDefinitions.get(agentName);
  if (!target) {
    throw new Error(`Missing leaf agent definition: ${agentName}`);
  }
  const ctx = subStageContext(runtime);
  await runtime.services.telemetrySink.record({
    type: "dispatch.started",
    ...ctx,
    childAgent: agentName,
    ...(options?.taskId !== undefined ? { taskId: options.taskId } : {}),
  });
  const correlationId = options?.taskId !== undefined ? `${options.taskId}-${agentName}` : agentName;
  const result = await runtime.services.dispatcher.dispatch({
    target,
    prompt,
    cwd: options?.cwd ?? runtime.workspaceRoot,
    ...(runtime.services.eventContext.signal ? { signal: runtime.services.eventContext.signal } : {}),
    tools: options?.tools ?? readOnlyTools(target.tools),
    ...(options?.customTools ? { customTools: options.customTools } : {}),
    ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    correlationId,
    activityLabel: options?.taskId !== undefined ? `${options.taskId}/${agentName}` : agentName,
  });
  await runtime.services.telemetrySink.record({
    type: "dispatch.completed",
    ...ctx,
    childAgent: agentName,
    ...(options?.taskId !== undefined ? { taskId: options.taskId } : {}),
    ...(result.endReason !== undefined ? { endReason: result.endReason } : {}),
    status:
      result.errorMessage ||
      result.endReason === "aborted" ||
      result.endReason === "max_turns" ||
      result.endReason === "timeout" ||
      result.endReason === "session_error"
        ? "FAIL"
        : "PASS",
  });
  return result;
}

export async function dispatchGenericCoding(
  runtime: StageRuntime,
  prompt: string,
  options?: {
    cwd?: string;
    tools?: string[];
    taskId?: string;
  },
): Promise<StageOutcome> {
  const ctx = subStageContext(runtime);
  await runtime.services.telemetrySink.record({
    type: "dispatch.started",
    ...ctx,
    childAgent: "generic-coding",
    ...(options?.taskId !== undefined ? { taskId: options.taskId } : {}),
  });
  const genericLabel = options?.taskId !== undefined ? `${options.taskId}/generic` : "generic";
  const outcome = await runtime.services.dispatcher.dispatchGenericCoding(prompt, {
    cwd: options?.cwd ?? runtime.workspaceRoot,
    ...(options?.tools ? { tools: options.tools } : {}),
    ...(runtime.services.eventContext.signal ? { signal: runtime.services.eventContext.signal } : {}),
    correlationId: genericLabel,
    activityLabel: genericLabel,
  });
  await runtime.services.telemetrySink.record({
    type: "dispatch.completed",
    ...ctx,
    childAgent: "generic-coding",
    ...(options?.taskId !== undefined ? { taskId: options.taskId } : {}),
    status: outcome.status === "FAIL" ? "FAIL" : outcome.status === "PARTIAL" ? "PARTIAL" : "PASS",
  });
  return outcome;
}

/** Write a pipeline artifact via the artifact repository. */
export async function writeArtifact(runtime: StageRuntime, id: ArtifactId, content: string): Promise<void> {
  await runtime.services.artifactRepo.write(id, content);
}

/**
 * Append a reflector-returned `### Lessons` / `### Spec History` block to an existing
 * artifact. `dl-reflector` is a read-only leaf, so the controller persists its output.
 * No-op when the block is empty or the sentinel "None.".
 */
export async function appendReflectorSection(
  runtime: StageRuntime,
  id: ArtifactId,
  block: string | undefined,
): Promise<boolean> {
  const trimmed = block?.trim();
  if (!trimmed || trimmed === "None.") {
    return false;
  }
  const existing = await safeReadArtifact(runtime, id);
  const updated = existing ? `${existing}\n\n${trimmed}` : trimmed;
  await writeArtifact(runtime, id, updated);
  return true;
}

/** Convenience wrapper: append a reflector `### Lessons` block to lessons.md. */
export async function appendReflectorLessons(runtime: StageRuntime, block: string | undefined): Promise<boolean> {
  return appendReflectorSection(runtime, { kind: "lessons" }, block);
}

/** Read a pipeline artifact; throws if the artifact does not exist. */
export async function readArtifact(runtime: StageRuntime, id: ArtifactId): Promise<string> {
  const content = await runtime.services.artifactRepo.read(id);
  if (content === undefined) {
    throw new Error(`Artifact not found: ${JSON.stringify(id)}`);
  }
  return content;
}

/**
 * Read a pipeline artifact, returning `fallback` (default `""`) if it does not exist.
 * Use for optional context artifacts where absence is expected.
 */
export async function safeReadArtifact(runtime: StageRuntime, id: ArtifactId, fallback = ""): Promise<string> {
  return (await runtime.services.artifactRepo.read(id)) ?? fallback;
}

/**
 * Return the path of an artifact relative to the run directory.
 * Used to populate `filesWritten` in `StageOutcome`.
 */
export function artifactRelPath(runtime: StageRuntime, id: ArtifactId): string {
  return runtime.services.artifactRepo.relPath(id);
}

export { requireMarkdownSection };

export function dispatchFailureSummary(result: DispatchResult, label: string): string | undefined {
  if (result.errorMessage) {
    return `${label}: ${result.errorMessage}`;
  }
  switch (result.endReason) {
    case "aborted":
      return `${label}: dispatched session was aborted.`;
    case "max_turns":
      return `${label}: dispatched session exhausted its turn budget.`;
    case "timeout":
      return `${label}: dispatched session timed out before producing output.`;
    case "session_error":
      return `${label}: dispatched session errored before producing output.`;
    default:
      return undefined;
  }
}

export { parseReviewStatus, extractFixGuidance, parseMarkdownSections };

/**
 * Emit a pipeline.anomaly event for a silent degradation that would otherwise leave
 * no trace in telemetry (e.g. empty parse results, vacuous done-checks, no-progress loops).
 *
 * Stable codes: design-slices-unparsed, slice-no-evidence, done-check-vacuous,
 * slice-plan-empty, backward-loop-no-progress, skeleton-scaffold-missing,
 * research-no-evidence, review-loop-no-progress.
 */
export async function recordAnomaly(
  runtime: StageRuntime,
  code: string,
  severity: "info" | "warning" | "error",
  summary: string,
  context?: Record<string, unknown>,
): Promise<void> {
  await runtime.services.telemetrySink.record({
    type: "pipeline.anomaly",
    code,
    severity,
    route: runtime.state.route,
    ...(runtime.currentStage !== undefined ? { stage: runtime.currentStage } : {}),
    summary,
    ...(context !== undefined ? { context } : {}),
  });
}

/**
 * Returns true for dispatch failures that are safe to retry (transient infrastructure issues).
 * `timeout` and `session_error` are transient; `aborted` and `max_turns` are not.
 */
export function isTransientDispatchFailure(result: DispatchResult): boolean {
  return result.endReason === "timeout" || result.endReason === "session_error";
}

export function readOnlyTools(tools: string[]): string[] {
  return tools.filter((tool) => tool !== "write" && tool !== "edit");
}

/** Returns the elapsed time in whole seconds between two ISO-8601 timestamps (clamped to ≥ 0). */
export function secondsBetween(start: string, end: string): number {
  return Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000));
}

/**
 * Builds the minimal sub-stage context fields shared across progress events
 * emitted from within stage/workflow code (route and the active stage when available).
 */
export function subStageContext(runtime: StageRuntime): {
  route: Route;
  stage?: StageName;
} {
  const ctx: { route: Route; stage?: StageName } = {
    route: runtime.state.route,
  };
  if (runtime.currentStage !== undefined) {
    ctx.stage = runtime.currentStage;
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Gate telemetry builders — produce the StageTelemetryContext gate sub-object
// ---------------------------------------------------------------------------

/** Telemetry for stages where no human gate was presented (review cap, dispatch fail, early exit). */
export function gateNoneTelemetry(reviewRounds: number, terminal?: "unclean-cap"): StageTelemetryContext {
  return {
    review_rounds: reviewRounds,
    ...(terminal ? { terminal_review_state: terminal } : {}),
    gate_status: "none",
    gate_rounds: 0,
    gate_wait_time_s: 0,
    gate_round_details: [],
  };
}

/** Telemetry for stages auto-approved in automated mode (no human interaction). */
export function gateAutoApprovedTelemetry(reviewRounds: number): StageTelemetryContext {
  return {
    review_rounds: reviewRounds,
    terminal_review_state: "clean",
    gate_status: "approved",
    gate_mode: "automated",
    gate_rounds: 0,
    gate_wait_time_s: 0,
    gate_round_details: [],
  };
}

/**
 * Telemetry for stages where a human gate was decided interactively.
 * Pass `gateRounds - 1` for approvals (the approval round is not a "feedback" round)
 * and `gateRounds` for rejections.
 */
export function gateInteractiveTelemetry(
  reviewRounds: number,
  decision: "approved" | "rejected",
  gateRounds: number,
  waitTime: number,
  details: GateRoundDetail[],
): StageTelemetryContext {
  return {
    review_rounds: reviewRounds,
    terminal_review_state: "clean",
    gate_status: decision,
    gate_mode: "interactive",
    gate_rounds: gateRounds,
    gate_wait_time_s: waitTime,
    gate_round_details: details,
  };
}
