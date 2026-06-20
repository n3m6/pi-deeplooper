/**
 * StageRunner — executes a single stage with retry logic.
 */

import type { StageContext } from "../../domain/event/index.js";
import type { TelemetrySink } from "../../application/port/index.js";
import type { RunState, StageModule, StageOutcome, StageRuntime } from "../port/index.js";
import { resolveStageFailure } from "./review-gate-coordinator.js";

export async function executeStage(
  stage: StageModule,
  runtime: StageRuntime,
  state: RunState,
  telemetrySink: TelemetrySink,
  stageInstances: Map<string, number>,
): Promise<{ outcome: StageOutcome; stageInstance: number; startedAt: string }> {
  const stageKey = stage.stage;
  let automaticRetries = 0;

  while (true) {
    const stageInstance = (stageInstances.get(stageKey) ?? 0) + 1;
    stageInstances.set(stageKey, stageInstance);
    const stageCtx: StageContext = { stage: stage.stage, stageInstance, route: state.route };
    const startedAt = (runtime.services.clock?.now() ?? new Date()).toISOString();
    await telemetrySink.record({ type: "stage.started", ...stageCtx });

    try {
      const initialOutcome = await stage.run(runtime);
      const resolution = await resolveStageFailure(stage, initialOutcome, runtime, state, telemetrySink, stageInstance);
      if (resolution === "retry") {
        await telemetrySink.record({
          type: "stage.retried",
          ...stageCtx,
          summary: `Retrying ${stage.stage} after operator escalation.`,
        });
        continue;
      }
      return { outcome: resolution, stageInstance, startedAt };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await telemetrySink.record({ type: "stage.failed", ...stageCtx, summary: msg, error: msg });
      if (runtime.services.commandContext.signal?.aborted) {
        throw error;
      }
      const shouldRetry = runtime.services.gates.failurePolicy === "best-effort" && automaticRetries === 0;
      if (!shouldRetry) {
        throw error;
      }
      automaticRetries += 1;
      await telemetrySink.record({
        type: "stage.retried",
        ...stageCtx,
        summary: `Retrying ${stage.stage} after an unexpected error.`,
      });
    }
  }
}
