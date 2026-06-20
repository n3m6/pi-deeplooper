// Pure reviewer-selection policy — no I/O, no side effects.
// No node:* or pi imports.

import type { Route } from "../value/index.js";

export interface ReviewerSpec {
  agentName: string;
  advisory: boolean;
}

export function selectReviewers(route: Route, changedFiles: string[], changedLineCount: number): ReviewerSpec[] {
  const reviewers: ReviewerSpec[] = [{ agentName: "dl-review-code-quality", advisory: false }];
  const hasTaskTests = changedFiles.some((file) => /\b(__tests__|tests?|spec)\b|[._-](test|spec)\./i.test(file));
  if (hasTaskTests) {
    reviewers.push({ agentName: "dl-review-test-coverage", advisory: false });
  }
  if (changedFiles.some((file) => /(auth|security|permission|token|secret|crypto|password|session)/i.test(file))) {
    reviewers.push({ agentName: "dl-review-security", advisory: false });
  }
  if (changedFiles.some((file) => /(log|catch|error|fallback|silent|ignore|empty|noop)/i.test(file))) {
    reviewers.push({ agentName: "dl-review-silent-failure", advisory: false });
  }
  if (route === "full") {
    reviewers.push({ agentName: "dl-review-goal-traceability", advisory: false });
  }
  if (
    changedFiles.length > 3 ||
    changedLineCount > 200 ||
    changedFiles.some((file) => /(simpl|refactor|util|helper|common|shared)/i.test(file))
  ) {
    reviewers.push({ agentName: "dl-review-code-simplifier", advisory: true });
  }
  return reviewers;
}
