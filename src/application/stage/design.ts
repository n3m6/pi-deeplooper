import { runSynthesizeReviewGate } from "../workflow/synthesize-review-gate-workflow.js";
import { readArtifact } from "./utils.js";
import type { StageModule, StageOutcome } from "../port/index.js";

export const designStage: StageModule = {
  stage: "design",
  async run(runtime): Promise<StageOutcome> {
    const goals = await readArtifact(runtime, { kind: "goals" });
    const requirements = await readArtifact(runtime, { kind: "requirements" });
    const research = await readArtifact(runtime, { kind: "researchSummary" });

    return runSynthesizeReviewGate(
      runtime,
      {
        stageName: "design",
        synthesizerAgent: "dl-design-synthesizer",
        reviewerAgent: "dl-design-reviewer",
        artifactId: { kind: "design" },
        artifactDisplayName: "design.md",
        approveLabel: "Approve design",
        feedbackLabel: "Provide design feedback",
        feedbackQuestion: "Describe the required design revisions.",
        buildSynthesizerPrompt: (ctx, feedbackHistory) =>
          [
            "=== GOALS ===",
            goals,
            "",
            "=== REQUIREMENTS ===",
            requirements,
            "",
            "=== RESEARCH SUMMARY ===",
            research,
            ...(typeof ctx["designDiscussion"] === "string"
              ? ["", "=== DESIGN DISCUSSION ===", ctx["designDiscussion"]]
              : []),
            ...(feedbackHistory.length > 0 ? ["\n=== FEEDBACK HISTORY ===", feedbackHistory.join("\n\n")] : []),
          ]
            .filter(Boolean)
            .join("\n"),
        buildReviewerPrompt: (_ctx, artifactText) =>
          [
            "=== GOALS ===",
            goals,
            "",
            "=== REQUIREMENTS ===",
            requirements,
            "",
            "=== RESEARCH SUMMARY ===",
            research,
            "",
            "=== DESIGN ===",
            artifactText,
          ].join("\n"),
      },
      { runtime },
    );
  },
};
