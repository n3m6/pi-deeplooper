import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

import { runResearchPassSubstage } from "../../src/application/stage/research-pass.js";
import type { DispatchRequest, DispatchResult, Dispatcher } from "../../src/application/port/index.js";
import type { DomainEvent } from "../../src/domain/event/index.js";
import type { RunArtifacts } from "../../src/infra/fs/artifact-repository.js";
import { TestHarness } from "../support/harness.js";

const harnesses: TestHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

test("researchers receive the full question contract and pipeline exclusions", async () => {
  const harness = await TestHarness.create();
  harnesses.push(harness);
  const dispatcher = new RecordingResearchDispatcher(harness.artifacts);
  const questionsMarkdown = renderQuestionsMarkdown();
  await writeFile(harness.artifacts.researchQuestionsFile, questionsMarkdown, "utf8");

  const result = await runResearchPassSubstage(
    {
      ...harness.runtime(),
      services: {
        ...harness.services,
        dispatcher,
      },
    },
    questionsMarkdown,
  );

  assert.equal(result.status, "PASS");
  assert.equal(dispatcher.codebasePrompts.length, 1);
  assert.deepEqual(dispatcher.codebaseTimeouts, [600_000]);
  assert.match(dispatcher.codebasePrompts[0] ?? "", /\*\*Answer shape\*\*: A bounded inventory/);
  assert.match(dispatcher.codebasePrompts[0] ?? "", /Treat `\.pipeline\/`, `\.git\/`, `node_modules\/`/);
});

test("web researchers receive a longer timeout budget", async () => {
  const harness = await TestHarness.create();
  harnesses.push(harness);
  const dispatcher = new RecordingResearchDispatcher(harness.artifacts);
  const questionsMarkdown = renderWebQuestionsMarkdown();
  await writeFile(harness.artifacts.researchQuestionsFile, questionsMarkdown, "utf8");

  const result = await runResearchPassSubstage(
    {
      ...harness.runtime(),
      services: {
        ...harness.services,
        dispatcher,
      },
    },
    questionsMarkdown,
  );

  assert.equal(result.status, "PASS");
  assert.deepEqual(dispatcher.webTimeouts, [600_000]);
  assert.deepEqual(dispatcher.synthesizerTimeouts, [600_000]);
  assert.deepEqual(dispatcher.reviewerTimeouts, [600_000]);
});

test("failed research review reruns named question artifacts before summary revision", async () => {
  const harness = await TestHarness.create();
  harnesses.push(harness);
  const dispatcher = new RecordingResearchDispatcher(harness.artifacts, { failFirstReview: true });
  const questionsMarkdown = renderQuestionsMarkdown();
  await writeFile(harness.artifacts.researchQuestionsFile, questionsMarkdown, "utf8");

  const result = await runResearchPassSubstage(
    {
      ...harness.runtime(),
      services: {
        ...harness.services,
        dispatcher,
      },
    },
    questionsMarkdown,
  );

  assert.equal(result.status, "PASS");
  assert.equal(dispatcher.codebasePrompts.length, 2);
  assert.match(dispatcher.codebasePrompts[1] ?? "", /=== REVIEW FEEDBACK ===/);
  assert.deepEqual(dispatcher.summaryRevisionTools, ["read", "bash", "grep", "find", "ls", "write", "edit"]);
});

test("summary-only research review failures do not rerun passing question artifacts", async () => {
  const harness = await TestHarness.create();
  harnesses.push(harness);
  const dispatcher = new RecordingResearchDispatcher(harness.artifacts, { failFirstReviewSummaryOnly: true });
  const questionsMarkdown = renderQuestionsMarkdown();
  await writeFile(harness.artifacts.researchQuestionsFile, questionsMarkdown, "utf8");

  const result = await runResearchPassSubstage(
    {
      ...harness.runtime(),
      services: {
        ...harness.services,
        dispatcher,
      },
    },
    questionsMarkdown,
  );

  assert.equal(result.status, "PASS");
  assert.equal(dispatcher.codebasePrompts.length, 1);
  assert.deepEqual(dispatcher.summaryRevisionTools, ["read", "bash", "grep", "find", "ls", "write", "edit"]);
});

test("research synthesis that does not write summary fails cleanly", async () => {
  const harness = await TestHarness.create();
  harnesses.push(harness);
  const dispatcher = new RecordingResearchDispatcher(harness.artifacts, { skipSummaryWrite: true });
  const questionsMarkdown = renderQuestionsMarkdown();
  await writeFile(harness.artifacts.researchQuestionsFile, questionsMarkdown, "utf8");

  const result = await runResearchPassSubstage(
    {
      ...harness.runtime(),
      services: {
        ...harness.services,
        dispatcher,
      },
    },
    questionsMarkdown,
  );

  assert.equal(result.status, "FAIL");
  assert.equal(result.dispatchFailure, true);
  assert.match(result.summary ?? "", /without writing research\/summary\.md/);
});

test("research synthesis can recover an inline summary artifact", async () => {
  const harness = await TestHarness.create();
  harnesses.push(harness);
  const dispatcher = new RecordingResearchDispatcher(harness.artifacts, { inlineSummaryOnly: true });
  const questionsMarkdown = renderQuestionsMarkdown();
  await writeFile(harness.artifacts.researchQuestionsFile, questionsMarkdown, "utf8");

  const result = await runResearchPassSubstage(
    {
      ...harness.runtime(),
      services: {
        ...harness.services,
        dispatcher,
      },
    },
    questionsMarkdown,
  );

  assert.equal(result.status, "PASS");
});

test("research review fast mode caps to 2 rounds — both FAIL produce unclean-cap with reviewRounds:2", async () => {
  const harness = await TestHarness.create({ reviewDepth: "fast" });
  harnesses.push(harness);

  const questionsMarkdown = renderQuestionsMarkdown();
  await writeFile(harness.artifacts.researchQuestionsFile, questionsMarkdown, "utf8");

  const recordedEvents: DomainEvent[] = [];
  const capturingTelemetry = {
    record: async (event: DomainEvent) => {
      recordedEvents.push(event);
    },
    regenerateRunLog: async () => {},
    regenerateMetrics: async () => {},
    readEvents: async () => [],
  };

  const result = await runResearchPassSubstage(
    {
      ...harness.runtime(),
      services: {
        ...harness.services,
        telemetrySink: capturingTelemetry,
        dispatcher: new AlwaysFailResearchDispatcher(harness.artifacts),
      },
    },
    questionsMarkdown,
  );

  assert.equal(result.status, "FAIL");
  assert.equal(result.reviewRounds, 2, "fast mode caps review to 2 rounds");

  const roundStarted = recordedEvents.filter(
    (e): e is Extract<DomainEvent, { type: "review.round.started" }> => e.type === "review.round.started",
  );
  const roundCompleted = recordedEvents.filter(
    (e): e is Extract<DomainEvent, { type: "review.round.completed" }> => e.type === "review.round.completed",
  );

  assert.equal(roundStarted.length, 2, "exactly 2 review rounds started");
  assert.equal(roundCompleted.length, 2, "exactly 2 review rounds completed");

  for (const event of [...roundStarted, ...roundCompleted]) {
    assert.equal(event.maxRounds, 2, "maxRounds should reflect the effective clamped cap");
  }
});

class AlwaysFailResearchDispatcher implements Dispatcher {
  constructor(private readonly artifacts: RunArtifacts) {}

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    switch (request.target.name) {
      case "dl-codebase-researcher":
        return textResult("## Findings for Q1\n\n### Summary\nFindings.\n");
      case "dl-research-synthesizer": {
        await writeFile(
          this.artifacts.researchSummaryFile,
          "# Research Summary\n\n## Overview\nSynthesized findings.\n",
          "utf8",
        );
        return textResult("### Status — PASS\n### Summary — Synthesized.");
      }
      case "dl-research-reviewer":
        return textResult("### Status — FAIL\n\n### Summary\nFail — needs revision.");
      default:
        return textResult("### Status — PASS\n\n### Summary\nPass.");
    }
  }

  async dispatchParallel(requests: DispatchRequest[]): Promise<DispatchResult[]> {
    return Promise.all(requests.map((r) => this.dispatch(r)));
  }

  async dispatchChain(requests: DispatchRequest[]): Promise<DispatchResult[]> {
    const results: DispatchResult[] = [];
    for (const r of requests) results.push(await this.dispatch(r));
    return results;
  }

  async dispatchGenericCoding() {
    return { status: "PASS" as const, filesWritten: [], summary: "" };
  }
}

class RecordingResearchDispatcher implements Dispatcher {
  readonly codebasePrompts: string[] = [];
  readonly codebaseTimeouts: Array<number | undefined> = [];
  readonly webTimeouts: Array<number | undefined> = [];
  readonly synthesizerTimeouts: Array<number | undefined> = [];
  readonly reviewerTimeouts: Array<number | undefined> = [];
  summaryRevisionTools: string[] | undefined;
  private reviewCalls = 0;
  private summaryCalls = 0;

  constructor(
    private readonly artifacts: RunArtifacts,
    private readonly options: {
      failFirstReview?: boolean;
      failFirstReviewSummaryOnly?: boolean;
      skipSummaryWrite?: boolean;
      inlineSummaryOnly?: boolean;
    } = {},
  ) {}

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    switch (request.target.name) {
      case "dl-codebase-researcher":
        this.codebasePrompts.push(request.prompt);
        this.codebaseTimeouts.push(request.timeoutMs);
        return textResult(
          "## Findings for Q1\n\n### Summary\nNo project markdown files exist outside ignored metadata.\n",
        );
      case "dl-web-researcher":
        this.webTimeouts.push(request.timeoutMs);
        return textResult("## Findings for Q1\n\n### Summary\nExternal reference patterns are documented.\n");
      case "dl-research-synthesizer":
        this.synthesizerTimeouts.push(request.timeoutMs);
        this.summaryCalls += 1;
        if (this.summaryCalls > 1) {
          this.summaryRevisionTools = request.tools;
        }
        if (this.options.inlineSummaryOnly) {
          return textResult("# Research Summary\n\n## Overview\nSynthesized findings.\n");
        }
        if (!this.options.skipSummaryWrite) {
          await writeFile(
            this.artifacts.researchSummaryFile,
            "# Research Summary\n\n## Overview\nSynthesized findings.\n",
            "utf8",
          );
        }
        return textResult(
          "### Status — PASS\n### Files Written — research/summary.md\n### Summary — Synthesized findings.",
        );
      case "dl-research-reviewer":
        this.reviewerTimeouts.push(request.timeoutMs);
        this.reviewCalls += 1;
        if (this.options.failFirstReviewSummaryOnly && this.reviewCalls === 1) {
          return textResult(
            [
              "### Status — FAIL",
              "",
              "### Artifact Findings",
              "| Artifact | Status | Review Area | Notes |",
              "|----------|--------|-------------|-------|",
              "| `research/q1.md` | PASS | Coverage | Complete. |",
              "| `summary.md` | FAIL | Goal-blind compliance | Prescriptive phrasing. |",
              "",
              "### Per-Question Issues",
              "None.",
              "",
              "### Synthesis Issues",
              "1. `summary.md` contains prescriptive language.",
              "",
              "### Fix Guidance",
              "Re-run the synthesizer only.",
              "",
              "### Summary",
              "FAIL — summary.md needs neutral wording.",
            ].join("\n"),
          );
        }
        if (this.options.failFirstReview && this.reviewCalls === 1) {
          return textResult(
            [
              "### Status — FAIL",
              "",
              "### Artifact Findings",
              "| Artifact | Status | Review Area | Notes |",
              "|----------|--------|-------------|-------|",
              "| `research/q1.md` | FAIL | Coverage | Missing requested scope detail |",
              "",
              "### Per-Question Issues",
              "1. `research/q1.md` needs a narrower inventory.",
              "",
              "### Synthesis Issues",
              "None.",
              "",
              "### Fix Guidance",
              "Re-run the researcher for Q1, then re-run the synthesizer.",
              "",
              "### Summary",
              "FAIL — Q1 is incomplete.",
            ].join("\n"),
          );
        }
        return textResult("### Status — PASS\n\n### Summary\nPass.");
      default:
        return textResult("### Status — PASS\n\n### Summary\nPass.");
    }
  }

  async dispatchParallel(requests: DispatchRequest[]): Promise<DispatchResult[]> {
    return Promise.all(requests.map((request) => this.dispatch(request)));
  }

  async dispatchChain(requests: DispatchRequest[]): Promise<DispatchResult[]> {
    const results: DispatchResult[] = [];
    for (const request of requests) {
      results.push(await this.dispatch(request));
    }
    return results;
  }

  async dispatchGenericCoding(_prompt: string) {
    return { status: "PASS" as const, filesWritten: [], summary: "" };
  }
}

function renderQuestionsMarkdown(): string {
  return [
    "# Research Questions",
    "",
    "### Q1: What markdown files currently exist in the repository?",
    "**Tag**: codebase",
    "**Covers**: FR-1 [markdown]",
    "**Answer shape**: A bounded inventory of markdown files outside generated metadata directories.",
    "**Decision unblocked**: Whether a new markdown file would conflict with existing project content.",
  ].join("\n");
}

function renderWebQuestionsMarkdown(): string {
  return [
    "# Research Questions",
    "",
    "### Q1: What argument-parsing approaches exist for minimal Node.js command-line tools?",
    "**Tag**: web",
    "**Covers**: FR-1 [cli]",
    "**Answer shape**: A short catalog of common options and trade-offs for minimal CLIs.",
    "**Decision unblocked**: Choose a minimal argument parsing approach.",
  ].join("\n");
}

function textResult(text: string): DispatchResult {
  return {
    text,
    messages: [{ role: "assistant", content: text }],
    customToolCalls: [],
    endReason: "agent_end",
  };
}

// ---------------------------------------------------------------------------
// No-evidence detection tests
// ---------------------------------------------------------------------------

test("web researcher emitting inert tool-call markup is flagged as no-evidence and records anomaly", async () => {
  const harness = await TestHarness.create();
  harnesses.push(harness);

  const recordedEvents: DomainEvent[] = [];
  const capturingTelemetry = {
    record: async (event: DomainEvent) => {
      recordedEvents.push(event);
    },
    regenerateRunLog: async () => {},
    regenerateMetrics: async () => {},
    readEvents: async () => [],
  };

  // The researcher returns literal <tool_call> markup — no real findings.
  const inertText = [
    "<tool_calls>",
    '<tool_call name="websearch">best tsconfig.json for node</tool_call>',
    "</tool_calls>",
  ].join("\n");

  const dispatcher = new InertWebResearcherDispatcher(harness.artifacts, inertText);
  const questionsMarkdown = renderWebQuestionsMarkdown();
  await writeFile(harness.artifacts.researchQuestionsFile, questionsMarkdown, "utf8");

  const result = await runResearchPassSubstage(
    {
      ...harness.runtime(),
      services: {
        ...harness.services,
        telemetrySink: capturingTelemetry,
        dispatcher,
      },
    },
    questionsMarkdown,
  );

  // The anomaly should be recorded even though the pipeline still proceeds (best-effort).
  const anomalies = recordedEvents.filter(
    (e): e is Extract<DomainEvent, { type: "pipeline.anomaly" }> => e.type === "pipeline.anomaly",
  );
  assert.ok(
    anomalies.some((e) => e.code === "research-no-evidence"),
    "expected a research-no-evidence anomaly event",
  );

  // noEvidence flag must be set on the result.
  assert.equal(result.noEvidence, true, "result.noEvidence should be true when researcher emits inert markup");

  // Under best-effort the run proceeds; result should not be a hard dispatch failure.
  assert.equal(result.dispatchFailure, undefined);
});

test("web researcher returning no URLs and no sentinel is flagged as no-evidence", async () => {
  const harness = await TestHarness.create();
  harnesses.push(harness);

  const recordedEvents: DomainEvent[] = [];
  const capturingTelemetry = {
    record: async (event: DomainEvent) => {
      recordedEvents.push(event);
    },
    regenerateRunLog: async () => {},
    regenerateMetrics: async () => {},
    readEvents: async () => [],
  };

  // No URLs, no sentinel, no tool calls in messages.
  const emptyText = "Some notes about argument parsing but no citations.";

  const dispatcher = new InertWebResearcherDispatcher(harness.artifacts, emptyText);
  const questionsMarkdown = renderWebQuestionsMarkdown();
  await writeFile(harness.artifacts.researchQuestionsFile, questionsMarkdown, "utf8");

  const result = await runResearchPassSubstage(
    {
      ...harness.runtime(),
      services: {
        ...harness.services,
        telemetrySink: capturingTelemetry,
        dispatcher,
      },
    },
    questionsMarkdown,
  );

  const anomalies = recordedEvents.filter(
    (e): e is Extract<DomainEvent, { type: "pipeline.anomaly" }> => e.type === "pipeline.anomaly",
  );
  assert.ok(
    anomalies.some((e) => e.code === "research-no-evidence"),
    "expected a research-no-evidence anomaly for text with no URL and no sentinel",
  );
  assert.equal(result.noEvidence, true);
});

test("no-evidence hint is prepended to the researcher prompt on rewrite", async () => {
  const harness = await TestHarness.create();
  harnesses.push(harness);

  const inertText = [
    "<tool_calls>",
    '<tool_call name="websearch">best tsconfig.json for node</tool_call>',
    "</tool_calls>",
  ].join("\n");

  const trackingDispatcher = new TrackingInertWebResearcherDispatcher(harness.artifacts, inertText);
  const questionsMarkdown = renderWebQuestionsMarkdown();
  await writeFile(harness.artifacts.researchQuestionsFile, questionsMarkdown, "utf8");

  await runResearchPassSubstage(
    {
      ...harness.runtime(),
      services: {
        ...harness.services,
        dispatcher: trackingDispatcher,
      },
    },
    questionsMarkdown,
  );

  // After a FAIL review, the researcher is dispatched again. The rewrite prompt
  // should contain the explicit no-evidence corrective hint.
  assert.ok(
    trackingDispatcher.webPrompts.length >= 2,
    "researcher should be dispatched at least twice (initial + rewrite)",
  );
  const rewritePrompt = trackingDispatcher.webPrompts[1] ?? "";
  assert.match(
    rewritePrompt,
    /IMPORTANT: Your previous research attempt produced no usable findings/,
    "rewrite prompt should include the no-evidence corrective hint",
  );
});

// ---------------------------------------------------------------------------
// No-progress guard test
// ---------------------------------------------------------------------------

test("review loop stops early and records review-loop-no-progress when artifacts are unchanged across rounds", async () => {
  const harness = await TestHarness.create();
  harnesses.push(harness);

  const recordedEvents: DomainEvent[] = [];
  const capturingTelemetry = {
    record: async (event: DomainEvent) => {
      recordedEvents.push(event);
    },
    regenerateRunLog: async () => {},
    regenerateMetrics: async () => {},
    readEvents: async () => [],
  };

  // Dispatcher: researcher produces real content, but reviewer always FAILs,
  // and the rewrite researcher returns the *same* content each time so the
  // artifact hash never changes across rounds.
  const dispatcher = new StaleRewriteResearchDispatcher(harness.artifacts);
  const questionsMarkdown = renderQuestionsMarkdown();
  await writeFile(harness.artifacts.researchQuestionsFile, questionsMarkdown, "utf8");

  const result = await runResearchPassSubstage(
    {
      ...harness.runtime(),
      services: {
        ...harness.services,
        telemetrySink: capturingTelemetry,
        dispatcher,
      },
    },
    questionsMarkdown,
  );

  assert.equal(result.status, "FAIL");

  const anomalies = recordedEvents.filter(
    (e): e is Extract<DomainEvent, { type: "pipeline.anomaly" }> => e.type === "pipeline.anomaly",
  );
  assert.ok(
    anomalies.some((e) => e.code === "review-loop-no-progress"),
    "expected a review-loop-no-progress anomaly",
  );

  // Should stop after round 2 (round 1 sets the baseline, round 2 detects no change).
  // With thorough mode (max 3 rounds), stopping at round 2 means fewer than max rounds.
  assert.ok(result.reviewRounds < 3, `loop should stop before the 3-round cap; got ${result.reviewRounds}`);
});

// ---------------------------------------------------------------------------
// Supporting dispatchers for the new tests
// ---------------------------------------------------------------------------

/** Dispatcher where dl-web-researcher always returns the provided inert/empty text. */
class InertWebResearcherDispatcher implements Dispatcher {
  constructor(
    private readonly artifacts: RunArtifacts,
    private readonly inertText: string,
  ) {}

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    switch (request.target.name) {
      case "dl-web-researcher":
        // Return inert text with no tool_use entries in messages.
        return {
          text: this.inertText,
          messages: [{ role: "assistant", content: this.inertText }],
          customToolCalls: [],
          endReason: "agent_end",
        };
      case "dl-research-synthesizer": {
        await writeFile(
          this.artifacts.researchSummaryFile,
          "# Research Summary\n\n## Overview\nNo evidence available.\n",
          "utf8",
        );
        return textResult("### Status — PASS\n### Summary — Synthesized (empty).");
      }
      case "dl-research-reviewer":
        return textResult("### Status — PASS\n\n### Summary\nPass.");
      default:
        return textResult("### Status — PASS\n\n### Summary\nPass.");
    }
  }

  async dispatchParallel(requests: DispatchRequest[]): Promise<DispatchResult[]> {
    return Promise.all(requests.map((r) => this.dispatch(r)));
  }

  async dispatchChain(requests: DispatchRequest[]): Promise<DispatchResult[]> {
    const results: DispatchResult[] = [];
    for (const r of requests) results.push(await this.dispatch(r));
    return results;
  }

  async dispatchGenericCoding() {
    return { status: "PASS" as const, filesWritten: [], summary: "" };
  }
}

/** Like InertWebResearcherDispatcher but tracks all web researcher prompts for assertion. */
class TrackingInertWebResearcherDispatcher extends InertWebResearcherDispatcher {
  readonly webPrompts: string[] = [];
  private reviewCount = 0;

  override async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    if (request.target.name === "dl-web-researcher") {
      this.webPrompts.push(request.prompt);
    }
    if (request.target.name === "dl-research-reviewer") {
      this.reviewCount += 1;
      if (this.reviewCount === 1) {
        // Fail the first review so the rewrite path is exercised.
        return textResult(
          [
            "### Status — FAIL",
            "",
            "### Artifact Findings",
            "| Artifact | Status | Review Area | Notes |",
            "|----------|--------|-------------|-------|",
            "| `research/q1.md` | FAIL | Coverage | No real findings. |",
            "",
            "### Per-Question Issues",
            "1. Q1 artifact is empty of factual findings.",
            "",
            "### Summary",
            "FAIL — Q1 needs real research.",
          ].join("\n"),
        );
      }
    }
    return super.dispatch(request);
  }
}

/** Dispatcher where the reviewer always FAILs and rewrites produce identical artifacts. */
class StaleRewriteResearchDispatcher implements Dispatcher {
  private static readonly STABLE_FINDINGS =
    "## Findings for Q1\n\n### Summary\nStable findings (unchanged).\n\n### References\n- `src/example.ts:1` — reference.\n";

  constructor(private readonly artifacts: RunArtifacts) {}

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    switch (request.target.name) {
      case "dl-codebase-researcher":
        return textResult(StaleRewriteResearchDispatcher.STABLE_FINDINGS);
      case "dl-research-synthesizer": {
        await writeFile(
          this.artifacts.researchSummaryFile,
          "# Research Summary\n\n## Overview\nStable summary.\n",
          "utf8",
        );
        return textResult("### Status — PASS\n### Summary — Stable.");
      }
      case "dl-research-reviewer":
        return textResult(
          [
            "### Status — FAIL",
            "",
            "### Artifact Findings",
            "| Artifact | Status | Review Area | Notes |",
            "|----------|--------|-------------|-------|",
            "| `research/q1.md` | FAIL | Coverage | Needs more detail. |",
            "",
            "### Per-Question Issues",
            "1. Q1 needs narrower scope.",
            "",
            "### Summary",
            "FAIL — Q1 incomplete.",
          ].join("\n"),
        );
      default:
        return textResult("### Status — PASS\n\n### Summary\nPass.");
    }
  }

  async dispatchParallel(requests: DispatchRequest[]): Promise<DispatchResult[]> {
    return Promise.all(requests.map((r) => this.dispatch(r)));
  }

  async dispatchChain(requests: DispatchRequest[]): Promise<DispatchResult[]> {
    const results: DispatchResult[] = [];
    for (const r of requests) results.push(await this.dispatch(r));
    return results;
  }

  async dispatchGenericCoding() {
    return { status: "PASS" as const, filesWritten: [], summary: "" };
  }
}
