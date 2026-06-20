/**
 * PipelineLoop — the main DEEPLOOPER pipeline driver.
 *
 * Stage graph:
 *   goals → research → design → skeleton → baseline → slice-loop
 *   slice-loop →(queue exhausted)→ verify
 *   slice-loop →(LOOP_DESIGN/GOALS escalation)→ design or goals
 *   verify →(remediation slices)→ slice-loop
 *   verify →(PASS)→ accept
 *   accept →(remediation slices)→ slice-loop
 *   accept →(PASS)→ report → done
 *
 * Backward loops in DEEPLOOPER:
 *   - LOCAL_SLICE: handled entirely inside slice-loop.ts (requeue); never surfaces here.
 *   - LOOP_DESIGN / LOOP_GOALS: slice-loop returns a backwardLoop payload; the pipeline
 *     loop escalates to design/goals without deleting any completed slices.
 */

import { Run, MAX_BACKWARD_LOOPS } from "../../domain/run/index.js";
import { escalationTarget } from "../../domain/backward-loop/artifact-reset-policy.js";
import type { StageContext } from "../../domain/event/index.js";
import { baselineStage } from "../stage/baseline.js";
import { designStage } from "../stage/design.js";
import { goalsStage } from "../stage/goals.js";
import { researchStage } from "../stage/research.js";
import { reportStage } from "../stage/report.js";
import { skeletonStage } from "../stage/skeleton.js";
import { sliceLoopStage } from "../stage/slice-loop.js";
import { verifyStage } from "../stage/verify.js";
import { acceptStage } from "../stage/accept.js";
import type { PipelineServices, RunState, StageModule, StageName, StageRuntime, TelemetrySink } from "../port/index.js";
import { executeStage } from "./stage-runner.js";
import { applyStageTransition } from "./outcome-interpreter.js";

const STAGES: Record<StageName, StageModule> = {
  goals: goalsStage,
  research: researchStage,
  design: designStage,
  skeleton: skeletonStage,
  baseline: baselineStage,
  "slice-loop": sliceLoopStage,
  verify: verifyStage,
  accept: acceptStage,
  report: reportStage,
};

export async function runPipeline(options: {
  services: PipelineServices;
  state: RunState;
  workspaceRoot: string;
  isResumed: boolean;
}): Promise<RunState> {
  const { services, workspaceRoot, isResumed } = options;
  const sink: TelemetrySink = services.telemetrySink;
  const signal = services.commandContext.signal;
  let run = Run.rehydrate(options.state);
  const stageInstances = new Map<string, number>();

  if (!isResumed) {
    await services.versionControl.createRunBranch(run.state.runId, signal);
    await sink.record({ type: "run.started", runId: run.state.runId, route: run.state.route });
  } else {
    await sink.record({ type: "run.resumed", runId: run.state.runId, route: run.state.route });
  }

  await services.stateRepo.save(run);

  try {
    while (run.nextStage !== "done") {
      const stageName = run.nextStage;
      const stage = STAGES[stageName];
      services.progress.setStage(`deeplooper/${stageName}`);

      const stateSnapshot = run.toSnapshot();
      const runtime: StageRuntime = {
        state: stateSnapshot,
        workspaceRoot,
        services,
        currentStage: stage.stage,
      };

      const { outcome, stageInstance, startedAt } = await executeStage(
        stage,
        runtime,
        stateSnapshot,
        sink,
        stageInstances,
      );

      // Re-sync the run aggregate with any state the stage persisted directly via
      // stateRepo (slice-loop writes slicesDone / requeueCounts / pendingReconcile
      // as it progresses). Without this, the pipeline-loop's snapshot is stale and
      // the next save would clobber those slice-level mutations.
      const persisted = await services.stateRepo.load(run.state.runId);
      if (persisted) {
        run = persisted;
      }

      const stageCtx: StageContext = {
        stage: stage.stage,
        stageInstance,
        route: run.state.route,
      };

      // -------------------------------------------------------------------
      // Escalation backward loops (LOOP_DESIGN / LOOP_GOALS)
      // These come from slice-loop.ts when LOCAL_SLICE cap is exceeded.
      // No artifact archiving; completed slices are preserved.
      // -------------------------------------------------------------------
      if (outcome.backwardLoop) {
        await sink.record({ type: "backward_loop.requested", ...stageCtx, request: outcome.backwardLoop });

        if (run.isBackwardLoopCapHit()) {
          await sink.record({
            type: "backward_loop.failed",
            ...stageCtx,
            classification: outcome.backwardLoop.classification,
            maxLoops: MAX_BACKWARD_LOOPS,
          });
          await services.stateRepo.save(run);
          break;
        }

        const target = escalationTarget(outcome.backwardLoop.classification);
        run.incrementBackwardLoops();
        // Signal slice-loop to reconcile the queue when it re-enters after design.
        if (target === "design" || target === "goals") {
          run.setPendingReconcile(true);
        }
        run.setNextStage(target);

        await sink.record({
          type: "backward_loop.decided",
          ...stageCtx,
          targetStage: target,
          request: outcome.backwardLoop,
        });
        await sink.record({
          type: "backward_loop.reset",
          ...stageCtx,
          targetStage: target,
        });
        await services.stateRepo.save(run);
        continue;
      }

      // -------------------------------------------------------------------
      // Normal stage completion
      // -------------------------------------------------------------------
      await sink.record({
        type: "stage.completed",
        stage: stage.stage,
        stageInstance,
        route: outcome.route ?? run.state.route,
        outcome,
        startedAt,
        endedAt: (services.clock?.now() ?? new Date()).toISOString(),
      });

      // Hard stop on FAIL — unless verify/accept queued remediation slices, in which
      // case the transition policy routes back to slice-loop instead of stopping.
      if (outcome.status === "FAIL" && outcome.telemetry?.remediationSlicesAdded !== true) {
        await services.stateRepo.save(run);
        break;
      }

      const newState = applyStageTransition(run.toSnapshot(), stage.stage, outcome, services.artifactRepo);
      run = Run.rehydrate(newState);
      await services.stateRepo.save(run);
      await sink.regenerateRunLog(run.toSnapshot());
      await sink.regenerateMetrics(run.toSnapshot());
      const cpResult = await services.versionControl.checkpoint(stage.stage, "complete", signal);
      if (!cpResult.skipped) {
        await sink.record({
          type: "checkpoint.created",
          stage: stage.stage,
          route: run.state.route,
          summary: cpResult.ok
            ? `Checkpoint committed after stage ${stage.stage}.`
            : `Checkpoint failed after stage ${stage.stage}: ${cpResult.warning ?? "unknown error"}`,
        });
      }
    }

    await sink.record({
      type: "run.completed",
      runId: run.state.runId,
      route: run.state.route,
      status: run.nextStage === "done" ? "PASS" : "PARTIAL",
    });

    await sink.regenerateRunLog(run.toSnapshot());
    await sink.regenerateMetrics(run.toSnapshot());
    if (run.state.lastCompletedStage !== "none") {
      const finalCp = await services.versionControl.checkpoint(run.state.lastCompletedStage, "finalized", signal);
      if (!finalCp.skipped) {
        await sink.record({
          type: "checkpoint.created",
          stage: run.state.lastCompletedStage,
          route: run.state.route,
          summary: finalCp.ok
            ? "Terminal checkpoint committed."
            : `Terminal checkpoint failed: ${finalCp.warning ?? "unknown error"}`,
        });
      }
    }
    return run.toSnapshot();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await sink.record({
      type: "run.aborted",
      runId: run.state.runId,
      route: run.state.route,
      error: msg,
    });
    await sink.regenerateRunLog(run.toSnapshot());
    await sink.regenerateMetrics(run.toSnapshot());
    if (run.state.lastCompletedStage !== "none") {
      const abortCp = await services.versionControl.checkpoint(run.state.lastCompletedStage, "failed", signal);
      if (!abortCp.skipped) {
        await sink.record({
          type: "checkpoint.created",
          stage: run.state.lastCompletedStage,
          route: run.state.route,
          summary: abortCp.ok
            ? "Abort checkpoint committed."
            : `Abort checkpoint failed: ${abortCp.warning ?? "unknown error"}`,
        });
      }
    }
    throw error;
  } finally {
    services.progress.clear();
  }
}
