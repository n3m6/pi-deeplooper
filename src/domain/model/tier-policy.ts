// Pure domain tier policy — no node:* or pi imports allowed.

import type { ModelTier } from "../value/index.js";

/**
 * Maps each leaf agent name to its model tier.
 *
 * architect — frontier synthesis work whose artifacts cascade downstream.
 * coding    — the generic agentic coder that writes/tests/verifies code.
 * review    — adversarial read-only critique; high fan-out per task.
 * utility   — cheap mechanical work: extraction, search, formatting.
 */
export const AGENT_TIERS: Record<string, ModelTier> = {
  // --- architect -----------------------------------------------------------
  "dl-goals-synthesizer": "architect",
  "dl-goals-interviewer": "architect",
  "dl-research-synthesizer": "architect",
  "dl-design-synthesizer": "architect",
  "dl-structure-mapper": "architect",
  "dl-slice-planner": "architect",
  "dl-reflector": "architect",

  // --- review --------------------------------------------------------------
  "dl-goals-reviewer": "review",
  "dl-research-reviewer": "review",
  "dl-design-reviewer": "review",
  "dl-structure-reviewer": "review",
  "dl-feasibility-checker": "review",
  "dl-done-checker": "review",
  "dl-review-security": "review",
  "dl-review-silent-failure": "review",
  "dl-review-code-quality": "review",
  "dl-review-code-simplifier": "review",
  "dl-review-test-quality": "review",
  "dl-review-test-coverage": "review",
  "dl-review-goal-traceability": "review",
  "dl-review-accept-spec": "review",
  "dl-review-accept-code-quality": "review",
  "dl-review-accept-goal-traceability": "review",
  "dl-integration-checker": "review",
  "dl-e2e-regression-checker": "review",
  "dl-baseline-regression-checker": "review",
  "dl-backward-loop-detector": "review",
  "dl-verifier": "review",
  "dl-fast-impl-verify": "review",

  // --- utility -------------------------------------------------------------
  "dl-question-generator": "utility",
  "dl-question-leakage-reviewer": "utility",
  "dl-question-quality-reviewer": "utility",
  "dl-codebase-researcher": "utility",
  "dl-web-researcher": "utility",
  "dl-coverage-planner": "utility",
  "dl-baseline-checker": "utility",
  "dl-reporter": "utility",
  "dl-fast-impl-code": "utility",
  "dl-fast-impl-test": "utility",
};

/**
 * Returns the tier for a named leaf agent.
 * Unknown names (e.g. future agents not yet in the map) fall back to "utility"
 * so they use the cheapest model rather than silently consuming a more expensive one.
 */
export function tierForAgentName(name: string): ModelTier {
  return AGENT_TIERS[name] ?? "utility";
}
