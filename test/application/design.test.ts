import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

import { designStage } from "../../src/application/stage/design.js";
import type { DispatchRequest, DispatchResult, Dispatcher } from "../../src/application/port/index.js";
import { TestHarness } from "../support/harness.js";
import { ScriptedGateManager } from "../support/scripted-gates.js";

const harnesses: TestHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.dispose()));
});

function textResult(text: string): DispatchResult {
  return { text, messages: [], customToolCalls: [], endReason: "agent_end" };
}

async function writeCoreArtifacts(harness: TestHarness): Promise<void> {
  await writeFile(harness.artifacts.requirementsFile, "Build a minimal CLI.", "utf8");
  await writeFile(harness.artifacts.goalsFile, "# Goals\n\n## Acceptance Criteria\n1. CLI exists.", "utf8");
  await writeFile(harness.artifacts.researchSummaryFile, "# Research Summary\n\nNo blocking findings.", "utf8");
}

function makeDesignDispatcher(options: { reviewResponses?: string[]; synthesisText?: string }): Dispatcher {
  let reviewCall = 0;
  const reviewResponses = options.reviewResponses ?? ["### Status — PASS\n\n### Summary\nPass."];
  const synthesisText = options.synthesisText ?? "# Design\n\nUse existing patterns.";

  return {
    async dispatch(request: DispatchRequest): Promise<DispatchResult> {
      if (request.target.name === "dl-design-synthesizer") {
        return textResult(synthesisText);
      }
      if (request.target.name === "dl-design-reviewer") {
        const response =
          reviewResponses[reviewCall] ?? reviewResponses.at(-1) ?? "### Status — PASS\n\n### Summary\nPass.";
        reviewCall += 1;
        return textResult(response);
      }
      return textResult("### Status — PASS\n\n### Summary\nPass.");
    },
    async dispatchParallel(requests) {
      return Promise.all(requests.map((r) => this.dispatch(r)));
    },
    async dispatchChain(requests) {
      const results: DispatchResult[] = [];
      for (const r of requests) results.push(await this.dispatch(r));
      return results;
    },
    async dispatchGenericCoding(_prompt) {
      return { status: "PASS" as const, filesWritten: [], summary: "" };
    },
  };
}

test("design stage passes and auto-approves in automated mode", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);
  await writeCoreArtifacts(harness);

  const result = await designStage.run({
    ...harness.runtime(),
    services: {
      ...harness.services,
      dispatcher: makeDesignDispatcher({}),
    },
  });

  assert.equal(result.status, "PASS");
  assert.equal(result.telemetry?.gate_status, "approved");
  assert.equal(result.telemetry?.gate_mode, "automated");
  assert.equal(result.telemetry?.terminal_review_state, "clean");
});

test("design stage returns unclean-cap when reviewer fails for 5 rounds", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);
  await writeCoreArtifacts(harness);

  const failResponse = "### Status — FAIL\n\n### Fix Guidance\nRevise the architecture section.";
  const dispatcher = makeDesignDispatcher({
    reviewResponses: Array(6).fill(failResponse),
  });

  const result = await designStage.run({
    ...harness.runtime(),
    services: { ...harness.services, dispatcher },
  });

  assert.equal(result.status, "FAIL");
  assert.equal(result.telemetry?.terminal_review_state, "unclean-cap");
  assert.equal(result.telemetry?.gate_status, "none");
  assert.ok((result.telemetry?.review_rounds as number) >= 5);
});

test("design stage retries synthesis when reviewer fails then passes", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);
  await writeCoreArtifacts(harness);

  const dispatcher = makeDesignDispatcher({
    reviewResponses: [
      "### Status — FAIL\n\n### Fix Guidance\nNeed more detail.",
      "### Status — PASS\n\n### Summary\nLooks good now.",
    ],
  });

  const result = await designStage.run({
    ...harness.runtime(),
    services: { ...harness.services, dispatcher },
  });

  assert.equal(result.status, "PASS");
  assert.equal(result.telemetry?.review_rounds, 2);
});

test("design stage passes in interactive mode when user approves", async () => {
  const harness = await TestHarness.create({ route: "full", interactionMode: "interactive" });
  harnesses.push(harness);
  await writeCoreArtifacts(harness);

  const gates = new ScriptedGateManager({ interactionMode: "interactive", failurePolicy: "best-effort" }, [
    { method: "choose", value: { value: "approve" } },
  ]);

  const result = await designStage.run({
    ...harness.runtime(),
    services: {
      ...harness.services,
      gates,
      dispatcher: makeDesignDispatcher({}),
    },
  });

  assert.equal(result.status, "PASS");
  assert.equal(result.telemetry?.gate_status, "approved");
  assert.equal(result.telemetry?.gate_mode, "interactive");
  assert.ok(gates.calls.some((c) => c.method === "choose"));
});

test("design stage re-synthesizes when user provides feedback then approves", async () => {
  const harness = await TestHarness.create({ route: "full", interactionMode: "interactive" });
  harnesses.push(harness);
  await writeCoreArtifacts(harness);

  const gates = new ScriptedGateManager({ interactionMode: "interactive", failurePolicy: "best-effort" }, [
    { method: "choose", value: { value: "feedback" } },
    { method: "askText", value: "Please add error handling section." },
    { method: "choose", value: { value: "approve" } },
  ]);

  let synthesisCallCount = 0;
  const dispatcher: Dispatcher = {
    async dispatch(request: DispatchRequest): Promise<DispatchResult> {
      if (request.target.name === "dl-design-synthesizer") {
        synthesisCallCount += 1;
        return textResult("# Design\n\nRevised design.");
      }
      if (request.target.name === "dl-design-reviewer") {
        return textResult("### Status — PASS\n\n### Summary\nPass.");
      }
      return textResult("### Status — PASS\n\n### Summary\nPass.");
    },
    async dispatchParallel(requests) {
      return Promise.all(requests.map((r) => this.dispatch(r)));
    },
    async dispatchChain(requests) {
      const results: DispatchResult[] = [];
      for (const r of requests) results.push(await this.dispatch(r));
      return results;
    },
    async dispatchGenericCoding(_prompt) {
      return { status: "PASS" as const, filesWritten: [], summary: "" };
    },
  };

  const result = await designStage.run({
    ...harness.runtime(),
    services: { ...harness.services, gates, dispatcher },
  });

  assert.equal(result.status, "PASS");
  // synthesizer called at least twice (initial + after feedback)
  assert.ok(synthesisCallCount >= 2);
});

test("design stage fails in interactive fail-closed mode when user rejects without feedback", async () => {
  const harness = await TestHarness.create({
    route: "full",
    interactionMode: "interactive",
    failurePolicy: "fail-closed",
  });
  harnesses.push(harness);
  await writeCoreArtifacts(harness);

  const gates = new ScriptedGateManager({ interactionMode: "interactive", failurePolicy: "fail-closed" }, [
    { method: "choose", value: { value: "feedback" } },
    { method: "askText", value: undefined }, // empty feedback
  ]);

  const result = await designStage.run({
    ...harness.runtime(),
    services: {
      ...harness.services,
      gates,
      dispatcher: makeDesignDispatcher({}),
    },
  });

  assert.equal(result.status, "FAIL");
  assert.equal(result.telemetry?.gate_status, "rejected");
});
