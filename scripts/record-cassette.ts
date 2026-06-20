#!/usr/bin/env tsx
/**
 * record-cassette — generates golden cassettes in test/cassettes/ using MockDispatcher.
 *
 * Run once (or after stage logic changes) to refresh the golden corpus:
 *   tsx scripts/record-cassette.ts
 *
 * Each scenario uses TestHarness (real git workspace + MockDispatcher) wrapped in
 * RecordingDispatcher/RecordingGateManager, then flushes the cassette to
 * test/cassettes/<name>/.  Cassettes are committed — they are the source of truth
 * for the golden replay tests.
 */

import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runPipeline } from "../src/application/pipeline/run-pipeline.js";
import {
  CassetteWriter,
  CASSETTE_SCHEMA_VERSION,
  type CassetteMeta,
} from "../src/infra/replay/cassette.js";
import { RecordingDispatcher, type WorkspaceCapture } from "../src/infra/replay/recording-dispatcher.js";
import { RecordingGateManager } from "../src/infra/replay/recording-gate.js";
import { FakeBuildTool } from "../src/infra/replay/fake-build-tool.js";
import { StubChangesVersionControl } from "../src/infra/replay/stub-version-control.js";
import { TestHarness, type HarnessOptions } from "../test/support/harness.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CASSETTES_DIR = path.resolve(__dirname, "..", "test", "cassettes");

// ---------------------------------------------------------------------------
// workspaceCapture — git tree-object snapshot/diff for accurate change capture
// ---------------------------------------------------------------------------

const workspaceCapture: WorkspaceCapture = {
  async snapshot(cwd: string): Promise<string> {
    try {
      await execFileAsync("git", ["-C", cwd, "add", "-A"]).catch(() => undefined);
      const { stdout } = await execFileAsync("git", ["-C", cwd, "write-tree"]);
      await execFileAsync("git", ["-C", cwd, "reset"]).catch(() => undefined);
      return stdout.trim();
    } catch {
      return "";
    }
  },

  async diff(cwd: string, handle: string): Promise<{ files: Array<{ path: string; content: string }>; patch: string }> {
    if (!handle) return { files: [], patch: "" };
    try {
      await execFileAsync("git", ["-C", cwd, "add", "-A"]).catch(() => undefined);
      const nameResult = await execFileAsync("git", [
        "-C", cwd, "diff", "--cached", handle, "--name-only", "--diff-filter=AM",
      ]).catch(() => ({ stdout: "" }));
      const patchResult = await execFileAsync("git", [
        "-C", cwd, "diff", "--cached", handle,
      ]).catch(() => ({ stdout: "" }));
      await execFileAsync("git", ["-C", cwd, "reset"]).catch(() => undefined);

      const relPaths = nameResult.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      const fileEntries: Array<{ path: string; content: string }> = [];
      for (const relPath of relPaths) {
        try {
          const content = await readFile(path.join(cwd, relPath), "utf8");
          fileEntries.push({ path: relPath, content });
        } catch {
          // unreadable file — skip
        }
      }
      return { files: fileEntries, patch: patchResult.stdout };
    } catch {
      return { files: [], patch: "" };
    }
  },
};

// ---------------------------------------------------------------------------
// recordScenario
// ---------------------------------------------------------------------------

interface ScenarioOptions extends HarnessOptions {
  name: string;
}

async function recordScenario(scenario: ScenarioOptions): Promise<void> {
  console.log(`Recording scenario: ${scenario.name}`);

  const { name, ...harnessOptions } = scenario;
  const harness = await TestHarness.create({
    ...harnessOptions,
    interactionMode: "automated",
    failurePolicy: "best-effort",
    reviewDepth: "thorough",
  });

  try {
    const { workspaceRoot, state } = harness;
    const runId = state.runId;

    // Pre-clean any worktree dirs from a previous failed run so git worktree add succeeds.
    await rm(path.join(os.tmpdir(), ".deeplooper-worktrees", runId), { recursive: true, force: true }).catch(() => undefined);

    const writer = new CassetteWriter();
    const recordingDispatcher = new RecordingDispatcher(
      harness.dispatcher,
      writer,
      workspaceRoot,
      runId,
      workspaceCapture,
    );
    const recordingGate = new RecordingGateManager(harness.gates, writer);
    const services = {
      ...harness.services,
      dispatcher: recordingDispatcher,
      gates: recordingGate,
      // Override changedFiles/changedLineCount so code-review keys are stable across
      // recording and replay (FakeVersionControl also returns [] and 0 in pure mode).
      versionControl: harness.services.versionControl
        ? new StubChangesVersionControl(harness.services.versionControl)
        : harness.services.versionControl,
      // Use FakeBuildTool so build-script output (npm headers, stdout) is deterministic
      // and matches the empty output returned by FakeBuildTool in pure-mode replay.
      // Without this, e2e-regression-results.md differs between record and replay,
      // causing the dl-coverage-planner key to diverge (CassetteMiss).
      buildTool: new FakeBuildTool(),
    };

    const finalState = await runPipeline({
      services,
      state,
      workspaceRoot,
      isResumed: false,
    });

    const cassetteDir = path.join(CASSETTES_DIR, name);
    const meta: CassetteMeta = {
      schemaVersion: CASSETTE_SCHEMA_VERSION,
      runId,
      route: finalState.route,
      interactionMode: "automated",
      failurePolicy: "best-effort",
      userTask: state.userTask ?? "Implement a deterministic deeplooper pipeline.",
      reviewDepth: "thorough",
      ...(finalState.lastCompletedStage !== undefined ? { lastCompletedStage: finalState.lastCompletedStage } : {}),
      // Only store expectedNextStage when it differs from the default "done".
      ...(finalState.nextStage !== "done" ? { expectedNextStage: finalState.nextStage } : {}),
    };
    await writer.flush(cassetteDir, meta);

    console.log(`  ✓ ${name}: lastCompletedStage=${finalState.lastCompletedStage} route=${finalState.route}`);
  } finally {
    await harness.dispose();
  }
}

// ---------------------------------------------------------------------------
// Scenarios — representative paths through the pipeline
// ---------------------------------------------------------------------------

const SCENARIOS: ScenarioOptions[] = [
  { name: "full-run", route: "full" },
  { name: "verify-remediation", route: "full", verificationStatus: "FAIL" },
  { name: "backward-loop-design", route: "full", backwardLoopRecommendation: "LOOP_DESIGN" },
];

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`Writing cassettes to ${CASSETTES_DIR}`);
  // Run sequentially — TestHarness uses a global counter to generate unique run IDs
  for (const scenario of SCENARIOS) {
    await recordScenario(scenario);
  }
  console.log("Done.");
}

main().catch((error) => {
  console.error("record-cassette failed:", error);
  process.exit(1);
});
