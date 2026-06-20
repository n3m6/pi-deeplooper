import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

import { buildGoalInventory } from "../../src/application/stage/questions.js";
import { runQuestionsSubstage } from "../../src/application/stage/questions.js";
import type { DispatchRequest, DispatchResult, Dispatcher } from "../../src/application/port/index.js";
import { TestHarness } from "../support/harness.js";

const harnesses: TestHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

test("buildGoalInventory extracts requirements from Goals h2 sections", () => {
  const inventory = buildGoalInventory(
    [
      "# Goals",
      "",
      "## Functional Requirements",
      "- A file named `SMOKE.md` exists in the project root.",
      "- The file contains exactly one sentence: `Deeplooper smoke test.`",
      "",
      "## Non-Functional Requirements",
      "None specified.",
      "",
      "## Constraints",
      "None specified.",
      "",
      "## Acceptance Criteria",
      "1. `SMOKE.md` exists in the project root.",
      "2. The content of `SMOKE.md` is exactly `Deeplooper smoke test.`",
    ].join("\n"),
  );

  assert.match(inventory, /FR-1: A file named `SMOKE\.md` exists in the project root\./);
  assert.match(inventory, /FR-2: The file contains exactly one sentence: `Deeplooper smoke test\.`/);
  assert.match(inventory, /AC-1: `SMOKE\.md` exists in the project root\./);
  assert.match(inventory, /AC-2: The content of `SMOKE\.md` is exactly `Deeplooper smoke test\.`/);
});

test("question reviewers receive initial context with fast review targets", async () => {
  const harness = await TestHarness.create();
  harnesses.push(harness);
  const dispatcher = new RecordingQuestionDispatcher();
  await writeFile(
    harness.artifacts.goalsFile,
    [
      "# Goals",
      "",
      "## Functional Requirements",
      "- Create a file named `SMOKE.md` at the repository root.",
      "",
      "## Non-Functional Requirements",
      "None specified.",
      "",
      "## Constraints",
      "None specified.",
      "",
      "## Acceptance Criteria",
      "1. `SMOKE.md` exists in the repository root.",
    ].join("\n"),
    "utf8",
  );
  await writeFile(harness.artifacts.requirementsFile, "create a SMOKE.md file\n", "utf8");

  const result = await runQuestionsSubstage({
    ...harness.runtime(),
    services: {
      ...harness.services,
      dispatcher,
    },
  });

  assert.equal(result.status, "PASS");
  const leakageRequest = dispatcher.requests.find((request) => request.target.name === "dl-question-leakage-reviewer");
  const qualityRequest = dispatcher.requests.find((request) => request.target.name === "dl-question-quality-reviewer");
  const generatorRequest = dispatcher.requests.find((request) => request.target.name === "dl-question-generator");
  assert.ok(generatorRequest);
  assert.ok(leakageRequest);
  assert.ok(qualityRequest);
  assert.equal(generatorRequest.target.kind, "leaf");
  assert.equal(generatorRequest.target.modelName, undefined);
  assert.equal(generatorRequest.target.thinkingLevel, "low");
  assert.deepEqual(generatorRequest.tools, ["read", "bash", "grep", "find", "ls"]);
  assert.match(leakageRequest.prompt, /=== GOALS ===/);
  assert.match(leakageRequest.prompt, /=== REQUIREMENTS ===/);
  assert.equal(leakageRequest.target.kind, "leaf");
  assert.equal(leakageRequest.target.modelName, undefined);
  assert.equal(leakageRequest.target.thinkingLevel, "low");
  assert.equal(qualityRequest.target.kind, "leaf");
  assert.equal(qualityRequest.target.modelName, undefined);
  assert.equal(qualityRequest.target.thinkingLevel, "low");
});

class RecordingQuestionDispatcher implements Dispatcher {
  readonly requests: DispatchRequest[] = [];

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    this.requests.push(request);
    if (request.target.name === "dl-question-generator") {
      return textResult(
        [
          "# Research Questions",
          "",
          "### Q1: What files currently exist at the repository root?",
          "**Tag**: codebase",
          "**Covers**: FR-1 [file creation]; AC-1 [file existence]",
          "**Answer shape**: A root-level inventory with a stop condition after all entries are listed.",
          "**Decision unblocked**: Whether a new root-level file would conflict with current project content.",
        ].join("\n"),
      );
    }
    return textResult("### Status — PASS\n\n### Summary\nPass.");
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

function textResult(text: string): DispatchResult {
  return {
    text,
    messages: [{ role: "assistant", content: text }],
    customToolCalls: [],
    endReason: "agent_end",
  };
}
