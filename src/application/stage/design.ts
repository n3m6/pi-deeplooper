import { runSynthesizeReviewGate } from "../workflow/synthesize-review-gate-workflow.js";
import { readArtifact, safeReadArtifact, writeArtifact } from "./utils.js";
import type { StageModule, StageOutcome } from "../port/index.js";

export const designStage: StageModule = {
  stage: "design",
  async run(runtime): Promise<StageOutcome> {
    const goals = await readArtifact(runtime, { kind: "goals" });
    const requirements = await readArtifact(runtime, { kind: "requirements" });
    const research = await safeReadArtifact(runtime, { kind: "researchSummary" });
    // Read escalation guidance written by the pipeline loop when skeleton (or slice-loop) escalates.
    // The guidance is injected once into the synthesizer prompt so the redesign addresses the root cause.
    const escalationGuidance = await safeReadArtifact(runtime, { kind: "escalationGuidance" });

    const result = await runSynthesizeReviewGate(
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
            ...(escalationGuidance.trim()
              ? [
                  "",
                  "=== ESCALATION FEEDBACK ===",
                  "The previous implementation attempt failed. Address the following root cause in the revised design:",
                  escalationGuidance,
                ]
              : []),
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

    // Clear the escalation guidance after it has been fed into the synthesizer once, so a future
    // design re-run (e.g. from a second escalation) does not replay stale context.
    if (escalationGuidance.trim()) {
      await writeArtifact(runtime, { kind: "escalationGuidance" }, "");
    }

    return result;
  },
};
