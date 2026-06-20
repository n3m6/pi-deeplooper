import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resumeOrInferState } from "../../src/infra/fs/state-reconstruction.js";
import { ensureRunDirectories, getRunArtifacts } from "../../src/infra/fs/artifact-repository.js";
import { saveState } from "../../src/infra/fs/state-repository.js";
import { Run } from "../../src/domain/run/index.js";

test("resumeOrInferState prefers persisted state.json", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-deeplooper-resume-state-"));
  const runId = "deeplooper-20260601-000000";
  const artifacts = getRunArtifacts(workspace, runId);
  await ensureRunDirectories(artifacts);

  const state = Run.start({
    runId,
    interactionMode: "automated",
    failurePolicy: "best-effort",
    route: "full",
  }).toSnapshot();
  await saveState(artifacts.stateFile, state);

  const resumed = await resumeOrInferState({
    workspaceRoot: workspace,
    runId,
    interactionMode: "interactive",
    failurePolicy: "fail-closed",
  });

  assert.ok(resumed);
  assert.equal(resumed?.resumeSource, "resume");
  assert.equal(resumed?.route, "full");
});

test("resumeOrInferState infers post-research state when research/summary.md present", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-deeplooper-resume-research-"));
  const runId = "deeplooper-20260601-010000";
  const artifacts = getRunArtifacts(workspace, runId);
  await ensureRunDirectories(artifacts);

  await writeFile(artifacts.configFile, `route: full\nrun_id: ${runId}\n`, "utf8");
  await writeFile(artifacts.goalsFile, "# Goals\n", "utf8");
  await writeFile(artifacts.researchSummaryFile, "# Research\n", "utf8");

  const resumed = await resumeOrInferState({
    workspaceRoot: workspace,
    runId,
    interactionMode: "automated",
    failurePolicy: "best-effort",
  });

  assert.equal(resumed?.lastCompletedStage, "research");
  assert.equal(resumed?.nextStage, "design");
});

test("resumeOrInferState infers post-design state when design.md present", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-deeplooper-resume-design-"));
  const runId = "deeplooper-20260601-020000";
  const artifacts = getRunArtifacts(workspace, runId);
  await ensureRunDirectories(artifacts);

  await writeFile(artifacts.configFile, `route: full\nrun_id: ${runId}\n`, "utf8");
  await writeFile(artifacts.goalsFile, "# Goals\n", "utf8");
  await writeFile(artifacts.researchSummaryFile, "# Research\n", "utf8");
  await writeFile(artifacts.designFile, "# Design\n", "utf8");

  const resumed = await resumeOrInferState({
    workspaceRoot: workspace,
    runId,
    interactionMode: "automated",
    failurePolicy: "best-effort",
  });

  assert.equal(resumed?.lastCompletedStage, "design");
  assert.equal(resumed?.nextStage, "skeleton");
});

test("resumeOrInferState can infer goals progress from artifacts", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-deeplooper-resume-artifacts-"));
  const runId = "deeplooper-20260601-030000";
  const artifacts = getRunArtifacts(workspace, runId);
  await ensureRunDirectories(artifacts);

  await writeFile(artifacts.goalsFile, "# Goals\n\nok\n", "utf8");
  await writeFile(artifacts.researchSummaryFile, "# Research\n\nok\n", "utf8");

  const resumed = await resumeOrInferState({
    workspaceRoot: workspace,
    runId,
    interactionMode: "automated",
    failurePolicy: "best-effort",
  });

  assert.ok(resumed);
  assert.equal(resumed?.resumeSource, "artifacts");
  assert.equal(resumed?.lastCompletedStage, "research");
  assert.equal(resumed?.nextStage, "design");
});

test("resumeOrInferState infers slice-loop state when slice-queue.md present", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-deeplooper-resume-sliceloop-"));
  const runId = "deeplooper-20260601-040000";
  const artifacts = getRunArtifacts(workspace, runId);
  await ensureRunDirectories(artifacts);

  await writeFile(artifacts.configFile, `route: full\nrun_id: ${runId}\n`, "utf8");
  await writeFile(artifacts.goalsFile, "# Goals\n", "utf8");
  await writeFile(artifacts.researchSummaryFile, "# Research\n", "utf8");
  await writeFile(artifacts.designFile, "# Design\n", "utf8");
  await writeFile(path.join(artifacts.runDir, "structure.md"), "# Structure\n", "utf8");
  await writeFile(path.join(artifacts.runDir, "skeleton-results.md"), "### Status — PASS\n", "utf8");
  await writeFile(artifacts.baselineResultsFile, "### Baseline Status — CLEAN\n", "utf8");
  await writeFile(artifacts.sliceQueueFile, "# Slice Queue\n\n## S-01: Example\nstatus: pending\n", "utf8");

  const resumed = await resumeOrInferState({
    workspaceRoot: workspace,
    runId,
    interactionMode: "automated",
    failurePolicy: "best-effort",
  });

  assert.equal(resumed?.nextStage, "slice-loop");
});
