import type { DomainEvent } from "../../domain/event/index.js";

/**
 * Single source of truth for DomainEvent → human-readable label mappings.
 *
 * `eventLabelFor` encodes the full breadcrumb-format label set. Both the
 * transcript breadcrumbs (`breadcrumbFor` in live-ui-telemetry-sink.ts) and
 * the TUI strip lines (`stripLineFor` in live-activity-presenter.ts) delegate
 * to this function, with the strip overriding only the two places where the
 * surfaces intentionally differ:
 *
 *   - `slice.started`: breadcrumb uses " starting: ", strip uses ": "
 *   - `slice.completed`, `requeue.requested`, `requeue.exhausted`:
 *     breadcrumb-only — strip does not show these events
 */
export function eventLabelFor(event: DomainEvent): { line: string; level?: "info" | "warning" | "error" } | undefined {
  switch (event.type) {
    case "run.started":
      return { line: `Deeplooper started - route ${event.route}`, level: "info" };
    case "run.resumed":
      return { line: `Deeplooper resumed - route ${event.route}`, level: "info" };
    case "run.completed":
      return { line: `Deeplooper ${event.status}`, level: "info" };
    case "run.aborted":
      return { line: `Deeplooper aborted - ${event.error}`, level: "error" };

    case "stage.started":
      return { line: `starting ${event.stage}` };
    case "stage.completed":
      return { line: `OK ${event.stage} - ${event.outcome.summary}` };
    case "stage.failed":
      return { line: `FAIL ${event.stage} - ${event.summary}`, level: "error" };
    case "stage.skipped":
      return { line: `skip ${event.stage} (${event.summary})` };

    case "backward_loop.decided":
    case "backward_loop.reset":
      return { line: `loop back to ${event.targetStage}` };
    case "backward_loop.failed":
      return { line: `backward-loop cap reached`, level: "error" };

    case "gate.presented":
      return { line: `approval needed at ${event.stage}`, level: "warning" };
    case "gate.approved":
      return { line: `gate ${event.stage} approved` };
    case "gate.rejected":
      return { line: `gate ${event.stage} rejected` };

    // Breadcrumb format: "slice X starting: <title>"
    // Strip format differs — handled by stripLineFor in live-activity-presenter.ts
    case "slice.started":
      return { line: `slice ${event.sliceId} starting: ${event.sliceTitle}` };

    // Breadcrumb-only events (not shown in the TUI strip)
    case "slice.completed":
      return { line: `slice ${event.sliceId} ${event.status}` };
    case "requeue.requested":
      return { line: `slice ${event.sliceId} requeued (attempt ${event.requeueCount})` };
    case "requeue.exhausted":
      return { line: `slice ${event.sliceId} exhausted requeues — escalating`, level: "warning" };

    case "review.round.started":
      return { line: `${event.stage} review round ${event.reviewRound}/${event.maxRounds}` };
    case "task.completed":
      return { line: `task ${event.taskId} ${event.status === "PASS" ? "done" : "FAIL"} (wave ${event.wave})` };

    // High-frequency events — no label for either surface
    case "dispatch.started":
    case "dispatch.completed":
    case "review.round.completed":
    case "task.started":
    case "backward_loop.requested":
    case "requeue.decided":
      return undefined;

    default:
      return undefined;
  }
}
