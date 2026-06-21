import { QUESTION_SET, inferFromTask, unresolvedRequiredBranches } from "../../domain/goals/interview-policy.js";
import { MAX_GOALS_REVIEW_ROUNDS, MAX_TRANSIENT_DISPATCH_RETRIES } from "../../domain/run/index.js";
import { runAgentReviewLoop } from "../workflow/agent-review-loop.js";
import type { DispatchResult, GoalsReturnPayload, InterviewEntry } from "../port/index.js";
import { readGoalsReturn, readInterviewReturn } from "../port/index.js";
import type { GateRoundDetail, StageModule, StageOutcome, StageRuntime } from "../port/index.js";
import {
  artifactRelPath,
  dispatchFailureSummary,
  dispatchLeaf,
  gateAutoApprovedTelemetry,
  gateInteractiveTelemetry,
  gateNoneTelemetry,
  isTransientDispatchFailure,
  readArtifact,
  secondsBetween,
  subStageContext,
  writeArtifact,
} from "./utils.js";

// Accumulated gate interaction state, mutated across iterations of the approval loop.
interface GoalsGateCtx {
  gateRounds: number;
  gateWaitTimeSeconds: number;
  gateRoundDetails: GateRoundDetail[];
}

// Discriminated result from runGoalsGate.
type GoalsGateResult = { next: "return"; outcome: StageOutcome } | { next: "continue"; feedback: string | undefined };

export const goalsStage: StageModule = {
  stage: "goals",
  async run(runtime): Promise<StageOutcome> {
    const userTask = runtime.state.userTask;
    if (!userTask) {
      return {
        status: "FAIL",
        filesWritten: [],
        summary: "Cannot run Goals without an initial task description.",
        telemetry: { gate_status: "none" },
      };
    }

    await writeArtifact(runtime, { kind: "requirements" }, userTask);

    const interview = await collectInterview(runtime, userTask);
    if ("failure" in interview) {
      return {
        status: "FAIL",
        filesWritten: ["requirements.md"],
        summary: interview.failure,
        telemetry: gateNoneTelemetry(0),
      };
    }

    const feedbackHistory: string[] = [];
    const gateCtx: GoalsGateCtx = { gateRounds: 0, gateWaitTimeSeconds: 0, gateRoundDetails: [] };

    while (true) {
      // 1. Synthesize goals
      const synthesized = await dispatchLeaf(
        runtime,
        "dl-goals-synthesizer",
        [
          "=== RUN ID ===",
          runtime.state.runId,
          "",
          "=== USER TASK ===",
          userTask,
          "",
          "=== INTERVIEW RECORD ===",
          renderInterviewRecord(interview.entries),
          feedbackHistory.length > 0 ? "\n=== FEEDBACK HISTORY ===" : "",
          feedbackHistory.length > 0 ? feedbackHistory.join("\n\n") : "",
        ]
          .filter(Boolean)
          .join("\n"),
        {
          customTools: [runtime.services.gates.createAskHumanTool(), runtime.services.gates.createGoalsReturnTool()],
        },
      );

      const synthesisFailure = goalsDispatchFailureOutcome(
        synthesized,
        "Goals synthesis failed",
        ["requirements.md"],
        0,
      );
      if (synthesisFailure) return synthesisFailure;

      const goalsReturn = readGoalsReturn(synthesized);
      if (!goalsReturn) {
        return {
          status: "FAIL",
          filesWritten: ["requirements.md"],
          summary: "Goals synthesis did not call goals_return.",
          telemetry: gateNoneTelemetry(0),
        };
      }
      await writeArtifact(runtime, { kind: "goals" }, goalsReturn.goalsMarkdown);
      await writeArtifact(runtime, { kind: "config" }, renderGoalsConfig(runtime.state.runId, goalsReturn));

      // 2. Run agent review loop
      const interviewRecord = renderInterviewRecord(interview.entries);
      const requirements = await readArtifact(runtime, { kind: "requirements" });
      const review = await runAgentReviewLoop(runtime, {
        maxRounds: MAX_GOALS_REVIEW_ROUNDS,
        stageName: "goals",
        runReview: async () => {
          const goals = await readArtifact(runtime, { kind: "goals" });
          const result = await dispatchLeaf(
            runtime,
            "dl-goals-reviewer",
            [
              "=== REQUIREMENTS ===",
              requirements,
              "",
              "=== INTERVIEW RECORD ===",
              interviewRecord,
              "",
              "=== GOALS ===",
              goals,
            ].join("\n"),
          );
          const failure = dispatchFailureSummary(result, "Goals review failed");
          if (failure) return { failure, transient: isTransientDispatchFailure(result) };
          return { text: result.text };
        },
        onFail: async (reviewText) => {
          const rewritten = await dispatchLeaf(
            runtime,
            "dl-goals-synthesizer",
            [
              "=== RUN ID ===",
              runtime.state.runId,
              "",
              "=== USER TASK ===",
              runtime.state.userTask ?? requirements,
              "",
              "=== INTERVIEW RECORD ===",
              interviewRecord,
              "",
              "=== REVIEW FEEDBACK ===",
              reviewText,
            ].join("\n"),
            {
              customTools: [
                runtime.services.gates.createAskHumanTool(),
                runtime.services.gates.createGoalsReturnTool(),
              ],
            },
          );
          const rewriteFailure = dispatchFailureSummary(rewritten, "Goals rewrite failed");
          if (rewriteFailure) return { failure: rewriteFailure, transient: isTransientDispatchFailure(rewritten) };
          const rewriteReturn = readGoalsReturn(rewritten);
          if (!rewriteReturn) return { failure: "Goals rewrite did not call goals_return." };
          await writeArtifact(runtime, { kind: "goals" }, rewriteReturn.goalsMarkdown);
          await writeArtifact(runtime, { kind: "config" }, renderGoalsConfig(runtime.state.runId, rewriteReturn));
        },
      });

      const sharedFiles = ["requirements.md", "goals.md", "config.md", ...review.filesWritten];

      if (review.status === "FAIL") {
        return {
          status: "FAIL",
          filesWritten: sharedFiles,
          summary: review.summary ?? "Goals review loop reached the unresolved review cap.",
          telemetry: gateNoneTelemetry(review.reviewRounds, review.dispatchFailure ? undefined : "unclean-cap"),
        };
      }

      // 3. Automated mode: skip human gate
      if (runtime.services.gates.interactionMode === "automated") {
        const route = "full" as const;
        return {
          status: "PASS",
          filesWritten: sharedFiles,
          route,
          summary: `Goals captured and approved automatically. Route: ${route}.`,
          telemetry: gateAutoApprovedTelemetry(review.reviewRounds),
        };
      }

      // 4. Human gate
      const gateResult = await runGoalsGate(runtime, review.reviewRounds, sharedFiles, gateCtx);
      if (gateResult.next === "return") return gateResult.outcome;

      // 5. Record feedback and loop back to re-synthesize
      await recordGoalsFeedback(
        runtime,
        gateResult.feedback,
        gateCtx.gateRounds,
        goalsReturn.goalsMarkdown,
        userTask,
        feedbackHistory,
      );
    }
  },
};

// ---------------------------------------------------------------------------
// Human gate helpers
// ---------------------------------------------------------------------------

async function runGoalsGate(
  runtime: StageRuntime,
  reviewRounds: number,
  filesWritten: string[],
  ctx: GoalsGateCtx,
): Promise<GoalsGateResult> {
  const goalsCtx = subStageContext(runtime);
  const presentedAt = new Date().toISOString();
  await runtime.services.telemetrySink.record({
    type: "gate.presented",
    stage: "goals",
    route: goalsCtx.route,
    summary: "Goals approval gate presented.",
  });
  const decision = await runtime.services.gates.choose(
    "Goals approval",
    [
      { value: "approve", label: "Approve goals and continue" },
      { value: "feedback", label: "Provide revision feedback" },
    ],
    `Review the goals artifact at ${artifactRelPath(runtime, { kind: "goals" })} and choose how to proceed.`,
  );
  const respondedAt = new Date().toISOString();
  ctx.gateRounds += 1;
  ctx.gateWaitTimeSeconds += secondsBetween(presentedAt, respondedAt);

  if (!decision || decision.value === "approve") {
    ctx.gateRoundDetails.push({
      round: ctx.gateRounds,
      decision: "approved",
      presented_at: presentedAt,
      responded_at: respondedAt,
    });
    await runtime.services.telemetrySink.record({
      type: "gate.approved",
      stage: "goals",
      route: goalsCtx.route,
      summary: "Goals gate approved.",
    });
    const route = "full" as const;
    return {
      next: "return",
      outcome: {
        status: "PASS",
        filesWritten,
        route,
        summary: `Goals captured and approved. Route: ${route}.`,
        telemetry: gateInteractiveTelemetry(
          reviewRounds,
          "approved",
          ctx.gateRounds - 1,
          ctx.gateWaitTimeSeconds,
          ctx.gateRoundDetails,
        ),
      },
    };
  }

  ctx.gateRoundDetails.push({
    round: ctx.gateRounds,
    decision: "rejected",
    presented_at: presentedAt,
    responded_at: respondedAt,
  });
  await runtime.services.telemetrySink.record({
    type: "gate.rejected",
    stage: "goals",
    route: goalsCtx.route,
    summary: "Goals gate rejected; requesting revision feedback.",
  });

  const feedback = await runtime.services.gates.askText(
    "Goals feedback",
    "Describe the changes needed before the goals can be approved.",
  );

  if (!feedback && runtime.services.gates.failurePolicy === "fail-closed") {
    return {
      next: "return",
      outcome: {
        status: "FAIL",
        filesWritten,
        summary: "Goals approval was rejected without actionable feedback.",
        telemetry: gateInteractiveTelemetry(
          reviewRounds,
          "rejected",
          ctx.gateRounds,
          ctx.gateWaitTimeSeconds,
          ctx.gateRoundDetails,
        ),
      },
    };
  }

  return { next: "continue", feedback };
}

async function recordGoalsFeedback(
  runtime: StageRuntime,
  feedback: string | undefined,
  gateRound: number,
  currentGoalsMarkdown: string,
  userTask: string,
  feedbackHistory: string[], // mutated: feedback block appended
): Promise<void> {
  const feedbackId = { kind: "feedbackFile" as const, name: `goals-round-${String(gateRound).padStart(2, "0")}.md` };
  const feedbackBlock = [
    `## Round ${gateRound} Feedback`,
    "",
    "### User Feedback",
    feedback?.trim() || "No additional feedback supplied.",
    "",
    "### Rejected Artifact",
    currentGoalsMarkdown.trim(),
    "",
  ].join("\n");
  await writeArtifact(runtime, feedbackId, feedbackBlock);
  feedbackHistory.push(feedbackBlock);

  const rewrittenRequirements = [
    "## Original User Task",
    userTask.trim(),
    "",
    "## User Feedback Updates",
    feedbackHistory
      .map((entry) => entry.match(/### User Feedback\n([\s\S]*?)\n\n### Rejected Artifact/)?.[1]?.trim() ?? "")
      .filter(Boolean)
      .join("\n\n"),
    "",
  ].join("\n");
  await writeArtifact(runtime, { kind: "requirements" }, rewrittenRequirements);
}

// ---------------------------------------------------------------------------
// Interview helpers
// ---------------------------------------------------------------------------

async function collectInterview(
  runtime: StageRuntime,
  userTask: string,
): Promise<{ entries: InterviewEntry[] } | { failure: string }> {
  // Seed the user-task entry, then A1 pre-pass: inferFromTask over QUESTION_SET.
  const entries: InterviewEntry[] = [{ branch: "user-task", source: "user-answer", content: userTask }];
  for (const question of QUESTION_SET) {
    const inferred = inferFromTask(userTask, question.branch);
    if (inferred) {
      entries.push({ branch: question.branch, source: "user-answer", content: inferred });
    }
  }

  const unresolved = unresolvedRequiredBranches(entries);

  // All required branches resolved by the pre-pass — done immediately.
  if (unresolved.length === 0) {
    return { entries };
  }

  // Automated mode: apply defaults in code; no agent dispatch.
  if (runtime.services.gates.interactionMode !== "interactive") {
    for (const question of unresolved) {
      if (runtime.services.gates.failurePolicy === "fail-closed" && question.required) {
        return { failure: `Goals interview could not resolve the required branch "${question.branch}".` };
      }
      entries.push({
        branch: question.branch,
        source: "automation-fallback",
        content: "Unresolved; proceed conservatively.",
      });
    }
    return { entries };
  }

  // Interactive mode: dispatch the interviewer agent to resolve remaining branches.
  const alreadyResolved = entries.filter((e) => e.branch !== "user-task");
  const prompt = buildInterviewerPrompt(runtime, userTask, alreadyResolved, unresolved);

  let interviewResult = await dispatchLeaf(runtime, "dl-goals-interviewer", prompt, {
    customTools: [runtime.services.gates.createAskHumanTool(), runtime.services.gates.createInterviewReturnTool()],
  });
  for (
    let attempt = 1;
    attempt <= MAX_TRANSIENT_DISPATCH_RETRIES && isTransientDispatchFailure(interviewResult);
    attempt++
  ) {
    interviewResult = await dispatchLeaf(runtime, "dl-goals-interviewer", prompt, {
      customTools: [runtime.services.gates.createAskHumanTool(), runtime.services.gates.createInterviewReturnTool()],
    });
  }

  const dispatchFailure = dispatchFailureSummary(interviewResult, "Goals interview failed");
  if (dispatchFailure) {
    if (runtime.services.gates.failurePolicy === "fail-closed") {
      return { failure: dispatchFailure };
    }
    // best-effort: fill remaining required branches with fallbacks
    for (const question of unresolved) {
      entries.push({
        branch: question.branch,
        source: "automation-fallback",
        content: "Unresolved; proceed conservatively.",
      });
    }
    return { entries };
  }

  const agentEntries = readInterviewReturn(interviewResult);
  if (!agentEntries) {
    if (runtime.services.gates.failurePolicy === "fail-closed") {
      return { failure: "Goals interview did not call interview_return." };
    }
    for (const question of unresolved) {
      entries.push({
        branch: question.branch,
        source: "automation-fallback",
        content: "Unresolved; proceed conservatively.",
      });
    }
    return { entries };
  }

  // Merge: pre-pass entries take precedence; agent entries fill unresolved branches.
  const merged = [...entries];
  for (const agentEntry of agentEntries) {
    if (!merged.some((e) => e.branch === agentEntry.branch)) {
      merged.push(agentEntry);
    }
  }

  // Final fail-closed check: any required branch still unresolved?
  const finalUnresolved = unresolvedRequiredBranches(merged);
  if (runtime.services.gates.failurePolicy === "fail-closed" && finalUnresolved.length > 0) {
    return {
      failure: `Interview could not resolve required branch(es): ${finalUnresolved.map((q) => q.branch).join(", ")}.`,
    };
  }

  return { entries: merged };
}

function buildInterviewerPrompt(
  runtime: StageRuntime,
  userTask: string,
  resolvedEntries: InterviewEntry[],
  unresolvedBranches: ReturnType<typeof unresolvedRequiredBranches>,
): string {
  const lines: string[] = [
    "=== RUN ID ===",
    runtime.state.runId,
    "",
    "=== USER TASK ===",
    userTask,
    "",
    "=== INTERACTION MODE ===",
    runtime.services.gates.interactionMode,
    "",
    "=== FAILURE POLICY ===",
    runtime.services.gates.failurePolicy,
    "",
  ];

  if (resolvedEntries.length > 0) {
    lines.push(
      "=== ALREADY RESOLVED BRANCHES ===",
      "These branches were pre-resolved from the task text. Do not re-ask about them.",
      renderInterviewRecord(resolvedEntries),
      "",
    );
  }

  lines.push(
    "=== UNRESOLVED BRANCHES ===",
    "These required branches need to be resolved via repo exploration and user questions:",
    ...unresolvedBranches.map((q) => `- ${q.branch}: ${q.question}`),
  );

  return lines.join("\n");
}

function goalsDispatchFailureOutcome(
  result: DispatchResult,
  label: string,
  filesWritten: string[],
  reviewRounds: number,
): StageOutcome | undefined {
  const summary = dispatchFailureSummary(result, label);
  if (!summary) {
    return undefined;
  }
  return {
    status: "FAIL",
    filesWritten,
    summary,
    telemetry: {
      review_rounds: reviewRounds,
      gate_status: "none",
      gate_rounds: 0,
      gate_wait_time_s: 0,
      gate_round_details: [],
      dispatch_end_reason: result.endReason ?? "unknown",
    },
  };
}

function renderInterviewRecord(entries: InterviewEntry[]): string {
  return entries
    .map((entry) => [`## ${entry.branch}`, `source: ${entry.source}`, entry.content.trim(), ""].join("\n"))
    .join("\n");
}

function renderGoalsConfig(runId: string, payload: GoalsReturnPayload): string {
  return [
    "---",
    `created: ${new Date().toISOString().slice(0, 10)}`,
    "route: full",
    `run_id: ${runId}`,
    ...(typeof payload.coverageThreshold === "number" ? [`coverage_threshold: ${payload.coverageThreshold}`] : []),
    ...(payload.testGlobs && payload.testGlobs.length > 0
      ? [`test_globs: [${payload.testGlobs.map((g) => `"${g}"`).join(", ")}]`]
      : []),
    "---",
    "",
  ].join("\n");
}
