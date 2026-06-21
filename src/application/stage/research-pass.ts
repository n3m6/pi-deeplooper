import { MAX_RESEARCH_REVIEW_ROUNDS, effectiveReviewRounds } from "../../domain/run/index.js";
import { countBuiltinToolCalls, hashArtifactTexts, isNoEvidenceText } from "../../infra/pi/tool-usage.js";
import type { ArtifactId, StageRuntime } from "../port/index.js";
import {
  dispatchFailureSummary,
  dispatchLeaf,
  parseReviewStatus,
  readArtifact,
  recordAnomaly,
  subStageContext,
  writeArtifact,
} from "./utils.js";

const RESEARCH_AGENT_TIMEOUT_MS = 600_000;

/** Built-in tool names that dl-web-researcher is expected to call. */
const WEB_RESEARCHER_TOOLS = ["websearch", "webfetch"] as const;

interface ResearchQuestion {
  id: string;
  title: string;
  tag: "codebase" | "web" | "hybrid";
  block: string;
}

export interface ResearchPassResult {
  status: "PASS" | "FAIL";
  filesWritten: string[];
  reviewRounds: number;
  summary?: string;
  dispatchFailure?: boolean;
  /** True when at least one web/hybrid question's research produced no usable evidence. */
  noEvidence?: boolean;
}

type WriteResult = { ok: true; fileWritten: string; noEvidence: boolean } | { ok: false; summary: string };

export async function runResearchPassSubstage(
  runtime: StageRuntime,
  questionsMarkdown: string,
): Promise<ResearchPassResult> {
  const filesWritten: string[] = [];
  const questions = parseQuestions(questionsMarkdown);

  // Track which question IDs were flagged as no-evidence so rewrite dispatches
  // can include an explicit corrective hint.
  const noEvidenceIds = new Set<string>();

  for (const question of questions) {
    const result = await writeQuestionResearch(runtime, question);
    if (!result.ok) {
      return {
        status: "FAIL",
        filesWritten,
        reviewRounds: 0,
        summary: result.summary,
        dispatchFailure: true,
      };
    }
    filesWritten.push(result.fileWritten);
    if (result.noEvidence) {
      noEvidenceIds.add(question.id);
      await recordAnomaly(
        runtime,
        "research-no-evidence",
        "error",
        `Web researcher for ${question.id} produced no usable evidence (inert markup or no URL references with zero tool calls).`,
        { questionId: question.id, tag: question.tag },
      );
    }
  }

  // Pass artifact paths (relative to run dir) to the synthesizer agent.
  const researchArtifactList = questions
    .map((question) =>
      runtime.services.artifactRepo.relPath({ kind: "researchFile", name: `${question.id.toLowerCase()}.md` }),
    )
    .join("\n");
  const summary = await dispatchLeaf(runtime, "dl-research-synthesizer", researchArtifactList, {
    tools: ["read", "bash", "grep", "find", "ls", "write", "edit"],
    timeoutMs: RESEARCH_AGENT_TIMEOUT_MS,
  });
  const summaryFailure = dispatchFailureSummary(summary, "Research synthesis failed");
  if (summaryFailure) {
    return {
      status: "FAIL",
      filesWritten,
      reviewRounds: 0,
      summary: summaryFailure,
      dispatchFailure: true,
      ...(noEvidenceIds.size > 0 ? { noEvidence: true } : {}),
    };
  }
  if (/### Status\s+[—-]\s+FAIL\b/m.test(summary.text)) {
    return {
      status: "FAIL",
      filesWritten,
      reviewRounds: 0,
      ...(noEvidenceIds.size > 0 ? { noEvidence: true } : {}),
    };
  }
  const summaryArtifactFailure = await ensureResearchSummaryArtifact(
    runtime,
    summary.text,
    "Research synthesis failed",
  );
  if (summaryArtifactFailure) {
    return {
      status: "FAIL",
      filesWritten,
      reviewRounds: 0,
      summary: summaryArtifactFailure,
      dispatchFailure: true,
      ...(noEvidenceIds.size > 0 ? { noEvidence: true } : {}),
    };
  }

  let reviewRounds = 1;
  const researchCtx = subStageContext(runtime);
  const researchMaxRounds = effectiveReviewRounds(runtime.services.gates.reviewDepth, MAX_RESEARCH_REVIEW_ROUNDS);

  // Hash snapshot of artifacts at the start of the most recent round.
  // Used to detect when a rewrite produced no change (no-progress guard).
  // Checked after a FAIL verdict so a reviewer PASS in any round is never blocked.
  let prevRoundArtifactHash: string | undefined = undefined;

  while (reviewRounds <= researchMaxRounds) {
    await runtime.services.telemetrySink.record({
      type: "review.round.started",
      stage: "research",
      route: researchCtx.route,
      reviewRound: reviewRounds,
      maxRounds: researchMaxRounds,
    });

    const questionArtifacts = await readQuestionArtifacts(runtime, questions);
    const summaryText = await readArtifact(runtime, { kind: "researchSummary" });
    const currentHash = hashArtifactTexts([...questionArtifacts, summaryText]);

    const review = await dispatchLeaf(
      runtime,
      "dl-research-reviewer",
      [
        "=== QUESTIONS ===",
        await readArtifact(runtime, { kind: "questions" }),
        "",
        ...questionArtifacts.flatMap((artifact, index) => [
          `=== ${questions[index]?.id ?? `Q${index + 1}`} ===`,
          artifact,
          "",
        ]),
        "=== SUMMARY ===",
        summaryText,
      ].join("\n"),
      {
        tools: ["read", "bash", "grep", "find", "ls", "write", "edit"],
        timeoutMs: RESEARCH_AGENT_TIMEOUT_MS,
      },
    );
    const reviewFailure = dispatchFailureSummary(review, "Research review failed");
    if (reviewFailure) {
      await runtime.services.telemetrySink.record({
        type: "review.round.completed",
        stage: "research",
        route: researchCtx.route,
        reviewRound: reviewRounds,
        maxRounds: researchMaxRounds,
        status: "FAIL",
      });
      return {
        status: "FAIL",
        filesWritten,
        reviewRounds,
        summary: reviewFailure,
        dispatchFailure: true,
        ...(noEvidenceIds.size > 0 ? { noEvidence: true } : {}),
      };
    }

    const reviewId: ArtifactId = {
      kind: "reviewFile",
      name: `research-review-round-${String(reviewRounds).padStart(2, "0")}.md`,
    };
    await writeArtifact(runtime, reviewId, review.text);
    filesWritten.push(runtime.services.artifactRepo.relPath(reviewId));

    const researchRoundStatus = parseReviewStatus(review.text) === "PASS" ? "PASS" : "FAIL";
    await runtime.services.telemetrySink.record({
      type: "review.round.completed",
      stage: "research",
      route: researchCtx.route,
      reviewRound: reviewRounds,
      maxRounds: researchMaxRounds,
      status: researchRoundStatus,
    });

    if (researchRoundStatus === "PASS") {
      const ledger = questions.map((question) => `- ${question.id}: ${question.title} [${question.tag}]`).join("\n");
      await writeArtifact(runtime, { kind: "researchFile", name: "question-ledger.md" }, ledger);
      await writeArtifact(runtime, { kind: "researchOpenQuestions" }, "None.");
      filesWritten.push("research/question-ledger.md", "research/open-questions.md", "research/summary.md");
      return {
        status: "PASS",
        filesWritten,
        reviewRounds,
        ...(noEvidenceIds.size > 0 ? { noEvidence: true } : {}),
      };
    }

    // No-progress guard: if the reviewer FAILed AND the artifacts are identical to
    // last round's pre-review state, the rewrite had no effect — stop early.
    if (prevRoundArtifactHash !== undefined && currentHash === prevRoundArtifactHash) {
      await recordAnomaly(
        runtime,
        "review-loop-no-progress",
        "warning",
        `Research review loop stopped early at round ${reviewRounds}/${researchMaxRounds}: artifacts unchanged after rewrite.`,
        { round: reviewRounds, maxRounds: researchMaxRounds },
      );
      return {
        status: "FAIL",
        filesWritten,
        reviewRounds,
        ...(noEvidenceIds.size > 0 ? { noEvidence: true } : {}),
      };
    }
    // Capture this round's hash so the next round can detect no-progress.
    prevRoundArtifactHash = currentHash;

    if (reviewRounds === researchMaxRounds) {
      return {
        status: "FAIL",
        filesWritten,
        reviewRounds,
        ...(noEvidenceIds.size > 0 ? { noEvidence: true } : {}),
      };
    }

    const questionsToRevise = questionsReferencedByReview(review.text, questions);
    for (const question of questionsToRevise) {
      const priorNoEvidence = noEvidenceIds.has(question.id);
      const result = await writeQuestionResearch(runtime, question, review.text, priorNoEvidence);
      if (!result.ok) {
        return {
          status: "FAIL",
          filesWritten,
          reviewRounds,
          summary: result.summary,
          dispatchFailure: true,
          ...(noEvidenceIds.size > 0 ? { noEvidence: true } : {}),
        };
      }
      filesWritten.push(result.fileWritten);
      if (result.noEvidence) {
        noEvidenceIds.add(question.id);
      } else {
        // The rewrite produced real evidence — clear the flag for this question.
        noEvidenceIds.delete(question.id);
      }
    }

    const revisedSummary = await dispatchLeaf(
      runtime,
      "dl-research-synthesizer",
      buildSynthesizerRevisionPrompt(researchArtifactList, review.text, noEvidenceIds.size > 0),
      {
        tools: ["read", "bash", "grep", "find", "ls", "write", "edit"],
        timeoutMs: RESEARCH_AGENT_TIMEOUT_MS,
      },
    );
    const revisionFailure = dispatchFailureSummary(revisedSummary, "Research synthesis revision failed");
    if (revisionFailure) {
      return {
        status: "FAIL",
        filesWritten,
        reviewRounds,
        summary: revisionFailure,
        dispatchFailure: true,
        ...(noEvidenceIds.size > 0 ? { noEvidence: true } : {}),
      };
    }
    if (/### Status\s+[—-]\s+FAIL\b/m.test(revisedSummary.text)) {
      return {
        status: "FAIL",
        filesWritten,
        reviewRounds,
        ...(noEvidenceIds.size > 0 ? { noEvidence: true } : {}),
      };
    }
    const revisedSummaryArtifactFailure = await ensureResearchSummaryArtifact(
      runtime,
      revisedSummary.text,
      "Research synthesis revision failed",
    );
    if (revisedSummaryArtifactFailure) {
      return {
        status: "FAIL",
        filesWritten,
        reviewRounds,
        summary: revisedSummaryArtifactFailure,
        dispatchFailure: true,
        ...(noEvidenceIds.size > 0 ? { noEvidence: true } : {}),
      };
    }

    reviewRounds += 1;
  }

  return {
    status: "FAIL",
    filesWritten,
    reviewRounds,
    ...(noEvidenceIds.size > 0 ? { noEvidence: true } : {}),
  };
}

function parseQuestions(markdown: string): ResearchQuestion[] {
  const matches = [...markdown.matchAll(/^###\s+(Q\d+):\s+(.+)$/gm)];
  return matches.map((match, index) => {
    const id = match[1] ?? `Q${index + 1}`;
    const title = match[2]?.trim() ?? `Question ${index + 1}`;
    const nextStart = matches[index + 1]?.index;
    const block = markdown.slice(match.index ?? 0, nextStart);
    const tag = block.match(/\*\*Tag\*\*:\s*(codebase|web|hybrid)/i)?.[1]?.toLowerCase() as
      | ResearchQuestion["tag"]
      | undefined;
    return {
      id,
      title,
      tag: tag ?? "codebase",
      block,
    };
  });
}

async function writeQuestionResearch(
  runtime: StageRuntime,
  question: ResearchQuestion,
  reviewFeedback?: string,
  priorNoEvidence?: boolean,
): Promise<WriteResult> {
  const findings: string[] = [];
  let noEvidence = false;

  if (question.tag === "codebase" || question.tag === "hybrid") {
    const codebase = await dispatchLeaf(
      runtime,
      "dl-codebase-researcher",
      buildResearcherPrompt(question, reviewFeedback),
      {
        timeoutMs: RESEARCH_AGENT_TIMEOUT_MS,
      },
    );
    const codebaseFailure = dispatchFailureSummary(
      codebase,
      `${reviewFeedback ? "Codebase research revision" : "Codebase research"} failed for ${question.id}`,
    );
    if (codebaseFailure) {
      return { ok: false, summary: codebaseFailure };
    }
    findings.push(codebase.text);
  }

  if (question.tag === "web" || question.tag === "hybrid") {
    const web = await dispatchLeaf(
      runtime,
      "dl-web-researcher",
      buildResearcherPrompt(question, reviewFeedback, priorNoEvidence),
      {
        timeoutMs: RESEARCH_AGENT_TIMEOUT_MS,
      },
    );
    const webFailure = dispatchFailureSummary(
      web,
      `${reviewFeedback ? "Web research revision" : "Web research"} failed for ${question.id}`,
    );
    if (webFailure) {
      return { ok: false, summary: webFailure };
    }

    // Detect no-evidence: inert markup in the text OR no URLs in the text AND
    // zero built-in tool calls in the session transcript.
    const toolCallCount = countBuiltinToolCalls(web.messages, [...WEB_RESEARCHER_TOOLS]);
    noEvidence = isNoEvidenceText(web.text) || toolCallCount === 0;
    findings.push(web.text);
  }

  const qId: ArtifactId = { kind: "researchFile", name: `${question.id.toLowerCase()}.md` };
  await writeArtifact(runtime, qId, findings.join("\n\n"));
  return { ok: true, fileWritten: runtime.services.artifactRepo.relPath(qId), noEvidence };
}

function buildResearcherPrompt(question: ResearchQuestion, reviewFeedback?: string, priorNoEvidence?: boolean): string {
  const noEvidenceHint = priorNoEvidence
    ? [
        "IMPORTANT: Your previous research attempt produced no usable findings. Your output contained literal tool-call markup instead of actual search results, or it lacked any URL references with zero websearch/webfetch calls.",
        "You MUST call websearch or webfetch to retrieve real content. Quote actual fetched findings with source URLs before returning. Do not describe tool calls in prose.",
        "",
      ].join("\n")
    : undefined;

  return [
    noEvidenceHint,
    "=== QUESTION ===",
    question.block.trim(),
    "",
    "=== RESEARCH SCOPE ===",
    "Treat `.pipeline/`, `.git/`, `node_modules/`, and other generated or VCS metadata as out of scope unless the question explicitly asks about those directories.",
    "Honor the question's Answer shape, scope boundary, and stop condition.",
    reviewFeedback ? "" : undefined,
    reviewFeedback ? "=== REVIEW FEEDBACK ===" : undefined,
    reviewFeedback,
    reviewFeedback ? "" : undefined,
    reviewFeedback
      ? "Revise the findings for this question only. Address every reviewer finding that names this question artifact."
      : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n");
}

function buildSynthesizerRevisionPrompt(
  researchArtifactList: string,
  reviewText: string,
  hasNoEvidence: boolean,
): string {
  const parts: string[] = [researchArtifactList, "", "=== REVIEW FEEDBACK ===", reviewText, ""];
  if (hasNoEvidence) {
    parts.push(
      "NOTE: One or more per-question research artifacts may contain no usable evidence (empty or containing only literal tool-call markup). Summarize only facts explicitly present in the artifacts; do not infer or fabricate findings for empty artifacts.",
      "",
    );
  }
  parts.push(
    "Revise `research/summary.md` to address every FAIL finding. Preserve only facts supported by the per-question artifacts.",
  );
  return parts.join("\n");
}

async function readQuestionArtifacts(runtime: StageRuntime, questions: ResearchQuestion[]): Promise<string[]> {
  return Promise.all(
    questions.map(async (question) => {
      return readArtifact(runtime, { kind: "researchFile", name: `${question.id.toLowerCase()}.md` });
    }),
  );
}

async function ensureResearchSummaryArtifact(
  runtime: StageRuntime,
  synthesizerText: string,
  label: string,
): Promise<string | undefined> {
  const existing = await runtime.services.artifactRepo.read({ kind: "researchSummary" });
  if (existing !== undefined) {
    return undefined;
  }
  if (/^#\s+Research Summary\b/m.test(synthesizerText)) {
    await writeArtifact(runtime, { kind: "researchSummary" }, synthesizerText);
    return undefined;
  }
  return `${label}: synthesizer returned without writing research/summary.md.`;
}

function questionsReferencedByReview(reviewText: string, questions: ResearchQuestion[]): ResearchQuestion[] {
  const artifactFindings = extractReviewSection(reviewText, "Artifact Findings");
  const perQuestionIssues = extractReviewSection(reviewText, "Per-Question Issues");
  const normalizedPerQuestionIssues = perQuestionIssues.trim().toLowerCase();
  return questions.filter((question) => {
    const id = question.id.toLowerCase();
    const escapedId = escapeRegExp(id);
    const artifactNamePattern = `(?:research/)?${escapedId}\\.md`;
    const failedArtifactPattern = new RegExp(
      `(?:${artifactNamePattern}[^\\n|]*\\|\\s*FAIL\\b|\\bFAIL\\b[^\\n|]*${artifactNamePattern})`,
      "i",
    );
    if (failedArtifactPattern.test(artifactFindings)) {
      return true;
    }
    if (
      !normalizedPerQuestionIssues ||
      normalizedPerQuestionIssues === "none." ||
      normalizedPerQuestionIssues === "none"
    ) {
      return false;
    }
    return new RegExp(`\\b${escapedId}\\b|${artifactNamePattern}`, "i").test(perQuestionIssues);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractReviewSection(markdown: string, sectionName: string): string {
  const lines = markdown.split("\n");
  const headingPattern = new RegExp(`^#{2,3}\\s+${escapeRegExp(sectionName)}\\s*$`, "i");
  const nextHeadingPattern = /^#{2,3}\s+/;
  const start = lines.findIndex((line) => headingPattern.test(line.trim()));
  if (start === -1) {
    return "";
  }
  const body: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (nextHeadingPattern.test(lines[index]?.trim() ?? "")) {
      break;
    }
    body.push(lines[index] ?? "");
  }
  return body.join("\n");
}
