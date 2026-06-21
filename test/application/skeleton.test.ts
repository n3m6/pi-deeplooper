import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

import { skeletonStage } from "../../src/application/stage/skeleton.js";
import { SliceQueue } from "../../src/domain/slice/slice-queue.js";
import type {
  CheckpointResult,
  DispatchRequest,
  DispatchResult,
  Dispatcher,
  StageName,
  TaskWorktreeHandle,
  VersionControl,
} from "../../src/application/port/index.js";
import { TestHarness } from "../support/harness.js";
import {
  createStageReturnTool,
  normalizeStageReturn,
  type StageReturnPayload,
} from "../../src/infra/pi/stage-return-tool.js";

const harnesses: TestHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.dispose()));
});

function textResult(text: string): DispatchResult {
  return { text, messages: [], customToolCalls: [], endReason: "agent_end" };
}

// ---------------------------------------------------------------------------
// Mock VersionControl — no-ops for squash-merge, worktree, and git operations
// ---------------------------------------------------------------------------

function makeMockVersionControl(workspaceRoot: string): VersionControl {
  const fakeWorktree: TaskWorktreeHandle = {
    branch: "deeplooper/test-skeleton",
    worktreeRoot: workspaceRoot,
    taskId: "skeleton",
    phase: 0,
  };

  return {
    async createRunBranch() {},
    async checkpoint(): Promise<CheckpointResult> {
      return { ok: true };
    },
    async resolveRepoRoot() {
      return workspaceRoot;
    },
    async prepareWorktree() {
      return fakeWorktree;
    },
    async squashMerge() {
      return { ok: true };
    },
    async rebaseWorktree() {
      return { ok: true };
    },
    async continueRebase() {
      return { ok: true };
    },
    async commitWorktreeChanges() {},
    async changedFiles() {
      return [];
    },
    async changedLineCount() {
      return 0;
    },
    async listWorkspaceFiles() {
      return [];
    },
    async cleanupWorktree() {},
  };
}

// ---------------------------------------------------------------------------
// Mock Dispatcher factory for skeleton tests
// ---------------------------------------------------------------------------

type SkeletonReviewResponse = "SCAFFOLD_OK" | "OVER_IMPLEMENTATION" | "SCAFFOLD_BROKEN";

interface SkeletonDispatcherOptions {
  /** Per-round reviewer verdicts; last entry is reused if fewer than the number of rounds. */
  reviewerResponses?: SkeletonReviewResponse[];
  /** Whether each fast-impl attempt (code+test+verify) returns PASS or FAIL. */
  implStatus?: "PASS" | "FAIL";
  /** Track prompts sent to the coding worker for assertion. */
  codePrompts?: string[];
}

function makeSkeletonDispatcher(options: SkeletonDispatcherOptions = {}): Dispatcher {
  const reviewerResponses = options.reviewerResponses ?? ["SCAFFOLD_OK"];
  const implStatus = options.implStatus ?? "PASS";
  const codePrompts = options.codePrompts ?? [];
  let reviewerCall = 0;

  function buildReviewerText(cls: SkeletonReviewResponse): string {
    const ok = cls === "SCAFFOLD_OK";
    return [
      `### Status — ${ok ? "PASS" : "FAIL"}`,
      `Classification: ${cls}`,
      "",
      "### Fix Guidance",
      ok ? "None." : "Reduce src/index.ts to an empty export stub.",
      "",
      "### Summary",
      ok ? "Scaffold is correct." : "Over-implementation detected.",
    ].join("\n");
  }

  return {
    async dispatch(request: DispatchRequest): Promise<DispatchResult> {
      const name = request.target.kind === "leaf" ? request.target.name : undefined;

      if (name === "dl-skeleton-reviewer") {
        const cls = reviewerResponses[reviewerCall] ?? reviewerResponses.at(-1) ?? "SCAFFOLD_OK";
        reviewerCall += 1;
        return textResult(buildReviewerText(cls));
      }

      if (name === "dl-structure-mapper") {
        return textResult(
          "# Structure\n\n## File Map\n\n### Slice 1\n| File | Action | Purpose |\n|------|--------|---------|\n| `src/index.ts` | MODIFY | Core |\n",
        );
      }

      if (name === "dl-structure-reviewer") {
        return textResult("### Status — PASS\n\n### Summary\nStructure approved.");
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

    async dispatchGenericCoding(prompt, opts) {
      const sink: StageReturnPayload[] = [];
      const result = await this.dispatch({
        target: { kind: "generic", name: "generic-coding", tools: opts?.tools ?? [] },
        prompt,
        cwd: opts?.cwd ?? ".",
        customTools: [createStageReturnTool(sink)],
      });

      if (prompt.includes("Implement the production-code portion")) {
        codePrompts.push(prompt);
        return normalizeStageReturn({
          ...result,
          customToolCalls: [
            {
              name: "stage_return",
              result: await (
                createStageReturnTool(sink) as unknown as {
                  execute(...args: unknown[]): Promise<{ details: unknown }>;
                }
              ).execute(
                "t1",
                { status: implStatus, filesWritten: ["src/index.ts"], summary: "Code done." },
                undefined,
                undefined,
                {},
              ),
            },
          ],
        });
      }

      // test + verify + anything else → PASS
      return normalizeStageReturn({
        ...result,
        customToolCalls: [
          {
            name: "stage_return",
            result: await (
              createStageReturnTool(sink) as unknown as {
                execute(...args: unknown[]): Promise<{ details: unknown }>;
              }
            ).execute("t1", { status: "PASS", filesWritten: [], summary: "Done." }, undefined, undefined, {}),
          },
        ],
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Core artifact helpers
// ---------------------------------------------------------------------------

function tinyDesignMd(): string {
  return [
    "# Design",
    "",
    "## Overview",
    "A tiny project with one phase and one slice.",
    "",
    "## Phases",
    "",
    "### Phase 1: Foundation",
    "",
    "## Vertical Slices",
    "",
    "### S1: Core server",
    "deps: none",
    "acceptance_criteria:",
    "  - Server starts and responds to requests.",
  ].join("\n");
}

function normalDesignMd(): string {
  return [
    "# Design",
    "",
    "## Overview",
    "A multi-slice project.",
    "",
    "## Phases",
    "",
    "### Phase 1: Foundation",
    "### Phase 2: Features",
    "",
    "## Vertical Slices",
    "",
    "### S1: Auth",
    "deps: none",
    "acceptance_criteria:",
    "  - Users can log in.",
    "",
    "### S2: Dashboard",
    "deps: S1",
    "acceptance_criteria:",
    "  - Dashboard renders.",
    "",
    "### S3: Reports",
    "deps: S2",
    "acceptance_criteria:",
    "  - Reports export.",
  ].join("\n");
}

async function writeCoreArtifacts(harness: TestHarness, designMd?: string): Promise<void> {
  await writeFile(harness.artifacts.goalsFile, "# Goals\n\n## Acceptance Criteria\n1. App works.", "utf8");
  await writeFile(harness.artifacts.designFile, designMd ?? normalDesignMd(), "utf8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("skeleton stage passes with SCAFFOLD_OK on first reviewer round", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);
  await writeCoreArtifacts(harness);

  const dispatcher = makeSkeletonDispatcher({ reviewerResponses: ["SCAFFOLD_OK"] });
  const vc = makeMockVersionControl(harness.workspaceRoot);

  const result = await skeletonStage.run({
    ...harness.runtime(),
    services: { ...harness.services, dispatcher, versionControl: vc },
  });

  assert.equal(result.status, "PASS");
  assert.match(result.summary, /Skeleton built/i);
  assert.equal(result.telemetry?.child_agent_calls?.["dl-skeleton-reviewer"], 1);
});

test("skeleton stage self-corrects: OVER_IMPLEMENTATION on round 1 then SCAFFOLD_OK on round 2", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);
  await writeCoreArtifacts(harness, normalDesignMd());

  const codePrompts: string[] = [];
  const dispatcher = makeSkeletonDispatcher({
    reviewerResponses: ["OVER_IMPLEMENTATION", "SCAFFOLD_OK"],
    codePrompts,
  });
  const vc = makeMockVersionControl(harness.workspaceRoot);

  const result = await skeletonStage.run({
    ...harness.runtime(),
    services: { ...harness.services, dispatcher, versionControl: vc },
  });

  assert.equal(result.status, "PASS");
  // At least two rounds of coding occurred (initial + repair)
  assert.ok(codePrompts.length >= 2, `Expected at least 2 code prompts, got ${codePrompts.length}`);
  // The second code prompt should contain repair guidance
  const repairPrompt = codePrompts[1] ?? "";
  assert.match(repairPrompt, /REPAIR GUIDANCE/);
  assert.match(repairPrompt, /reduce.*stub/i);
  // Reviewer was called once per round (2 rounds in this scenario)
  assert.equal(result.telemetry?.child_agent_calls?.["dl-skeleton-reviewer"], 2);
});

test("skeleton stage accepts tiny over-implementation as carry-forward", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);
  await writeCoreArtifacts(harness, tinyDesignMd());

  const dispatcher = makeSkeletonDispatcher({ reviewerResponses: ["OVER_IMPLEMENTATION"] });
  const vc = makeMockVersionControl(harness.workspaceRoot);

  const result = await skeletonStage.run({
    ...harness.runtime(),
    services: { ...harness.services, dispatcher, versionControl: vc },
  });

  assert.equal(result.status, "PASS");
  assert.match(result.summary, /carry-forward/i);
  assert.equal(result.telemetry?.deterministic_fast_path, "carry-forward-tiny");

  // slice-queue.md should exist with all slices marked done
  const sliceQueueMd = await harness.services.artifactRepo.read({ kind: "sliceQueue" });
  assert.ok(sliceQueueMd, "slice-queue.md should be written for carry-forward");
  const queue = SliceQueue.parse(sliceQueueMd ?? "");
  const allDone = queue.slices.every((s) => s.status === "done");
  assert.ok(allDone, "All slices should be marked done in carry-forward path");
});

test("skeleton stage hard-fails (no backward loop) when OVER_IMPLEMENTATION exhausts all repair rounds", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);
  await writeCoreArtifacts(harness, normalDesignMd());

  // OVER_IMPLEMENTATION on every round (3 rounds max by default)
  const dispatcher = makeSkeletonDispatcher({
    reviewerResponses: ["OVER_IMPLEMENTATION", "OVER_IMPLEMENTATION", "OVER_IMPLEMENTATION"],
  });
  const vc = makeMockVersionControl(harness.workspaceRoot);

  const result = await skeletonStage.run({
    ...harness.runtime(),
    services: { ...harness.services, dispatcher, versionControl: vc },
  });

  assert.equal(result.status, "FAIL");
  // No backward loop — this is a local failure, not a design problem
  assert.equal(result.backwardLoop, undefined);
  assert.match(result.summary, /over-implementation/i);
  assert.match(result.summary, /repair/i);
});

test("skeleton stage escalates to design (LOOP_DESIGN) when SCAFFOLD_BROKEN", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);
  await writeCoreArtifacts(harness);

  const dispatcher = makeSkeletonDispatcher({ reviewerResponses: ["SCAFFOLD_BROKEN"] });
  const vc = makeMockVersionControl(harness.workspaceRoot);

  const result = await skeletonStage.run({
    ...harness.runtime(),
    services: { ...harness.services, dispatcher, versionControl: vc },
  });

  assert.equal(result.status, "FAIL");
  assert.ok(result.backwardLoop, "SCAFFOLD_BROKEN should produce a backward loop");
  assert.equal(result.backwardLoop?.classification, "LOOP_DESIGN");
  assert.match(result.summary, /design/i);
});

test("backward_loop.failed telemetry: cap reason produces cap message", async () => {
  const { domainEventToTelemetryEvent } = await import("../../src/infra/telemetry/domain-event-mapping.js");

  const event = {
    type: "backward_loop.failed" as const,
    stage: "skeleton" as StageName,
    stageInstance: 1,
    route: "full" as const,
    classification: "LOOP_DESIGN" as const,
    maxLoops: 3,
    reason: "cap" as const,
  };

  const telemetry = domainEventToTelemetryEvent(event);
  assert.ok(telemetry, "should produce a telemetry event");
  assert.match(telemetry?.summary ?? "", /cap \(3\) reached/i);
  assert.ok(!telemetry?.summary?.includes("fixed point"));
});

test("backward_loop.failed telemetry: no-progress reason produces fixed-point message", async () => {
  const { domainEventToTelemetryEvent } = await import("../../src/infra/telemetry/domain-event-mapping.js");

  const event = {
    type: "backward_loop.failed" as const,
    stage: "skeleton" as StageName,
    stageInstance: 1,
    route: "full" as const,
    classification: "LOOP_DESIGN" as const,
    maxLoops: 3,
    reason: "no-progress" as const,
  };

  const telemetry = domainEventToTelemetryEvent(event);
  assert.ok(telemetry, "should produce a telemetry event");
  assert.match(telemetry?.summary ?? "", /fixed point/i);
  assert.ok(!telemetry?.summary?.includes("cap (3)"));
});

test("fast impl loop passes repairGuidance from verify failure to next attempt", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);

  // Write a skeleton task spec
  await writeFile(harness.artifacts.skeletonTaskFile, "# Skeleton Task\n\n## Success Criteria\n- Stubs only.", "utf8");

  const capturedPrompts: string[] = [];
  let verifyCall = 0;

  const customDispatcher: Dispatcher = {
    async dispatch(_request: DispatchRequest): Promise<DispatchResult> {
      return textResult("### Status — PASS");
    },
    async dispatchParallel(requests) {
      return Promise.all(requests.map((r) => this.dispatch(r)));
    },
    async dispatchChain(requests) {
      const results: DispatchResult[] = [];
      for (const r of requests) results.push(await this.dispatch(r));
      return results;
    },
    async dispatchGenericCoding(prompt, _opts) {
      const sink: StageReturnPayload[] = [];
      const tool = createStageReturnTool(sink);
      const callTool = tool as unknown as { execute(...args: unknown[]): Promise<{ details: unknown }> };

      if (prompt.includes("Implement the production-code portion")) {
        capturedPrompts.push(prompt);
        const result = await callTool.execute(
          "t1",
          { status: "PASS", filesWritten: ["src/index.ts"], summary: "Code done." },
          undefined,
          undefined,
          {},
        );
        return normalizeStageReturn({ text: "", messages: [], customToolCalls: [{ name: "stage_return", result }] });
      }

      if (prompt.includes("Write or update only the tests")) {
        const result = await callTool.execute(
          "t1",
          { status: "PASS", filesWritten: [], summary: "Tests done." },
          undefined,
          undefined,
          {},
        );
        return normalizeStageReturn({ text: "", messages: [], customToolCalls: [{ name: "stage_return", result }] });
      }

      if (prompt.includes("Run targeted verification")) {
        verifyCall += 1;
        const status = verifyCall === 1 ? "FAIL" : "PASS";
        const result = await callTool.execute(
          "t1",
          {
            status,
            filesWritten: [],
            summary: `Verify attempt ${verifyCall}: stubs-only check ${status === "FAIL" ? "failed - found business logic" : "passed"}.`,
          },
          undefined,
          undefined,
          {},
        );
        return normalizeStageReturn({ text: "", messages: [], customToolCalls: [{ name: "stage_return", result }] });
      }

      const result = await callTool.execute(
        "t1",
        { status: "PASS", filesWritten: [], summary: "Done." },
        undefined,
        undefined,
        {},
      );
      return normalizeStageReturn({ text: "", messages: [], customToolCalls: [{ name: "stage_return", result }] });
    },
  };

  const { runFastImplLoopSubstage } = await import("../../src/application/stage/fast-impl-loop.js");

  const result = await runFastImplLoopSubstage(
    { ...harness.runtime(), services: { ...harness.services, dispatcher: customDispatcher } },
    { taskId: "skeleton", worktreeRoot: harness.workspaceRoot, taskSpecId: { kind: "skeletonTask" } },
  );

  assert.equal(result.status, "PASS");
  assert.equal(verifyCall, 2, "verify should be called twice (fail then pass)");
  // The second code prompt should include the failure from attempt 1's verify
  assert.ok(capturedPrompts.length >= 2, "code should be called twice");
  const secondCodePrompt = capturedPrompts[1] ?? "";
  assert.match(secondCodePrompt, /REPAIR GUIDANCE/);
  assert.match(secondCodePrompt, /business logic/);
});

test("isTinyProject: single phase with 1 slice is tiny", () => {
  assert.ok(SliceQueue.isTinyProject(tinyDesignMd()));
});

test("isTinyProject: multi-phase project is not tiny", () => {
  assert.ok(!SliceQueue.isTinyProject(normalDesignMd()));
});

test("isTinyProject: single phase with 3 slices is not tiny", () => {
  const bigDesign = [
    "# Design",
    "",
    "## Phases",
    "",
    "### Phase 1: All",
    "",
    "## Vertical Slices",
    "",
    "### S1: First",
    "deps: none",
    "acceptance_criteria:",
    "  - AC1",
    "",
    "### S2: Second",
    "deps: S1",
    "acceptance_criteria:",
    "  - AC2",
    "",
    "### S3: Third",
    "deps: S2",
    "acceptance_criteria:",
    "  - AC3",
  ].join("\n");
  assert.ok(!SliceQueue.isTinyProject(bigDesign));
});

test("design stage injects escalation guidance into synthesizer prompt when present", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);
  await writeFile(harness.artifacts.goalsFile, "# Goals\nBuild a CLI.", "utf8");
  await writeFile(harness.artifacts.requirementsFile, "Build a minimal CLI.", "utf8");
  await writeFile(harness.artifacts.researchSummaryFile, "# Research Summary\nNo blocking findings.", "utf8");

  // Write escalation guidance
  const guidanceText = "Do NOT include business logic in the skeleton slice.";
  await harness.services.artifactRepo.write({ kind: "escalationGuidance" }, guidanceText);

  const capturedSynthPrompts: string[] = [];
  const mockDispatcher: Dispatcher = {
    async dispatch(request: DispatchRequest): Promise<DispatchResult> {
      if (request.target.name === "dl-design-synthesizer") {
        capturedSynthPrompts.push(request.prompt);
        return textResult("# Design\n\nUse minimal patterns.");
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
    async dispatchGenericCoding() {
      return { status: "PASS" as const, filesWritten: [], summary: "" };
    },
  };

  const { designStage } = await import("../../src/application/stage/design.js");

  const result = await designStage.run({
    ...harness.runtime(),
    services: { ...harness.services, dispatcher: mockDispatcher },
  });

  assert.equal(result.status, "PASS");
  // Synthesizer prompt should contain the escalation guidance
  const synthPrompt = capturedSynthPrompts[0] ?? "";
  assert.match(synthPrompt, /ESCALATION FEEDBACK/);
  assert.match(synthPrompt, /business logic/);

  // Guidance should be cleared after consumption
  const remaining = await harness.services.artifactRepo.read({ kind: "escalationGuidance" });
  assert.ok(!remaining?.trim(), "escalation guidance should be cleared after consumption");
});
