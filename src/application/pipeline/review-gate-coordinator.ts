/**
 * ReviewGateCoordinator — resolves stage failures when a review loop hits its cap.
 */

import type { StageContext } from "../../domain/event/index.js";
import type { TelemetrySink } from "../../application/port/index.js";
import type { RunState, StageModule, StageOutcome, StageRuntime, StageTelemetryContext } from "../port/index.js";

export async function resolveStageFailure(
  stage: StageModule,
  outcome: StageOutcome,
  runtime: StageRuntime,
  state: RunState,
  telemetrySink: TelemetrySink,
  stageInstance: number,
): Promise<StageOutcome | "retry"> {
  if (outcome.status !== "FAIL" || outcome.telemetry?.terminal_review_state !== "unclean-cap") {
    return outcome;
  }

  if (stage.stage === "accept") {
    return outcome;
  }

  const stageCtx: StageContext = { stage: stage.stage, stageInstance, route: state.route };
  const gateTitle = `${stage.stage} review did not converge`;
  const gateMessage = outcome.summary;
  const baseTelemetry: StageTelemetryContext = {
    ...(outcome.telemetry ?? {}),
    gate_rounds: (outcome.telemetry?.gate_rounds ?? 0) + 1,
    gate_mode: runtime.services.gates.interactionMode,
  };

  if (runtime.services.gates.interactionMode !== "interactive") {
    if (runtime.services.gates.failurePolicy !== "best-effort") {
      await telemetrySink.record({
        type: "gate.rejected",
        ...stageCtx,
        summary: `${stage.stage} stopped at the review cap in automated fail-closed mode.`,
      });
      return { ...outcome, telemetry: { ...baseTelemetry, gate_status: "rejected" } };
    }

    await telemetrySink.record({
      type: "gate.approved",
      ...stageCtx,
      summary: `${stage.stage} auto-approved after hitting the review cap in best-effort mode.`,
    });
    return {
      ...outcome,
      status: "PARTIAL",
      summary: `${outcome.summary} Proceeding under automated best-effort.`,
      telemetry: { ...baseTelemetry, gate_status: "approved" },
    };
  }

  await telemetrySink.record({ type: "gate.presented", ...stageCtx, summary: gateTitle });
  const choice = await runtime.services.gates.choose(
    gateTitle,
    [
      { value: "approve", label: "Proceed with the current artifact" },
      { value: "retry", label: "Retry the stage once more" },
      { value: "abort", label: "Stop the run here" },
    ],
    gateMessage,
  );

  if (choice?.value === "retry") {
    await telemetrySink.record({ type: "gate.approved", ...stageCtx, summary: `Retry approved for ${stage.stage}.` });
    return "retry";
  }

  if (choice?.value === "approve") {
    await telemetrySink.record({
      type: "gate.approved",
      ...stageCtx,
      summary: `${stage.stage} approved after review-cap escalation.`,
    });
    return {
      ...outcome,
      status: "PARTIAL",
      summary: `${outcome.summary} Proceeding with human approval after review-cap escalation.`,
      telemetry: { ...baseTelemetry, gate_status: "approved" },
    };
  }

  await telemetrySink.record({
    type: "gate.rejected",
    ...stageCtx,
    summary: `${stage.stage} stopped after review-cap escalation.`,
  });
  return { ...outcome, telemetry: { ...baseTelemetry, gate_status: "rejected" } };
}
