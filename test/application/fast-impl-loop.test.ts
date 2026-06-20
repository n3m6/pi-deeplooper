import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { runFastImplLoopSubstage } from "../../src/application/stage/fast-impl-loop.js";
import type {
  CustomToolResult,
  DispatchRequest,
  DispatchResult,
  Dispatcher,
} from "../../src/application/port/index.js";
import {
  createStageReturnTool,
  normalizeStageReturn,
  type StageReturnPayload,
} from "../../src/infra/pi/stage-return-tool.js";
import { TestHarness } from "../support/harness.js";

const harnesses: TestHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.dispose()));
});

function textResult(text: string): DispatchResult {
  return { text, messages: [], customToolCalls: [], endReason: "agent_end" };
}

async function stageReturnResult(request: DispatchRequest, payload: Record<string, unknown>): Promise<DispatchResult> {
  const tool = request.customTools?.find((t) => t.name === "stage_return");
  if (!tool) return { text: "", messages: [], customToolCalls: [] };
  const callTool = tool as unknown as { execute(...args: unknown[]): Promise<CustomToolResult> };
  const result = await callTool.execute("tool-1", payload, undefined, undefined, {});
  return { text: "", messages: [], customToolCalls: [{ name: "stage_return", result }] };
}

async function writeTaskSpec(harness: TestHarness, taskNumber = "01"): Promise<void> {
  const tasksDir = path.join(harness.artifacts.phasesDir, "phase-01", "tasks");
  await mkdir(tasksDir, { recursive: true });
  await writeFile(
    path.join(tasksDir, `task-${taskNumber}.md`),
    `# Task ${taskNumber}: Example\n\n## Metadata\n- **Task:** ${taskNumber}\n- **Phase:** 1\n- **Route:** full\n\n## Files\n- \`src/example.ts\` (MODIFY)\n`,
    "utf8",
  );
}

type StepBehavior = "PASS" | "FAIL";

function makeLoopDispatcher(options: {
  codeAttempts?: StepBehavior[];
  testAttempts?: StepBehavior[];
  verifyAttempts?: StepBehavior[];
  reviewAttempts?: StepBehavior[];
}): Dispatcher & { calls: string[] } {
  let codeCall = 0;
  let testCall = 0;
  let verifyCall = 0;
  let reviewCall = 0;

  const codeAttempts = options.codeAttempts ?? ["PASS"];
  const testAttempts = options.testAttempts ?? ["PASS"];
  const verifyAttempts = options.verifyAttempts ?? ["PASS"];
  const reviewAttempts = options.reviewAttempts ?? ["PASS"];
  const calls: string[] = [];

  return {
    calls,
    async dispatch(request: DispatchRequest): Promise<DispatchResult> {
      const prompt = request.prompt;

      if (request.target.kind === "generic") {
        if (prompt.includes("Implement the production-code portion")) {
          calls.push("code");
          const behavior = codeAttempts[codeCall] ?? "PASS";
          codeCall += 1;
          return stageReturnResult(request, {
            status: behavior,
            filesWritten: behavior === "PASS" ? ["src/example.ts"] : [],
            summary: behavior === "PASS" ? "Code done." : "Code failed.",
            telemetry: { code_wrote: true },
          });
        }
        if (prompt.includes("Write or update only the tests needed")) {
          calls.push("test");
          const behavior = testAttempts[testCall] ?? "PASS";
          testCall += 1;
          return stageReturnResult(request, {
            status: behavior,
            filesWritten: behavior === "PASS" ? ["test/example.test.ts"] : [],
            summary: behavior === "PASS" ? "Tests done." : "Tests failed.",
            telemetry: {
              evidence_quality: {
                deterministic: 1,
                flaky: 0,
                harnessNoisy: 0,
                ambiguous: 0,
                redundant: 0,
                noTestTasks: 0,
                noTestAuditOverrides: 0,
              },
            },
          });
        }
        if (prompt.includes("Run targeted verification")) {
          calls.push("verify");
          const behavior = verifyAttempts[verifyCall] ?? "PASS";
          verifyCall += 1;
          return stageReturnResult(request, {
            status: behavior,
            filesWritten: [],
            summary: behavior === "PASS" ? "Verify done." : "Verify failed.",
            telemetry: { verify_ran: true },
          });
        }
        return stageReturnResult(request, { status: "PASS", filesWritten: [], summary: "Generic done." });
      }

      // Code review leaf agents
      if (request.target.name?.startsWith("dl-review-")) {
        calls.push(`review:${request.target.name}`);
        const behavior = reviewAttempts[reviewCall] ?? "PASS";
        reviewCall += 1;
        const status = behavior === "PASS" ? "PASS" : "FAIL";
        return textResult(
          `### Status — ${status}\n\n### Findings\n${status === "FAIL" ? "| 1 | HIGH | file | 1 | bug | issue | fix |" : "None."}`,
        );
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
    async dispatchGenericCoding(prompt, options) {
      const sink: StageReturnPayload[] = [];
      const result = await this.dispatch({
        target: { kind: "generic", name: "generic-coding", tools: options?.tools ?? [], thinkingLevel: "high" },
        prompt,
        cwd: options?.cwd ?? ".",
        customTools: [createStageReturnTool(sink)],
      });
      return normalizeStageReturn(result);
    },
  };
}

test("fast impl loop returns PASS when all steps succeed on attempt 1", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);
  await writeTaskSpec(harness);
  const dispatcher = makeLoopDispatcher({});

  const result = await runFastImplLoopSubstage(
    { ...harness.runtime(), services: { ...harness.services, dispatcher } },
    { taskId: "01", worktreeRoot: harness.workspaceRoot, taskSpecId: { kind: "taskSpec", phase: 1, taskId: "01" } },
  );

  assert.equal(result.status, "PASS");
  assert.deepEqual(dispatcher.calls.slice(0, 3), ["code", "test", "verify"]);
  assert.match(result.summary, /passed/i);
});

test("fast impl loop short-circuits on code FAIL without running test or verify", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);
  await writeTaskSpec(harness);
  const dispatcher = makeLoopDispatcher({ codeAttempts: ["FAIL"] });

  const result = await runFastImplLoopSubstage(
    { ...harness.runtime(), services: { ...harness.services, dispatcher } },
    { taskId: "01", worktreeRoot: harness.workspaceRoot, taskSpecId: { kind: "taskSpec", phase: 1, taskId: "01" } },
  );

  assert.equal(result.status, "FAIL");
  assert.ok(!dispatcher.calls.includes("test"));
  assert.ok(!dispatcher.calls.includes("verify"));
});

test("fast impl loop short-circuits on test FAIL without running verify", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);
  await writeTaskSpec(harness);
  const dispatcher = makeLoopDispatcher({ testAttempts: ["FAIL"] });

  const result = await runFastImplLoopSubstage(
    { ...harness.runtime(), services: { ...harness.services, dispatcher } },
    { taskId: "01", worktreeRoot: harness.workspaceRoot, taskSpecId: { kind: "taskSpec", phase: 1, taskId: "01" } },
  );

  assert.equal(result.status, "FAIL");
  assert.ok(!dispatcher.calls.includes("verify"));
});

test("fast impl loop retries on verify FAIL and returns PASS on attempt 2", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);
  await writeTaskSpec(harness);
  const dispatcher = makeLoopDispatcher({ verifyAttempts: ["FAIL", "PASS"] });

  const result = await runFastImplLoopSubstage(
    { ...harness.runtime(), services: { ...harness.services, dispatcher } },
    { taskId: "01", worktreeRoot: harness.workspaceRoot, taskSpecId: { kind: "taskSpec", phase: 1, taskId: "01" } },
  );

  assert.equal(result.status, "PASS");
  // code called twice, test called twice, verify called twice
  assert.equal(dispatcher.calls.filter((c) => c === "code").length, 2);
  assert.equal(dispatcher.calls.filter((c) => c === "verify").length, 2);
});

test("fast impl loop returns FAIL when verify fails on both attempts", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);
  await writeTaskSpec(harness);
  const dispatcher = makeLoopDispatcher({ verifyAttempts: ["FAIL", "FAIL"] });

  const result = await runFastImplLoopSubstage(
    { ...harness.runtime(), services: { ...harness.services, dispatcher } },
    { taskId: "01", worktreeRoot: harness.workspaceRoot, taskSpecId: { kind: "taskSpec", phase: 1, taskId: "01" } },
  );

  assert.equal(result.status, "FAIL");
  assert.equal(dispatcher.calls.filter((c) => c === "code").length, 2);
});

test("fast impl loop returns FAIL when code review blocks after verify PASS", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);
  await writeTaskSpec(harness);
  // route=full always selects at least 2 reviewers (code-quality + goal-traceability)
  // across 2 loop attempts that's 4 total review calls; all must FAIL to block
  const dispatcher = makeLoopDispatcher({ reviewAttempts: ["FAIL", "FAIL", "FAIL", "FAIL"] });

  const result = await runFastImplLoopSubstage(
    { ...harness.runtime(), services: { ...harness.services, dispatcher } },
    { taskId: "01", worktreeRoot: harness.workspaceRoot, taskSpecId: { kind: "taskSpec", phase: 1, taskId: "01" } },
  );

  assert.equal(result.status, "FAIL");
  assert.match(result.summary, /code review/i);
});

test("fast impl loop merges telemetry from all steps on PASS", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);
  await writeTaskSpec(harness);
  const dispatcher = makeLoopDispatcher({});

  const result = await runFastImplLoopSubstage(
    { ...harness.runtime(), services: { ...harness.services, dispatcher } },
    { taskId: "01", worktreeRoot: harness.workspaceRoot, taskSpecId: { kind: "taskSpec", phase: 1, taskId: "01" } },
  );

  assert.equal(result.status, "PASS");
  assert.ok(result.telemetry?.code_wrote === true || result.telemetry?.verify_ran === true);
});
