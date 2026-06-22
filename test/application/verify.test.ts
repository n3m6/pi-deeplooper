import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { parseOverallStatus, verifyStage } from "../../src/application/stage/verify.js";
import type { DispatchRequest, DispatchResult, Dispatcher } from "../../src/application/port/index.js";
import { TestHarness } from "../support/harness.js";

const harnesses: TestHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.dispose()));
});

// ---------------------------------------------------------------------------
// parseOverallStatus — pure unit tests
// ---------------------------------------------------------------------------

test("parseOverallStatus returns PASS for markdown containing ### Overall Status — PASS", () => {
  assert.equal(parseOverallStatus("### Overall Status — PASS\n\nAll good."), "PASS");
});

test("parseOverallStatus returns PARTIAL for markdown containing ### Overall Status — PARTIAL", () => {
  assert.equal(parseOverallStatus("### Overall Status — PARTIAL\n\nSome failed."), "PARTIAL");
});

test("parseOverallStatus returns FAIL for markdown containing ### Overall Status — FAIL", () => {
  assert.equal(parseOverallStatus("### Overall Status — FAIL\n\nAll failed."), "FAIL");
});

test("parseOverallStatus returns PASS via /PASS\\b/ fallback when no Overall Status heading", () => {
  assert.equal(parseOverallStatus("Verification complete. Status: PASS for all checks."), "PASS");
});

test("parseOverallStatus returns FAIL as default when no match", () => {
  assert.equal(parseOverallStatus("The system is unclear."), "FAIL");
});

test("parseOverallStatus matches lowercase status via case-insensitive regex", () => {
  assert.equal(parseOverallStatus("### Overall Status — pass"), "PASS");
});

test("parseOverallStatus prefers PARTIAL over PASS fallback", () => {
  assert.equal(parseOverallStatus("### Overall Status — PARTIAL\n\nSome PASS, some fail."), "PARTIAL");
});

// ---------------------------------------------------------------------------
// verifyStage scenarios
// ---------------------------------------------------------------------------

async function writeCoreArtifacts(harness: TestHarness): Promise<void> {
  await writeFile(harness.artifacts.goalsFile, "# Goals\n\n## Acceptance Criteria\n1. Everything works.", "utf8");
  await writeFile(harness.artifacts.requirementsFile, "Build a minimal CLI.", "utf8");
  await writeFile(harness.artifacts.designFile, "# Design\n\nSimple CLI design.", "utf8");
  await writeFile(harness.artifacts.baselineResultsFile, "### Baseline Status — PASS\n\nAll checks passed.", "utf8");
  await writeFile(
    harness.artifacts.sliceQueueFile,
    "# Slice Queue\n\n## S-01: Example slice\nstatus: done\ndeps: none\nrequeue_count: 0\nphase_dir: phases/phase-01\nsource: design\nacceptance_criteria:\n  - Example passes\n  - AC-2 returns 200\n",
    "utf8",
  );

  const phaseDir = path.join(harness.artifacts.phasesDir, "phase-01");
  await mkdir(phaseDir, { recursive: true });
  await writeFile(path.join(phaseDir, "done-check-results.md"), "### Done Status — PASS\n\nSlice done.", "utf8");
}

function textResult(text: string): DispatchResult {
  return { text, messages: [], customToolCalls: [], endReason: "agent_end" };
}

function makeVerifyDispatcher(verifyText: string): Dispatcher {
  return {
    async dispatch(request: DispatchRequest): Promise<DispatchResult> {
      if (request.target.name === "dl-verifier") {
        return textResult(verifyText);
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

test("verify stage returns PASS with verify_status PASS when verifier reports PASS", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);
  await writeCoreArtifacts(harness);

  const verifyText = "### Overall Status — PASS\n\n### Stage Summary\nAll acceptance criteria met.";
  const dispatcher = makeVerifyDispatcher(verifyText);

  const result = await verifyStage.run({
    ...harness.runtime(),
    services: { ...harness.services, dispatcher },
  });

  assert.equal(result.status, "PASS");
  assert.equal(result.telemetry?.verify_status, "PASS");
});

test("verify stage returns FAIL with verify_status FAIL when verifier reports FAIL", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);
  await writeCoreArtifacts(harness);

  const verifyText = "### Overall Status — FAIL\n\n### Failures\n- Criterion 1 not met.\n\n### Stage Summary\nFailed.";
  const dispatcher = makeVerifyDispatcher(verifyText);

  const result = await verifyStage.run({
    ...harness.runtime(),
    services: { ...harness.services, dispatcher },
  });

  assert.equal(result.status, "FAIL");
  assert.equal(result.telemetry?.verify_status, "FAIL");
});

test("verify stage adds remediation slices and routes back to slice-loop when reflector returns R-NNN blocks", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);
  await writeCoreArtifacts(harness);

  // dl-verifier reports FAIL; dl-reflector returns a remediation slice block (pattern B).
  const dispatcher: Dispatcher = {
    async dispatch(request: DispatchRequest): Promise<DispatchResult> {
      if (request.target.name === "dl-verifier") {
        return textResult("### Overall Status — FAIL\n\n### Failures\n- AC-2 not met.");
      }
      if (request.target.name === "dl-reflector") {
        // Use "Example passes" which IS in the queue — S-01 will be reopened.
        return textResult(
          [
            "### Status — PASS",
            "### Summary — Remediation planned.",
            "",
            "### R-001: Remediate Example",
            "acceptance_criteria:",
            "  - Example passes",
            "",
            "### Lessons",
            "- 2026-06-01 global (stage9-summary.md): re-check AC-2 wiring.",
            "",
            "### Spec History",
            "None.",
            "",
            "### Goals Amendment",
            "None.",
          ].join("\n"),
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
    async dispatchGenericCoding() {
      return { status: "PASS" as const, filesWritten: [], summary: "" };
    },
  };

  const result = await verifyStage.run({
    ...harness.runtime(),
    services: { ...harness.services, dispatcher },
  });

  assert.equal(result.status, "FAIL");
  assert.equal(result.telemetry?.remediationSlicesAdded, true);

  // "Example passes" is in S-01, so S-01 should be reopened (not a new R-001 added).
  const queueMd = await readFile(harness.artifacts.sliceQueueFile, "utf8");
  assert.match(queueMd, /status: ready/);
  assert.match(queueMd, /last_reason: Reopened/);

  // The reflector's lessons must be persisted by the controller (read-only leaf).
  const lessons = await readFile(harness.artifacts.lessonsFile, "utf8");
  assert.match(lessons, /re-check AC-2 wiring/);
});

test("verify stage escalates (backward loop) when reflector returns no remediation slices", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);
  await writeCoreArtifacts(harness);

  const dispatcher: Dispatcher = {
    async dispatch(request: DispatchRequest): Promise<DispatchResult> {
      if (request.target.name === "dl-verifier") {
        return textResult("### Overall Status — FAIL\n\n### Failures\n- Structural issue.");
      }
      if (request.target.name === "dl-reflector") {
        return textResult("### Status — PASS\n### Summary — Nothing remediable.\n### Lessons\nNone.");
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

  const result = await verifyStage.run({
    ...harness.runtime(),
    services: { ...harness.services, dispatcher },
  });

  assert.equal(result.status, "FAIL");
  assert.equal(result.telemetry?.remediationSlicesAdded, false);
  assert.ok(result.backwardLoop, "expected a backward-loop escalation when no remediation is possible");
  assert.equal(result.backwardLoop?.classification, "LOOP_DESIGN");
});

test("verify stage returns PARTIAL with verify_status PARTIAL when verifier reports PARTIAL", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);
  await writeCoreArtifacts(harness);

  const verifyText =
    "### Overall Status — PARTIAL\n\n### Failures\n- Criterion 2 partial.\n\n### Stage Summary\nPartial.";
  const dispatcher = makeVerifyDispatcher(verifyText);

  const result = await verifyStage.run({
    ...harness.runtime(),
    services: { ...harness.services, dispatcher },
  });

  assert.equal(result.status, "PARTIAL");
  assert.equal(result.telemetry?.verify_status, "PARTIAL");
});

// ---------------------------------------------------------------------------
// Issue 3a: verifier prompt includes STAGE7 REGRESSION REUSE directive
// ---------------------------------------------------------------------------

test("verify stage includes STAGE7 REGRESSION REUSE and CONFIGURED SCRIPTS in verifier prompt", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);
  await writeCoreArtifacts(harness);

  let capturedPrompt = "";
  const dispatcher: Dispatcher = {
    async dispatch(request: DispatchRequest): Promise<DispatchResult> {
      if (request.target.name === "dl-verifier") {
        capturedPrompt = request.prompt;
        return textResult("### Overall Status — PASS\n\n### Stage Summary\nAll good.");
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

  await verifyStage.run({
    ...harness.runtime(),
    services: { ...harness.services, dispatcher },
  });

  assert.ok(
    capturedPrompt.includes("=== STAGE7 REGRESSION REUSE ==="),
    "verifier prompt must contain STAGE7 REGRESSION REUSE block",
  );
  assert.ok(capturedPrompt.includes("reusable:"), "verifier prompt STAGE7 block must include 'reusable:' key");
  assert.ok(
    capturedPrompt.includes("=== CONFIGURED SCRIPTS ==="),
    "verifier prompt must contain CONFIGURED SCRIPTS block",
  );
});

// ---------------------------------------------------------------------------
// Issue 3b: remediation criteria not in queue are dropped with anomaly
// ---------------------------------------------------------------------------

test("verify stage drops remediation criteria not in queue and records anomaly", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);
  await writeCoreArtifacts(harness);

  // Verifier FAILs; reflector returns R-001 with a process criterion that doesn't trace to the queue.
  const dispatcher: Dispatcher = {
    async dispatch(request: DispatchRequest): Promise<DispatchResult> {
      if (request.target.name === "dl-verifier") {
        return textResult("### Overall Status — FAIL\n\n### Failures\n- Something wrong.");
      }
      if (request.target.name === "dl-reflector") {
        return textResult(
          [
            "### Status — PASS",
            "### Summary — Remediation proposed.",
            "",
            "### R-001: Fix process criterion",
            "acceptance_criteria:",
            "  - git commit exists",
            "",
            "### Lessons",
            "None.",
          ].join("\n"),
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
    async dispatchGenericCoding(_prompt) {
      return { status: "PASS" as const, filesWritten: [], summary: "" };
    },
  };

  const result = await verifyStage.run({
    ...harness.runtime(),
    services: { ...harness.services, dispatcher },
  });

  // "git commit exists" is NOT in the slice queue, so it should be dropped.
  // No remediation slices → escalate LOOP_DESIGN.
  assert.equal(result.status, "FAIL");
  assert.ok(!result.telemetry?.remediationSlicesAdded, "No remediation slices should be added for process criteria");

  // Anomaly should have been recorded.
  const events = await harness.telemetrySink.readEvents();
  const filteredAnomalies = events.filter(
    (e: import("../../src/application/port/index.js").TelemetryEvent) =>
      e.event_type === "pipeline.anomaly" && e.context?.["code"] === "remediation-criteria-filtered",
  );
  assert.ok(filteredAnomalies.length > 0, "Expected remediation-criteria-filtered anomaly to be recorded");
});
