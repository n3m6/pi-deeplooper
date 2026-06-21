// Domain event → TelemetryEvent mapping for the JSONL telemetry sink.

import type {
  BackwardLoopDecided,
  BackwardLoopFailed,
  BackwardLoopRequested,
  BackwardLoopReset,
  CheckpointCreated,
  DispatchCompleted,
  DispatchStarted,
  DomainEvent,
  GateApproved,
  GatePresented,
  GateRejected,
  PipelineAnomaly,
  RequeueDecided,
  RequeueExhausted,
  RequeueRequested,
  ReviewRoundCompleted,
  ReviewRoundStarted,
  RunAborted,
  RunCompleted,
  RunResumed,
  RunStarted,
  SliceCompleted,
  SliceStarted,
  StageCompleted,
  StageFailed,
  StageRetried,
  StageSkipped,
  StageStarted,
  TaskCompleted,
  TaskStarted,
} from "../../domain/event/index.js";
import type { TelemetryEvent } from "../../application/port/index.js";

export type TelemetryEventPartial = Omit<
  TelemetryEvent,
  "schema_version" | "event_id" | "sequence" | "ts" | "run_id" | "writer_agent" | "writer_scope"
>;

export function domainEventToTelemetryEvent(event: DomainEvent): TelemetryEventPartial | undefined {
  switch (event.type) {
    case "run.started":
    case "run.resumed":
    case "run.completed":
    case "run.aborted":
      return mapRunEvent(event);
    case "stage.started":
    case "stage.completed":
    case "stage.failed":
    case "stage.skipped":
    case "stage.retried":
      return mapStageEvent(event);
    case "gate.presented":
    case "gate.approved":
    case "gate.rejected":
      return mapGateEvent(event);
    case "backward_loop.requested":
    case "backward_loop.decided":
    case "backward_loop.reset":
    case "backward_loop.failed":
      return mapBackwardLoopEvent(event);
    case "checkpoint.created":
      return mapCheckpointEvent(event);
    case "review.round.started":
    case "review.round.completed":
    case "task.started":
    case "task.completed":
      return mapSubStageEvent(event);
    case "slice.started":
    case "slice.completed":
    case "requeue.requested":
    case "requeue.decided":
    case "requeue.exhausted":
      return mapSliceEvent(event);
    case "dispatch.started":
    case "dispatch.completed":
      // Dispatch events are persisted for audit but excluded from the timeline/run-log
      // (they are already aggregated via child_agent_calls in stage context).
      return mapDispatchEvent(event);
    case "pipeline.anomaly":
      return mapPipelineAnomalyEvent(event);
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Per-event-group mapping functions
// ---------------------------------------------------------------------------

type RunEvent = RunStarted | RunResumed | RunCompleted | RunAborted;
type StageEvent = StageStarted | StageCompleted | StageFailed | StageSkipped | StageRetried;
type GateEvent = GatePresented | GateApproved | GateRejected;
type BackwardLoopEvent = BackwardLoopRequested | BackwardLoopDecided | BackwardLoopReset | BackwardLoopFailed;
type SubStageEvent = ReviewRoundStarted | ReviewRoundCompleted | TaskStarted | TaskCompleted;
type SliceEvent = SliceStarted | SliceCompleted | RequeueRequested | RequeueDecided | RequeueExhausted;

function mapRunEvent(event: RunEvent): TelemetryEventPartial {
  switch (event.type) {
    case "run.started":
      return {
        event_type: "run.started",
        status: "PASS",
        route: event.route,
        summary: `Pipeline started. Route: ${event.route}.`,
      };
    case "run.resumed":
      return {
        event_type: "run.resumed",
        status: "PASS",
        route: event.route,
        summary: `Pipeline resumed. Route: ${event.route}.`,
      };
    case "run.completed":
      return {
        event_type: "run.completed",
        status: event.status,
        route: event.route,
        summary:
          event.status === "PASS"
            ? `Pipeline completed. Route: ${event.route}.`
            : `Pipeline stopped. Route: ${event.route}.`,
      };
    case "run.aborted":
      return {
        event_type: "run.aborted",
        status: "FAIL",
        route: event.route,
        summary: event.error,
        error: { message: event.error },
      };
  }
}

type StageLevelEvent = StageEvent | GateEvent | BackwardLoopEvent;

function stageEventFields(
  event: StageLevelEvent,
): Pick<TelemetryEventPartial, "route" | "stage"> & { phase?: number; stage_instance?: number } {
  return {
    route: event.route,
    stage: event.stage,
    ...(event.phase !== undefined ? { phase: event.phase } : {}),
    ...(event.stageInstance !== undefined ? { stage_instance: event.stageInstance } : {}),
  };
}

function mapStageEvent(event: StageEvent): TelemetryEventPartial {
  const base = stageEventFields(event);
  switch (event.type) {
    case "stage.started":
      return {
        event_type: "stage.started",
        status: "RUNNING",
        ...base,
        summary: `Stage ${event.stage} started. Route: ${event.route}.`,
      };
    case "stage.completed": {
      const resolvedEventType =
        event.outcome.status === "SKIP"
          ? "stage.skipped"
          : event.outcome.status === "FAIL"
            ? "stage.failed"
            : "stage.completed";
      return {
        event_type: resolvedEventType,
        status: event.outcome.status,
        ...base,
        summary: event.outcome.summary,
        artifacts: event.outcome.filesWritten,
        timing: { started_at: event.startedAt, ended_at: event.endedAt },
        ...(event.outcome.telemetry ? { context: event.outcome.telemetry } : {}),
      };
    }
    case "stage.failed":
      return {
        event_type: "stage.failed",
        status: "FAIL",
        ...base,
        summary: event.summary,
        ...(event.context ? { context: event.context } : {}),
        ...(event.error ? { error: { message: event.error } } : {}),
      };
    case "stage.skipped":
      return { event_type: "stage.skipped", status: "SKIP", ...base, summary: event.summary };
    case "stage.retried":
      return {
        event_type: "stage.retried",
        status: "RETRY",
        ...base,
        summary: event.summary,
        ...(event.context ? { context: event.context } : {}),
      };
  }
}

function mapGateEvent(event: GateEvent): TelemetryEventPartial {
  const base = stageEventFields(event);
  switch (event.type) {
    case "gate.presented":
      return { event_type: "gate.presented", status: "RUNNING", ...base, summary: event.summary };
    case "gate.approved":
      return { event_type: "gate.approved", status: "PASS", ...base, summary: event.summary };
    case "gate.rejected":
      return { event_type: "gate.rejected", status: "FAIL", ...base, summary: event.summary };
  }
}

function mapBackwardLoopEvent(event: BackwardLoopEvent): TelemetryEventPartial {
  const base = stageEventFields(event);
  switch (event.type) {
    case "backward_loop.requested":
      return {
        event_type: "backward_loop.requested",
        status: "FAIL",
        ...base,
        summary: event.request.summary,
        context: {
          classification: event.request.classification,
          ...(event.request.guidance !== undefined ? { guidance: event.request.guidance } : {}),
        },
      };
    case "backward_loop.decided":
      return {
        event_type: "backward_loop.decided",
        status: "PASS",
        ...base,
        summary: `Looping back to ${event.targetStage}.`,
        context: { classification: event.request.classification, target_stage: event.targetStage },
      };
    case "backward_loop.reset":
      return {
        event_type: "backward_loop.reset",
        status: "PASS",
        ...base,
        summary: `Escalation to ${event.targetStage}: pipeline routing updated.`,
      };
    case "backward_loop.failed":
      return {
        event_type: "backward_loop.failed",
        status: "FAIL",
        ...base,
        summary:
          event.reason === "no-progress"
            ? "Backward loop made no progress (fixed point); stopping to avoid thrash."
            : `Backward-loop cap (${event.maxLoops}) reached; stopping the run.`,
        context: {
          classification: event.classification,
          ...(event.reason !== undefined ? { reason: event.reason } : {}),
        },
      };
  }
}

function mapCheckpointEvent(event: CheckpointCreated): TelemetryEventPartial {
  return {
    event_type: "checkpoint.created",
    status: "PASS",
    route: event.route,
    stage: event.stage,
    ...(event.phase !== undefined ? { phase: event.phase } : {}),
    summary: event.summary,
  };
}

function mapSubStageEvent(event: SubStageEvent): TelemetryEventPartial {
  switch (event.type) {
    case "review.round.started":
      return {
        event_type: "review.round.started",
        status: "RUNNING",
        route: event.route,
        stage: event.stage,
        ...(event.phase !== undefined ? { phase: event.phase } : {}),
        review_round: event.reviewRound,
        summary: `${event.stage} review round ${event.reviewRound}/${event.maxRounds} started.`,
        context: { max_rounds: event.maxRounds },
      };
    case "review.round.completed":
      return {
        event_type: "review.round.completed",
        status: event.status,
        route: event.route,
        stage: event.stage,
        ...(event.phase !== undefined ? { phase: event.phase } : {}),
        review_round: event.reviewRound,
        summary: `${event.stage} review round ${event.reviewRound}/${event.maxRounds} ${event.status === "PASS" ? "passed" : "failed"}.`,
        context: { max_rounds: event.maxRounds },
      };
    case "task.started":
      return {
        event_type: "task.started",
        status: "RUNNING",
        route: event.route,
        ...(event.phase !== undefined ? { phase: event.phase } : {}),
        task_id: event.taskId,
        summary: `Task ${event.taskId} (${event.title}) started in wave ${event.wave}.`,
        context: { wave: event.wave, title: event.title },
      };
    case "task.completed":
      return {
        event_type: "task.completed",
        status: event.status,
        route: event.route,
        ...(event.phase !== undefined ? { phase: event.phase } : {}),
        task_id: event.taskId,
        summary: `Task ${event.taskId} (${event.title}) ${event.status === "PASS" ? "completed" : "failed"} in wave ${event.wave}.`,
        context: { wave: event.wave, title: event.title },
      };
  }
}

function mapSliceEvent(event: SliceEvent): TelemetryEventPartial {
  switch (event.type) {
    case "slice.started":
      return {
        event_type: "slice.started",
        status: "RUNNING",
        route: event.route,
        summary: `Slice ${event.sliceId} started: ${event.sliceTitle}`,
        context: { sliceId: event.sliceId, sliceTitle: event.sliceTitle },
      };
    case "slice.completed":
      return {
        event_type: "slice.completed",
        status: event.status === "done" ? "PASS" : "FAIL",
        route: event.route,
        summary: `Slice ${event.sliceId} ${event.status}.`,
        context: { sliceId: event.sliceId, sliceTitle: event.sliceTitle, sliceStatus: event.status },
      };
    case "requeue.requested":
      return {
        event_type: "requeue.requested",
        status: "FAIL",
        route: event.route,
        summary: `Slice ${event.sliceId} requeue requested (attempt ${event.requeueCount}): ${event.reason}`,
        context: { sliceId: event.sliceId, requeueCount: event.requeueCount, reason: event.reason },
      };
    case "requeue.decided":
      return {
        event_type: "requeue.decided",
        status: "PASS",
        route: event.route,
        summary: `Slice ${event.sliceId} requeued (attempt ${event.requeueCount}).`,
        context: { sliceId: event.sliceId, requeueCount: event.requeueCount },
      };
    case "requeue.exhausted":
      return {
        event_type: "requeue.exhausted",
        status: "FAIL",
        route: event.route,
        summary: `Slice ${event.sliceId} exhausted requeue budget (${event.requeueCount}) — escalating.`,
        context: { sliceId: event.sliceId, requeueCount: event.requeueCount },
      };
  }
}

function mapPipelineAnomalyEvent(event: PipelineAnomaly): TelemetryEventPartial {
  const status = event.severity === "error" ? "FAIL" : event.severity === "warning" ? "PARTIAL" : "PASS";
  return {
    event_type: "pipeline.anomaly",
    status,
    route: event.route,
    ...(event.stage !== undefined ? { stage: event.stage } : {}),
    summary: `[${event.code}] ${event.summary}`,
    ...(event.context !== undefined
      ? { context: { code: event.code, severity: event.severity, ...event.context } }
      : { context: { code: event.code, severity: event.severity } }),
  };
}

function mapDispatchEvent(event: DispatchStarted | DispatchCompleted): TelemetryEventPartial {
  return {
    event_type: event.type,
    status: event.type === "dispatch.started" ? "RUNNING" : event.status,
    route: event.route,
    ...(event.phase !== undefined ? { phase: event.phase } : {}),
    child_agent: event.childAgent,
    ...(event.stage !== undefined ? { stage: event.stage } : {}),
    ...(event.taskId !== undefined ? { task_id: event.taskId } : {}),
    summary: event.type === "dispatch.started" ? `Dispatching ${event.childAgent}.` : `${event.childAgent} completed.`,
  };
}
