/**
 * AgentReviewLoop — shared primitive for write → review → rewrite cycles.
 *
 * Caller provides the review step (and optionally the rewrite-on-fail step)
 * as callbacks; this module handles round counting, review-file persistence,
 * and status aggregation.
 */

import { MAX_TRANSIENT_DISPATCH_RETRIES, effectiveReviewRounds } from "../../domain/run/index.js";
import { parseReviewStatus, subStageContext, writeArtifact, artifactRelPath } from "../stage/utils.js";
import type { ArtifactId, StageRuntime } from "../port/index.js";

export interface AgentReviewLoopResult {
  status: "PASS" | "FAIL";
  reviewRounds: number;
  filesWritten: string[];
  /** Set when a dispatcher returned a session error rather than review content. */
  dispatchFailure?: true;
  /** Error message from a dispatch failure, or undefined for normal cap-hit FAILs. */
  summary?: string;
}

export interface AgentReviewLoopConfig {
  maxRounds: number;
  /**
   * Name prefix for review artifact files (e.g. "goals" → "goals-review-round-01.md").
   * The full name follows the convention `{stageName}-review-round-NN.md`.
   */
  stageName: string;
  /**
   * Run one review round. Return `{ text }` with the reviewer's output, or
   * `{ failure }` with an error summary if the dispatcher returned a session error.
   * Set `transient: true` to allow the round to be retried on transient failures.
   */
  runReview: (round: number) => Promise<{ text: string } | { failure: string; transient?: boolean }>;
  /**
   * Called when the reviewer returns FAIL and there are remaining rounds.
   * Should rewrite the artifact being reviewed (e.g. re-synthesize with feedback).
   * Return `{ failure }` to abort the loop early with a dispatch failure.
   * Set `transient: true` to allow the rewrite to be retried on transient failures.
   */
  onFail?: (reviewText: string, round: number) => Promise<void | { failure: string; transient?: boolean }>;
  /**
   * Maximum number of per-round retries for transient dispatch failures.
   * Defaults to `MAX_TRANSIENT_DISPATCH_RETRIES`.
   */
  maxTransientRetries?: number;
}

export async function runAgentReviewLoop(
  runtime: StageRuntime,
  config: AgentReviewLoopConfig,
): Promise<AgentReviewLoopResult> {
  const filesWritten: string[] = [];
  const ctx = subStageContext(runtime);
  const stage = ctx.stage ?? (config.stageName as import("../port/index.js").StageName);
  const maxTransientRetries = config.maxTransientRetries ?? MAX_TRANSIENT_DISPATCH_RETRIES;
  const maxRounds = effectiveReviewRounds(runtime.services.gates.reviewDepth, config.maxRounds);

  for (let round = 1; round <= maxRounds; round++) {
    await runtime.services.telemetrySink.record({
      type: "review.round.started",
      stage,
      route: ctx.route,
      reviewRound: round,
      maxRounds,
    });

    // Attempt the review, retrying on transient failures up to maxTransientRetries times.
    let reviewResult: Awaited<ReturnType<typeof config.runReview>>;
    for (let attempt = 0; ; attempt++) {
      reviewResult = await config.runReview(round);
      if (!("failure" in reviewResult)) break;
      if (!reviewResult.transient || attempt >= maxTransientRetries) break;
    }

    if ("failure" in reviewResult) {
      await runtime.services.telemetrySink.record({
        type: "review.round.completed",
        stage,
        route: ctx.route,
        reviewRound: round,
        maxRounds,
        status: "FAIL",
      });
      return {
        status: "FAIL",
        reviewRounds: round,
        filesWritten,
        dispatchFailure: true,
        summary: reviewResult.failure,
      };
    }

    const reviewId: ArtifactId = {
      kind: "reviewFile",
      name: `${config.stageName}-review-round-${String(round).padStart(2, "0")}.md`,
    };
    await writeArtifact(runtime, reviewId, reviewResult.text);
    filesWritten.push(artifactRelPath(runtime, reviewId));

    const roundStatus = parseReviewStatus(reviewResult.text) === "PASS" ? "PASS" : "FAIL";
    await runtime.services.telemetrySink.record({
      type: "review.round.completed",
      stage,
      route: ctx.route,
      reviewRound: round,
      maxRounds,
      status: roundStatus,
    });

    if (roundStatus === "PASS") {
      return { status: "PASS", reviewRounds: round, filesWritten };
    }

    if (round === maxRounds) {
      return { status: "FAIL", reviewRounds: round, filesWritten };
    }

    if (config.onFail) {
      // Attempt the rewrite, retrying on transient failures up to maxTransientRetries times.
      let failResult: Awaited<ReturnType<NonNullable<typeof config.onFail>>>;
      for (let attempt = 0; ; attempt++) {
        failResult = await config.onFail(reviewResult.text, round);
        if (!failResult || !("failure" in failResult)) break;
        if (!failResult.transient || attempt >= maxTransientRetries) break;
      }
      if (failResult && "failure" in failResult) {
        return {
          status: "FAIL",
          reviewRounds: round,
          filesWritten,
          dispatchFailure: true,
          summary: failResult.failure,
        };
      }
    }
  }

  return { status: "FAIL", reviewRounds: maxRounds, filesWritten };
}
