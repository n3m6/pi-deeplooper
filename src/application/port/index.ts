/**
 * Application port definitions — the source of truth for all shared types.
 * Infrastructure adapters implement the interfaces defined here.
 *
 * This file is SDK-free. All SDK types are replaced with opaque local types.
 * Infrastructure adapters cast at the session boundary — see:
 *   src/infra/pi/session-dispatcher.ts
 *   src/infra/pi/human-gate.ts
 */

// ---------------------------------------------------------------------------
// Opaque SDK-boundary types
// Application code must not inspect these; only infrastructure adapters cast them.
// ---------------------------------------------------------------------------

/**
 * Opaque handle for a tool passed through the agent session boundary.
 * Application code may read .name for display/routing. Must not call .execute.
 */
export interface CustomTool {
  readonly name: string;
}

/**
 * Opaque result returned by a custom tool invocation.
 * Application code may read .details to check for structured payloads.
 */
export interface CustomToolResult {
  readonly details?: unknown;
}

/** Opaque model configuration handle. */
export type ModelHandle = object;

/** Narrow context shape used by the application — only .signal is read. */
export interface SignalContext {
  readonly signal?: AbortSignal | undefined;
}

// ---------------------------------------------------------------------------
// Re-export pure domain value types
// ---------------------------------------------------------------------------

export type {
  BackwardLoopClassification,
  BackwardLoopRequest,
  EvidenceQuality,
  ExplicitRunOptions,
  GateRoundDetail,
  InteractionMode,
  FailurePolicy,
  ModelTier,
  NextStage,
  ResumeSource,
  ReviewDepth,
  ReviewState,
  Route,
  RunState,
  StageOutcome,
  StageName,
  StageStatus,
  StageTelemetryContext,
  VerifyStatus,
} from "../../domain/value/index.js";

export type { InterviewEntry, InterviewEntrySource } from "../../domain/goals/interview-policy.js";

import type {
  StageName,
  Route,
  InteractionMode,
  FailurePolicy,
  ReviewDepth,
  RunState,
  StageOutcome,
} from "../../domain/value/index.js";

import type { InterviewEntry, InterviewEntrySource } from "../../domain/goals/interview-policy.js";

import type { DomainEvent } from "../../domain/event/index.js";
import type { Run } from "../../domain/run/index.js";

// ---------------------------------------------------------------------------
// ArtifactId — typed keyspace replacing the 28-field RunArtifacts string bag
// ---------------------------------------------------------------------------

export type SingletonArtifact =
  | "requirements"
  | "goals"
  | "config"
  | "questions"
  | "researchSummary"
  | "researchOpenQuestions"
  | "design"
  | "structure"
  | "baselineResults"
  | "sliceQueue"
  | "lessons"
  | "specHistory"
  | "skeletonTask"
  | "skeletonResults"
  | "globalAcceptanceResults"
  | "stage9Summary"
  | "stage10Summary";

export type ArtifactId =
  | { kind: SingletonArtifact }
  | { kind: "taskSpec"; phase: number; taskId: string }
  | { kind: "phaseFile"; phase: number; name: string }
  | { kind: "reviewFile"; name: string }
  | { kind: "feedbackFile"; name: string }
  | { kind: "researchFile"; name: string }
  | { kind: "runFile"; name: string };

// ---------------------------------------------------------------------------
// Telemetry event schema
// ---------------------------------------------------------------------------

export interface TelemetryEvent {
  schema_version: string;
  event_id: string;
  sequence: number;
  ts: string;
  run_id: string;
  writer_agent: "deeplooper";
  writer_scope: "orchestrator";
  event_type:
    | "run.started"
    | "run.resumed"
    | "run.completed"
    | "run.aborted"
    | "stage.started"
    | "stage.completed"
    | "stage.failed"
    | "stage.skipped"
    | "stage.retried"
    | "gate.presented"
    | "gate.approved"
    | "gate.rejected"
    | "backward_loop.requested"
    | "backward_loop.decided"
    | "backward_loop.reset"
    | "backward_loop.failed"
    | "checkpoint.created"
    | "metrics.generated"
    | "review.round.started"
    | "review.round.completed"
    | "dispatch.started"
    | "dispatch.completed"
    | "task.started"
    | "task.completed"
    | "slice.started"
    | "slice.completed"
    | "requeue.requested"
    | "requeue.decided"
    | "requeue.exhausted"
    | "pipeline.anomaly";
  status: string;
  route: Route;
  summary: string;
  stage?: StageName;
  stage_instance?: number;
  phase?: number;
  task_id?: string;
  review_round?: number;
  attempt?: number;
  child_agent?: string;
  correlation_id?: string;
  context?: Record<string, unknown>;
  artifacts?: string[];
  timing?: {
    started_at?: string;
    ended_at?: string;
    duration_s?: number;
  };
  decision?: {
    choice?: string;
    reason?: string;
  };
  error?: {
    message: string;
    code?: string;
  };
  git?: {
    branch?: string;
    commit?: string;
    dirty?: boolean;
  };
}

// ---------------------------------------------------------------------------
// Stage execution envelope
// ---------------------------------------------------------------------------

export interface StageExecutionEnvelope {
  stage: StageName;
  phase?: number;
  stageInstance: number;
  startedAt: string;
}

// ---------------------------------------------------------------------------
// Agent / dispatch types (infrastructure-coupled via pi SDK)
// ---------------------------------------------------------------------------

export type ThinkingLevelName = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface GenericCodingTarget {
  kind: "generic";
  name: "generic-coding";
  tools: string[];
  model?: ModelHandle;
  thinkingLevel?: ThinkingLevelName;
}

export interface LeafAgentDefinition {
  kind: "leaf";
  name: string;
  description: string;
  tools: string[];
  modelName?: string;
  thinkingLevel?: ThinkingLevelName;
  maxTurns: number;
  systemPromptMode: "replace" | "append";
  extensions: string[];
  filePath: string;
  body: string;
}

export type DispatchTarget = LeafAgentDefinition | GenericCodingTarget;

export interface DispatchRequest {
  target: DispatchTarget;
  prompt: string;
  cwd: string;
  signal?: AbortSignal;
  tools?: string[];
  customTools?: CustomTool[];
  timeoutMs?: number;
  /** UI-only correlation key for the activity presenter. Not recorded in telemetry. */
  correlationId?: string;
  /** Human-readable label for the activity board and activity box. Not recorded in telemetry. */
  activityLabel?: string;
}

export interface DispatchCustomToolCall {
  name: string;
  result: CustomToolResult;
}

export interface DispatchResult {
  text: string;
  messages: unknown[];
  customToolCalls: DispatchCustomToolCall[];
  endReason?: "agent_end" | "stage_return" | "aborted" | "max_turns" | "timeout" | "session_error";
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// ModelPolicy — per-tier model + thinking routing
// ---------------------------------------------------------------------------

export interface ResolvedModelRouting {
  /** Model name/id to pass to resolveModel; undefined = fall back to pi default. */
  modelName?: string;
  /** Thinking level override; undefined = fall back to target's own thinkingLevel. */
  thinkingLevel?: ThinkingLevelName;
}

export interface ModelPolicy {
  resolve(target: DispatchTarget): ResolvedModelRouting;
}

export interface Dispatcher {
  dispatch(request: DispatchRequest): Promise<DispatchResult>;
  dispatchParallel(requests: DispatchRequest[]): Promise<DispatchResult[]>;
  dispatchChain(requests: DispatchRequest[]): Promise<DispatchResult[]>;
  dispatchGenericCoding(
    prompt: string,
    options?: { cwd?: string; tools?: string[]; signal?: AbortSignal; correlationId?: string; activityLabel?: string },
  ): Promise<StageOutcome>;
}

// ---------------------------------------------------------------------------
// Gate / progress types
// ---------------------------------------------------------------------------

export interface GateChoice {
  value: string;
  comment?: string;
}

export interface GateOption {
  value: string;
  label: string;
}

export interface GateManager {
  readonly interactionMode: InteractionMode;
  readonly failurePolicy: FailurePolicy;
  readonly reviewDepth?: ReviewDepth;
  askText(title: string, question: string, placeholder?: string): Promise<string | undefined>;
  choose(title: string, options: GateOption[], message?: string): Promise<GateChoice | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  createAskHumanTool(): CustomTool;
  createGoalsReturnTool(): CustomTool;
  createInterviewReturnTool(): CustomTool;
}

// ---------------------------------------------------------------------------
// GoalsReturnPayload — structured output contract for dl-goals-synthesizer
// ---------------------------------------------------------------------------

export interface GoalsReturnPayload {
  goalsMarkdown: string;
  route: "full";
  coverageThreshold?: number;
  testGlobs?: string[];
}

/**
 * Reads the goals_return tool call recorded in a dispatch result.
 * Returns undefined if the synthesizer did not call the tool.
 * DEEPLOOPER always uses route "full".
 */
export function readGoalsReturn(result: DispatchResult): GoalsReturnPayload | undefined {
  const call = result.customToolCalls.find((c) => c.name === "goals_return");
  if (!call?.result.details) {
    return undefined;
  }
  const value = call.result.details as Record<string, unknown>;
  if (typeof value.goalsMarkdown !== "string" || !value.goalsMarkdown) {
    return undefined;
  }
  return {
    goalsMarkdown: value.goalsMarkdown,
    route: "full",
    ...(typeof value.coverageThreshold === "number" ? { coverageThreshold: Math.round(value.coverageThreshold) } : {}),
    ...(Array.isArray(value.testGlobs)
      ? { testGlobs: (value.testGlobs as unknown[]).filter((x): x is string => typeof x === "string") }
      : {}),
  };
}

/**
 * Reads the interview_return tool call recorded in a dispatch result.
 * Returns the array of interview entries, or undefined if the agent did not call the tool.
 */
export function readInterviewReturn(result: DispatchResult): InterviewEntry[] | undefined {
  const call = result.customToolCalls.find((c) => c.name === "interview_return");
  if (!call?.result.details) {
    return undefined;
  }
  const value = call.result.details as Record<string, unknown>;
  if (!Array.isArray(value.entries)) {
    return undefined;
  }
  return (value.entries as unknown[])
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
    .map((item) => ({
      branch: typeof item.branch === "string" ? item.branch : "",
      source: normalizeInterviewSource(item.source),
      content: typeof item.content === "string" ? item.content : "",
    }))
    .filter((entry) => entry.branch !== "" && entry.content !== "");
}

function normalizeInterviewSource(value: unknown): InterviewEntrySource {
  return value === "user-answer" ||
    value === "repo-finding" ||
    value === "user-confirmed-finding" ||
    value === "automation-default" ||
    value === "automation-fallback" ||
    value === "convention-default"
    ? value
    : "automation-fallback";
}

export interface ProgressReporter {
  setStage(stage: string, detail?: string): void;
  setWidget(lines: string[]): void;
  clear(): void;
}

// ---------------------------------------------------------------------------
// Pipeline services + stage runtime
// ---------------------------------------------------------------------------

export interface PipelineServices {
  commandContext: SignalContext;
  eventContext: SignalContext;
  dispatcher: Dispatcher;
  agentDefinitions: Map<string, LeafAgentDefinition>;
  gates: GateManager;
  progress: ProgressReporter;
  clock?: Clock;
  /** Port-based infrastructure — wired by the composition root. */
  versionControl: VersionControl;
  buildTool: BuildToolPort;
  artifactRepo: ArtifactRepository;
  telemetrySink: TelemetrySink;
  stateRepo: RunStateRepository;
}

export interface StageRuntime {
  state: RunState;
  workspaceRoot: string;
  services: PipelineServices;
  /** The stage currently executing. Set by the pipeline loop; undefined in isolated stage tests. */
  currentStage?: StageName;
}

export interface StageModule {
  readonly stage: StageName;
  run(runtime: StageRuntime): Promise<StageOutcome>;
}

// ---------------------------------------------------------------------------
// Port aliases for the new naming convention
// ---------------------------------------------------------------------------

export type { Dispatcher as AgentGateway };
export type { GateManager as HumanGate };
export type { ProgressReporter as ProgressPort };

// ---------------------------------------------------------------------------
// AgentCatalog port
// ---------------------------------------------------------------------------

export interface AgentCatalog {
  get(name: string): LeafAgentDefinition | undefined;
  all(): Map<string, LeafAgentDefinition>;
}

// ---------------------------------------------------------------------------
// ArtifactRepository port (uses ArtifactId)
// ---------------------------------------------------------------------------

export interface ArtifactRepository {
  read(id: ArtifactId): Promise<string | undefined>;
  write(id: ArtifactId, content: string): Promise<void>;
  exists(id: ArtifactId): Promise<boolean>;
  resolvePath(id: ArtifactId): string;
  /** Relative path from runDir to the artifact — used for filesWritten telemetry. */
  relPath(id: ArtifactId): string;
  listTaskSpecs(phase: number): Promise<ArtifactId[]>;
  listPhases(): Promise<number[]>;
  ensureDirectories(): Promise<void>;
  readWorkspaceFile(relativePath: string): Promise<string | undefined>;
  writeWorkspaceFile(relativePath: string, content: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// RunStateRepository port
// ---------------------------------------------------------------------------

export interface RunStateRepository {
  load(runId: string): Promise<Run | undefined>;
  save(run: Run): Promise<void>;
}

// ---------------------------------------------------------------------------
// TaskWorktreeHandle + VersionControl port
// ---------------------------------------------------------------------------

export interface TaskWorktreeHandle {
  branch: string;
  worktreeRoot: string;
  taskId: string;
  phase: number;
}

export interface CheckpointResult {
  /** Whether the checkpoint operation succeeded (git commands exited 0). */
  ok: boolean;
  /** Set when no files were staged and no commit was made. */
  skipped?: boolean;
  /** Human-readable reason when skipped or when ok is false. */
  warning?: string;
}

export interface VersionControl {
  createRunBranch(runId: string, signal?: AbortSignal): Promise<void>;
  checkpoint(
    stage: StageName,
    action: "complete" | "skipped" | "failed" | "finalized",
    signal?: AbortSignal,
  ): Promise<CheckpointResult>;
  resolveRepoRoot(signal?: AbortSignal): Promise<string>;
  prepareWorktree(phase: number, taskId: string, repoRoot: string, signal?: AbortSignal): Promise<TaskWorktreeHandle>;
  squashMerge(
    worktree: TaskWorktreeHandle,
    commitMessage: string,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; conflictOutput?: string }>;
  rebaseWorktree(worktree: TaskWorktreeHandle, signal?: AbortSignal): Promise<{ ok: boolean; output?: string }>;
  continueRebase(worktree: TaskWorktreeHandle, signal?: AbortSignal): Promise<{ ok: boolean; output?: string }>;
  commitWorktreeChanges(worktreeRoot: string, message: string, signal?: AbortSignal): Promise<void>;
  changedFiles(cwd: string, signal?: AbortSignal): Promise<string[]>;
  changedLineCount(cwd: string, signal?: AbortSignal): Promise<number>;
  listWorkspaceFiles(cwd: string, signal?: AbortSignal): Promise<string[]>;
  cleanupWorktree(worktree: TaskWorktreeHandle, signal?: AbortSignal): Promise<void>;
}

// ---------------------------------------------------------------------------
// BuildToolPort
// ---------------------------------------------------------------------------

export interface ExecOutcome {
  stdout: string;
  stderr: string;
  code: number;
}

export interface BuildToolPort {
  availableScripts(cwd: string): Promise<string[]>;
  runScript(name: string, cwd: string): Promise<ExecOutcome>;
}

// ---------------------------------------------------------------------------
// TelemetrySink port (receives domain events)
// ---------------------------------------------------------------------------

export interface TelemetrySink {
  record(event: DomainEvent): Promise<void>;
  regenerateRunLog(state: RunState): Promise<void>;
  regenerateMetrics(state: RunState): Promise<void>;
  readEvents(): Promise<TelemetryEvent[]>;
}

// ---------------------------------------------------------------------------
// Clock + IdGenerator ports
// ---------------------------------------------------------------------------

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  runId(now?: Date): string;
}
