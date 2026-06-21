// Run aggregate — owns RunState mutations; emits no side effects.
// No node:* or pi imports.

import type {
  FailurePolicy,
  InteractionMode,
  NextStage,
  ReviewDepth,
  Route,
  RunState,
  StageName,
  VerifyStatus,
} from "../value/index.js";

export const MAX_BACKWARD_LOOPS = 3;
/** A slice is escalated (blocked) when its requeue count exceeds this value. */
export const MAX_REQUEUE = 2;
/** Maximum per-round retries for transient dispatch failures (timeout, session_error). */
export const MAX_TRANSIENT_DISPATCH_RETRIES = 1;

/** Review-loop caps per stage. */
export const MAX_GOALS_REVIEW_ROUNDS = 5;
export const MAX_RESEARCH_REVIEW_ROUNDS = 3;
export const MAX_QUESTIONS_REVIEW_ROUNDS = 3;
export const MAX_ACCEPTANCE_ROUNDS = 3;

/** Fast review mode caps every review loop to this many rounds (one correction cycle). */
export const FAST_REVIEW_ROUNDS = 2;

/** Maximum rounds for the skeleton reviewer self-correction loop (build → review → repair). */
export const MAX_SKELETON_REVIEW_ROUNDS = 3;

/**
 * Returns the effective number of review rounds for a loop.
 * In fast mode the cap is clamped to FAST_REVIEW_ROUNDS; in thorough mode the
 * stage-specific thoroughMax is used unchanged.
 */
export function effectiveReviewRounds(reviewDepth: ReviewDepth | undefined, thoroughMax: number): number {
  return reviewDepth === "fast" ? Math.min(thoroughMax, FAST_REVIEW_ROUNDS) : thoroughMax;
}

export interface StartRunOptions {
  runId: string;
  userTask?: string;
  interactionMode: InteractionMode;
  failurePolicy: FailurePolicy;
  route?: Route;
  nextStage?: NextStage;
  now?: string;
}

export class Run {
  private _state: RunState;

  private constructor(state: RunState) {
    this._state = state;
  }

  static start(options: StartRunOptions): Run {
    const timestamp = options.now ?? new Date().toISOString();
    const base: RunState = {
      runId: options.runId,
      route: "full",
      lastCompletedStage: "none",
      nextStage: options.nextStage ?? "goals",
      stagesCompleted: [],
      backwardLoops: 0,
      resumeSource: "fresh",
      interactionMode: options.interactionMode,
      failurePolicy: options.failurePolicy,
      startedAt: timestamp,
      updatedAt: timestamp,
      currentSlice: null,
      slicesDone: [],
      slicesBlocked: [],
      requeueCounts: {},
    };
    if (options.userTask !== undefined) {
      base.userTask = options.userTask;
    }
    return new Run(base);
  }

  static rehydrate(state: RunState): Run {
    return new Run({ ...state });
  }

  get state(): Readonly<RunState> {
    return this._state;
  }

  get nextStage(): NextStage {
    return this._state.nextStage;
  }

  toSnapshot(): RunState {
    return { ...this._state };
  }

  completeStage(
    stage: StageName,
    nextStage: NextStage,
    options?: {
      route?: Route;
      verifyStatus?: VerifyStatus;
    },
  ): void {
    const next: RunState = {
      ...this._state,
      lastCompletedStage: stage,
      nextStage,
      stagesCompleted: appendUniqueStage(this._state.stagesCompleted, stage),
      updatedAt: new Date().toISOString(),
    };
    if (options?.verifyStatus !== undefined) {
      next.verifyStatus = options.verifyStatus;
    }
    this._state = next;
  }

  skipStage(_stage: StageName, nextStage: NextStage): void {
    this._state = { ...this._state, nextStage, updatedAt: new Date().toISOString() };
  }

  setNextStage(nextStage: NextStage): void {
    this._state = { ...this._state, nextStage, updatedAt: new Date().toISOString() };
  }

  // ---------------------------------------------------------------------------
  // Slice-specific mutations
  // ---------------------------------------------------------------------------

  setCurrentSlice(sliceId: string | null): void {
    this._state = { ...this._state, currentSlice: sliceId, updatedAt: new Date().toISOString() };
  }

  markSliceBuilding(sliceId: string): void {
    this._state = { ...this._state, currentSlice: sliceId, updatedAt: new Date().toISOString() };
  }

  markSliceDone(sliceId: string): void {
    this._state = {
      ...this._state,
      currentSlice: null,
      slicesDone: appendUnique(this._state.slicesDone, sliceId),
      updatedAt: new Date().toISOString(),
    };
  }

  requeueSlice(sliceId: string): void {
    const count = (this._state.requeueCounts[sliceId] ?? 0) + 1;
    this._state = {
      ...this._state,
      currentSlice: null,
      requeueCounts: { ...this._state.requeueCounts, [sliceId]: count },
      updatedAt: new Date().toISOString(),
    };
  }

  escalateSlice(sliceId: string): void {
    this._state = {
      ...this._state,
      currentSlice: null,
      slicesBlocked: appendUnique(this._state.slicesBlocked, sliceId),
      updatedAt: new Date().toISOString(),
    };
  }

  setPendingReconcile(value: boolean): void {
    const next = { ...this._state, updatedAt: new Date().toISOString() };
    if (value) {
      next.pendingReconcile = true;
    } else {
      delete next.pendingReconcile;
    }
    this._state = next;
  }

  setLastBackwardLoopFingerprint(fingerprint: string | undefined): void {
    const next = { ...this._state, updatedAt: new Date().toISOString() };
    if (fingerprint !== undefined) {
      next.lastBackwardLoopFingerprint = fingerprint;
    } else {
      delete next.lastBackwardLoopFingerprint;
    }
    this._state = next;
  }

  // ---------------------------------------------------------------------------
  // Backward-loop caps
  // ---------------------------------------------------------------------------

  incrementBackwardLoops(): void {
    this._state = { ...this._state, backwardLoops: this._state.backwardLoops + 1, updatedAt: new Date().toISOString() };
  }

  isBackwardLoopCapHit(): boolean {
    return this._state.backwardLoops >= MAX_BACKWARD_LOOPS;
  }

  isSliceRequeueCapped(sliceId: string): boolean {
    return (this._state.requeueCounts[sliceId] ?? 0) >= MAX_REQUEUE;
  }

  setResumeSource(source: RunState["resumeSource"]): void {
    this._state = { ...this._state, resumeSource: source, updatedAt: new Date().toISOString() };
  }
}

function appendUniqueStage(stages: StageName[], stage: StageName): StageName[] {
  return stages.includes(stage) ? stages : [...stages, stage];
}

function appendUnique(arr: string[], item: string): string[] {
  return arr.includes(item) ? arr : [...arr, item];
}
