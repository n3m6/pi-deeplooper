/**
 * Prompt-input contract tests — assert that required === ... === sections are present
 * in the prompts sent to dl-feasibility-checker, dl-done-checker, and dl-verifier.
 *
 * These prevent controller↔prompt input-contract drift from regressing silently:
 * missing sections cause agents to fabricate metadata (wrong run IDs, vacuous results).
 */

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { sliceLoopStage } from "../../src/application/stage/slice-loop.js";
import { verifyStage } from "../../src/application/stage/verify.js";
import type { DispatchRequest, DispatchResult, Dispatcher, StageOutcome } from "../../src/application/port/index.js";
import { TestHarness } from "../support/harness.js";

const harnesses: TestHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.dispose()));
});

// ---------------------------------------------------------------------------
// Prompt-recording dispatcher — routes all calls through the inner dispatcher
// while capturing every leaf prompt by agent name.
// ---------------------------------------------------------------------------

class PromptRecorder implements Dispatcher {
  readonly captured: Map<string, string[]> = new Map();

  constructor(private readonly inner: Dispatcher) {}

  private record(request: DispatchRequest): void {
    const name = request.target.name;
    if (!this.captured.has(name)) this.captured.set(name, []);
    this.captured.get(name)!.push(request.prompt);
  }

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    this.record(request);
    return this.inner.dispatch(request);
  }

  async dispatchParallel(requests: DispatchRequest[]): Promise<DispatchResult[]> {
    return Promise.all(requests.map((r) => this.dispatch(r)));
  }

  async dispatchChain(requests: DispatchRequest[]): Promise<DispatchResult[]> {
    const results: DispatchResult[] = [];
    for (const r of requests) results.push(await this.dispatch(r));
    return results;
  }

  async dispatchGenericCoding(
    prompt: string,
    options?: { cwd?: string; tools?: string[]; signal?: AbortSignal; correlationId?: string; activityLabel?: string },
  ): Promise<StageOutcome> {
    return this.inner.dispatchGenericCoding(prompt, options);
  }

  promptsFor(agentName: string): string[] {
    return this.captured.get(agentName) ?? [];
  }
}

// ---------------------------------------------------------------------------
// Shared slice-loop pre-conditions
// ---------------------------------------------------------------------------

async function writeSliceLoopArtifacts(harness: TestHarness): Promise<void> {
  await writeFile(
    harness.artifacts.goalsFile,
    "# Goals\n\n## Acceptance Criteria\n1. The endpoint returns 200 OK.\n",
    "utf8",
  );
  await writeFile(
    harness.artifacts.designFile,
    [
      "# Design",
      "",
      "## Slice Manifest",
      "",
      "```json",
      JSON.stringify(
        {
          slices: [
            {
              id: "S1",
              title: "Health Check Endpoint",
              deps: [],
              acceptanceCriteria: ["The endpoint returns 200 OK."],
            },
          ],
        },
        null,
        2,
      ),
      "```",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    harness.artifacts.structureFile,
    [
      "# Structure",
      "",
      "## File Map",
      "",
      "### Slice S1: Health Check",
      "| File | Action | Purpose |",
      "|------|--------|---------|",
      "| `src/health.ts` | CREATE | Health check handler |",
    ].join("\n"),
    "utf8",
  );
  await writeFile(harness.artifacts.skeletonResultsFile, "### Skeleton Status — CLEAN\n\nBaseline clean.\n", "utf8");
}

// ---------------------------------------------------------------------------
// Feasibility checker: prompt must carry RUN ID, PHASE DIR, TASK SPECS
// ---------------------------------------------------------------------------

test("dl-feasibility-checker prompt contains required === RUN ID ===, === PHASE DIR ===, === TASK SPECS === sections", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);
  await writeSliceLoopArtifacts(harness);

  const recorder = new PromptRecorder(harness.services.dispatcher);
  harness.completeStage("baseline", "slice-loop");
  harness.state = { ...harness.state, nextStage: "slice-loop" };

  await sliceLoopStage.run({
    ...harness.runtime(undefined, "slice-loop"),
    services: { ...harness.services, dispatcher: recorder },
  });

  const prompts = recorder.promptsFor("dl-feasibility-checker");
  assert.ok(prompts.length > 0, "dl-feasibility-checker was not dispatched");

  const prompt = prompts[0] ?? "";
  assert.match(prompt, /=== RUN ID ===/, "Missing === RUN ID === in feasibility-checker prompt");
  assert.match(prompt, /=== PHASE DIR ===/, "Missing === PHASE DIR === in feasibility-checker prompt");
  assert.match(prompt, /=== TASK SPECS ===/, "Missing === TASK SPECS === in feasibility-checker prompt");
  assert.match(prompt, /deeplooper-/, "RUN ID must begin with deeplooper-");
  assert.match(prompt, /phases\/phase-\d{2}/, "PHASE DIR must contain a zero-padded phase path");
});

// ---------------------------------------------------------------------------
// Done checker: prompt must carry RUN ID, PHASE DIR, TASK SPECS
// ---------------------------------------------------------------------------

test("dl-done-checker prompt contains required === RUN ID ===, === PHASE DIR ===, === TASK SPECS === sections", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);
  await writeSliceLoopArtifacts(harness);

  const recorder = new PromptRecorder(harness.services.dispatcher);
  harness.completeStage("baseline", "slice-loop");
  harness.state = { ...harness.state, nextStage: "slice-loop" };

  await sliceLoopStage.run({
    ...harness.runtime(undefined, "slice-loop"),
    services: { ...harness.services, dispatcher: recorder },
  });

  const prompts = recorder.promptsFor("dl-done-checker");
  assert.ok(prompts.length > 0, "dl-done-checker was not dispatched");

  const prompt = prompts[0] ?? "";
  assert.match(prompt, /=== RUN ID ===/, "Missing === RUN ID === in done-checker prompt");
  assert.match(prompt, /=== PHASE DIR ===/, "Missing === PHASE DIR === in done-checker prompt");
  assert.match(prompt, /=== TASK SPECS ===/, "Missing === TASK SPECS === in done-checker prompt");
  assert.match(prompt, /deeplooper-/, "RUN ID must begin with deeplooper-");
  assert.match(prompt, /phases\/phase-\d{2}/, "PHASE DIR must contain a zero-padded phase path");
});

// ---------------------------------------------------------------------------
// Verifier: prompt must carry PHASE REGRESSION RESULTS
// ---------------------------------------------------------------------------

test("dl-verifier prompt contains required === PHASE REGRESSION RESULTS === section", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);

  await writeFile(harness.artifacts.goalsFile, "# Goals\n\n## Acceptance Criteria\n1. Everything works.", "utf8");
  await writeFile(harness.artifacts.requirementsFile, "Build a minimal CLI.", "utf8");
  await writeFile(harness.artifacts.designFile, "# Design\n\nSimple CLI design.", "utf8");
  await writeFile(harness.artifacts.baselineResultsFile, "### Baseline Status — PASS\n\nAll checks passed.", "utf8");
  await writeFile(
    harness.artifacts.sliceQueueFile,
    [
      "# Slice Queue",
      "",
      "## S-01: Example slice",
      "status: done",
      "deps: none",
      "requeue_count: 0",
      "phase_dir: phases/phase-01",
      "source: design",
      "acceptance_criteria:",
      "  - Example passes",
    ].join("\n"),
    "utf8",
  );

  const phaseDir = path.join(harness.artifacts.phasesDir, "phase-01");
  await mkdir(phaseDir, { recursive: true });
  await writeFile(path.join(phaseDir, "done-check-results.md"), "### Done Status — PASS\n\nSlice done.", "utf8");
  await writeFile(
    path.join(phaseDir, "regression-results.md"),
    "### Regression Status — PASS\n\nAll tests passed.",
    "utf8",
  );

  const capturedPrompts: string[] = [];
  const recorder: Dispatcher = {
    async dispatch(request: DispatchRequest): Promise<DispatchResult> {
      if (request.target.name === "dl-verifier") {
        capturedPrompts.push(request.prompt);
      }
      return harness.services.dispatcher.dispatch(request);
    },
    async dispatchParallel(requests) {
      return Promise.all(requests.map((r) => this.dispatch(r)));
    },
    async dispatchChain(requests) {
      const results: DispatchResult[] = [];
      for (const r of requests) results.push(await this.dispatch(r));
      return results;
    },
    async dispatchGenericCoding(prompt, options) {
      return harness.services.dispatcher.dispatchGenericCoding(prompt, options);
    },
  };

  await verifyStage.run({
    ...harness.runtime(),
    services: { ...harness.services, dispatcher: recorder },
  });

  assert.ok(capturedPrompts.length > 0, "dl-verifier was not dispatched");
  const prompt = capturedPrompts[0] ?? "";
  assert.match(
    prompt,
    /=== PHASE REGRESSION RESULTS ===/,
    "Missing === PHASE REGRESSION RESULTS === in verifier prompt",
  );
});
