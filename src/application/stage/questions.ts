import { normalizeNewlines } from "../../infra/codec/markdown-codec.js";
import { MAX_QUESTIONS_REVIEW_ROUNDS, effectiveReviewRounds } from "../../domain/run/index.js";
import type { LeafAgentDefinition, StageRuntime } from "../port/index.js";
import {
  dispatchFailureSummary,
  parseReviewStatus,
  readArtifact,
  readOnlyTools,
  subStageContext,
  writeArtifact,
} from "./utils.js";

export interface QuestionBatchResult {
  status: "PASS" | "FAIL";
  questionsMarkdown: string;
  filesWritten: string[];
  reviewRounds: number;
  summary?: string;
  dispatchFailure?: boolean;
}

export async function runQuestionsSubstage(runtime: StageRuntime): Promise<QuestionBatchResult> {
  const goals = await readArtifact(runtime, { kind: "goals" });
  const requirements = await readArtifact(runtime, { kind: "requirements" });
  const inventory = buildGoalInventory(goals);
  const filesWritten: string[] = [];

  await writeArtifact(runtime, { kind: "runFile", name: "goal-inventory.md" }, inventory);
  filesWritten.push("goal-inventory.md");

  let reviewRound = 1;
  let feedback = "";
  const ctx = subStageContext(runtime);
  const questionsStage = ctx.stage ?? "research";
  const questionsMaxRounds = effectiveReviewRounds(runtime.services.gates.reviewDepth, MAX_QUESTIONS_REVIEW_ROUNDS);
  while (reviewRound <= questionsMaxRounds) {
    await runtime.services.telemetrySink.record({
      type: "review.round.started",
      stage: questionsStage,
      route: ctx.route,
      reviewRound,
      maxRounds: questionsMaxRounds,
    });
    const generatorTarget = createFastQuestionTarget(runtime, "dl-question-generator");
    const signal = runtime.services.eventContext.signal;
    await runtime.services.telemetrySink.record({
      type: "dispatch.started",
      ...ctx,
      childAgent: "dl-question-generator",
    });
    const generated = await runtime.services.dispatcher.dispatch({
      target: generatorTarget,
      prompt: [
        "=== MODE ===",
        "initial",
        "",
        "=== BATCH LABEL ===",
        `round-${String(reviewRound).padStart(2, "0")}`,
        "",
        "=== GOALS ===",
        goals,
        "",
        "=== REQUIREMENTS ===",
        requirements,
        "",
        "=== NORMALIZED GOAL INVENTORY ===",
        inventory,
        feedback ? "\n=== REVIEW FEEDBACK ===" : "",
        feedback || "",
      ]
        .filter(Boolean)
        .join("\n"),
      cwd: runtime.workspaceRoot,
      ...(signal ? { signal } : {}),
      tools: readOnlyTools(generatorTarget.tools),
    });
    await runtime.services.telemetrySink.record({
      type: "dispatch.completed",
      ...ctx,
      childAgent: "dl-question-generator",
      status: generated.errorMessage ? "FAIL" : "PASS",
    });
    const generationFailure = dispatchFailureSummary(generated, "Question generation failed");
    if (generationFailure) {
      await runtime.services.telemetrySink.record({
        type: "review.round.completed",
        stage: questionsStage,
        route: ctx.route,
        reviewRound,
        maxRounds: questionsMaxRounds,
        status: "FAIL",
      });
      return {
        status: "FAIL",
        questionsMarkdown: generated.text,
        filesWritten,
        reviewRounds: reviewRound,
        summary: generationFailure,
        dispatchFailure: true,
      };
    }

    await writeArtifact(runtime, { kind: "questions" }, generated.text);

    const leakageReviewer = createFastReviewTarget(runtime, "dl-question-leakage-reviewer");
    const qualityReviewer = createFastReviewTarget(runtime, "dl-question-quality-reviewer");
    // Emit started events sequentially before parallel fan-out.
    await runtime.services.telemetrySink.record({
      type: "dispatch.started",
      ...ctx,
      childAgent: "dl-question-leakage-reviewer",
    });
    await runtime.services.telemetrySink.record({
      type: "dispatch.started",
      ...ctx,
      childAgent: "dl-question-quality-reviewer",
    });
    const reviewResults = await runtime.services.dispatcher.dispatchParallel([
      {
        target: leakageReviewer,
        prompt: [
          "=== MODE ===",
          "initial",
          "",
          "=== GOALS ===",
          goals,
          "",
          "=== REQUIREMENTS ===",
          requirements,
          "",
          "=== QUESTIONS ===",
          generated.text,
        ].join("\n"),
        cwd: runtime.workspaceRoot,
        ...(signal ? { signal } : {}),
      },
      {
        target: qualityReviewer,
        prompt: [
          "=== MODE ===",
          "initial",
          "",
          "=== GOALS ===",
          goals,
          "",
          "=== INVENTORY ===",
          inventory,
          "",
          "=== QUESTIONS ===",
          generated.text,
        ].join("\n"),
        cwd: runtime.workspaceRoot,
        ...(signal ? { signal } : {}),
      },
    ]);
    await runtime.services.telemetrySink.record({
      type: "dispatch.completed",
      ...ctx,
      childAgent: "dl-question-leakage-reviewer",
      status: reviewResults[0]?.errorMessage ? "FAIL" : "PASS",
    });
    await runtime.services.telemetrySink.record({
      type: "dispatch.completed",
      ...ctx,
      childAgent: "dl-question-quality-reviewer",
      status: reviewResults[1]?.errorMessage ? "FAIL" : "PASS",
    });
    const leakage = reviewResults[0];
    const quality = reviewResults[1];
    if (!leakage || !quality) {
      await runtime.services.telemetrySink.record({
        type: "review.round.completed",
        stage: questionsStage,
        route: ctx.route,
        reviewRound,
        maxRounds: questionsMaxRounds,
        status: "FAIL",
      });
      return {
        status: "FAIL",
        questionsMarkdown: generated.text,
        filesWritten,
        reviewRounds: reviewRound,
        summary: "Question review dispatch did not return both reviewer results.",
        dispatchFailure: true,
      };
    }

    const leakageFailure = dispatchFailureSummary(leakage, "Question leakage review failed");
    const qualityFailure = dispatchFailureSummary(quality, "Question quality review failed");
    if (leakageFailure || qualityFailure) {
      await runtime.services.telemetrySink.record({
        type: "review.round.completed",
        stage: questionsStage,
        route: ctx.route,
        reviewRound,
        maxRounds: questionsMaxRounds,
        status: "FAIL",
      });
      return {
        status: "FAIL",
        questionsMarkdown: generated.text,
        filesWritten,
        reviewRounds: reviewRound,
        summary: [leakageFailure, qualityFailure].filter(Boolean).join(" "),
        dispatchFailure: true,
      };
    }

    await writeArtifact(runtime, { kind: "runFile", name: "question-leakage-review.md" }, leakage.text);
    await writeArtifact(runtime, { kind: "runFile", name: "question-quality-review.md" }, quality.text);
    filesWritten.push("questions.md", "question-leakage-review.md", "question-quality-review.md");

    const questionsRoundStatus =
      parseReviewStatus(leakage.text) === "PASS" && parseReviewStatus(quality.text) === "PASS" ? "PASS" : "FAIL";
    await runtime.services.telemetrySink.record({
      type: "review.round.completed",
      stage: questionsStage,
      route: ctx.route,
      reviewRound,
      maxRounds: questionsMaxRounds,
      status: questionsRoundStatus,
    });

    if (questionsRoundStatus === "PASS") {
      return {
        status: "PASS",
        questionsMarkdown: generated.text,
        filesWritten,
        reviewRounds: reviewRound,
      };
    }

    feedback = ["### Leakage Review", leakage.text, "", "### Quality Review", quality.text].join("\n");
    reviewRound += 1;
  }

  return {
    status: "FAIL",
    questionsMarkdown: await readArtifact(runtime, { kind: "questions" }),
    filesWritten,
    reviewRounds: questionsMaxRounds,
  };
}

export function buildGoalInventory(goalsMarkdown: string): string {
  const sections = parseGoalSections(goalsMarkdown);
  return [
    renderInventorySection("FR", sections["Functional Requirements"]),
    renderInventorySection("NFR", sections["Non-Functional Requirements"]),
    renderInventorySection("C", sections["Constraints"]),
    renderInventorySection("AC", sections["Acceptance Criteria"], true),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function parseGoalSections(markdown: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const lines = normalizeNewlines(markdown).split("\n");
  let current: string | undefined;
  let buffer: string[] = [];

  const flush = () => {
    if (current) {
      sections[current] = buffer.join("\n").trim();
    }
    buffer = [];
  };

  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      flush();
      current = heading[1];
      continue;
    }
    if (current) {
      buffer.push(line);
    }
  }

  flush();
  return sections;
}

function renderInventorySection(prefix: string, body: string | undefined, numbered = false): string {
  if (!body) {
    return "";
  }
  const lines = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("-") || (numbered && /^\d+\./.test(line)));
  return lines.map((line, index) => `${prefix}-${index + 1}: ${line.replace(/^[-\d.\s]+/, "").trim()}`).join("\n");
}

function createFastReviewTarget(runtime: StageRuntime, agentName: string): LeafAgentDefinition {
  return createFastQuestionTarget(runtime, agentName, 8);
}

function createFastQuestionTarget(runtime: StageRuntime, agentName: string, maxTurns = 10): LeafAgentDefinition {
  const target = runtime.services.agentDefinitions.get(agentName);
  if (!target) {
    throw new Error(`Missing question-stage agent definition: ${agentName}`);
  }
  const reviewTarget: LeafAgentDefinition = {
    ...target,
    thinkingLevel: "low",
    maxTurns: Math.min(target.maxTurns, maxTurns),
  };
  delete reviewTarget.modelName;
  return reviewTarget;
}
