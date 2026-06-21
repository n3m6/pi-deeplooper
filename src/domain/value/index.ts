// Pure domain value types — no node:* or pi imports allowed.

export type Route = "full";
export type ModelTier = "architect" | "coding" | "review" | "utility";
export type InteractionMode = "interactive" | "automated";
export type FailurePolicy = "fail-closed" | "best-effort";
export type ReviewDepth = "thorough" | "fast";
export type ResumeSource = "fresh" | "resume" | "artifacts";
export type ReviewState = "clean" | "unclean-cap" | "stable-cap";
export type StageStatus = "PASS" | "FAIL" | "PARTIAL" | "SKIP";
export type VerifyStatus = "PASS" | "PARTIAL" | "FAIL";

export type StageName =
  | "goals"
  | "research"
  | "design"
  | "skeleton"
  | "baseline"
  | "slice-loop"
  | "verify"
  | "accept"
  | "report";

export type NextStage = StageName | "done";

/** DEEPLOOPER backward-loop classification. LOCAL_SLICE = requeue current slice within the loop. */
export type BackwardLoopClassification = "LOCAL_SLICE" | "LOOP_DESIGN" | "LOOP_GOALS" | "NO_LOOP";

export interface BackwardLoopRequest {
  classification: BackwardLoopClassification;
  summary: string;
  guidance?: string;
  targetStage?: StageName;
  details?: Record<string, unknown>;
}

export interface EvidenceQuality {
  deterministic: number;
  flaky: number;
  harnessNoisy: number;
  ambiguous: number;
  redundant: number;
  noTestTasks: number;
  noTestAuditOverrides: number;
}

export interface GateRoundDetail {
  round: number;
  decision: "approved" | "rejected";
  presented_at: string;
  responded_at: string;
}

export interface StageTelemetryContext {
  review_rounds?: number;
  terminal_review_state?: ReviewState;
  review_type?: string;
  child_agent_calls?: Record<string, number>;
  evidence_quality?: EvidenceQuality;
  gate_status?: "approved" | "rejected" | "none";
  gate_mode?: InteractionMode | "automated";
  gate_rounds?: number;
  gate_wait_time_s?: number;
  gate_round_details?: GateRoundDetail[];
  verify_status?: VerifyStatus;
  /** Set by slice-loop when a backward-loop escalation is requested. */
  escalationTarget?: "design" | "goals";
  /** Set by verify/accept when remediation slices were appended and queue needs re-entry. */
  remediationSlicesAdded?: boolean;
  [key: string]: unknown;
}

export interface StageOutcome {
  status: StageStatus;
  filesWritten: string[];
  summary: string;
  route?: Route;
  phase?: number;
  nextStage?: NextStage;
  lastCompletedStage?: StageName | "none";
  telemetry?: StageTelemetryContext;
  backwardLoop?: BackwardLoopRequest;
  reportContent?: string;
}

export interface RunState {
  runId: string;
  userTask?: string;
  route: Route;
  lastCompletedStage: StageName | "none";
  nextStage: NextStage;
  stagesCompleted: StageName[];
  backwardLoops: number;
  resumeSource: ResumeSource;
  interactionMode: InteractionMode;
  failurePolicy: FailurePolicy;
  verifyStatus?: VerifyStatus;
  startedAt: string;
  updatedAt: string;
  /** The slice-id currently being built inside slice-loop (null when not in slice-loop). */
  currentSlice: string | null;
  /** Slice-ids that have been successfully completed. */
  slicesDone: string[];
  /** Slice-ids that were escalated (blocked after MAX_REQUEUE). */
  slicesBlocked: string[];
  /** Per-slice requeue count. */
  requeueCounts: Record<string, number>;
  /**
   * When set, slice-loop must reconcile the queue with the updated design after
   * re-entering from a Design/Goals escalation.
   */
  pendingReconcile?: boolean;
  /**
   * Fingerprint of the last backward-loop escalation. Used to detect no-progress
   * fixed points where re-running design produces the same inputs and the loop
   * would burn the budget without making progress.
   * Format: "<sliceId>:<classification>:<normalizedReason>:<actionableSliceCount>"
   */
  lastBackwardLoopFingerprint?: string;
}

export interface ExplicitRunOptions {
  mode?: InteractionMode;
  failurePolicy?: FailurePolicy;
  resumeRunId?: string;
  reviewDepth?: ReviewDepth;
  modelProfile?: string;
}
