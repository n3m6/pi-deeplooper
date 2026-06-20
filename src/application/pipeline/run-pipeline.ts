// RunPipeline — canonical exports from the decomposed pipeline modules.

export { runPipeline } from "./pipeline-loop.js";
export { executeStage } from "./stage-runner.js";
export { resolveStageFailure } from "./review-gate-coordinator.js";
export { applyStageTransition } from "./outcome-interpreter.js";
