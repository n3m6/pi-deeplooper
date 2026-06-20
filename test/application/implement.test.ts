/**
 * Pure unit tests for implement.ts utilities.
 * Integration tests for implementStage are removed — in DEEPLOOPER, slice
 * implementation is orchestrated via slice-loop.ts / runSliceImplementation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildWaves, classifyIntegrationLoop, TaskSpecSummary } from "../../src/application/stage/implement.js";

// ---------------------------------------------------------------------------
// buildWaves
// ---------------------------------------------------------------------------

function task(taskId: string, dependencies: string[] = []): TaskSpecSummary {
  return {
    taskId,
    phase: "1",
    dependencies,
    taskSpecId: { kind: "taskSpec", phase: 1, taskId },
    title: `Task ${taskId}`,
  };
}

test("buildWaves places independent tasks in a single wave", () => {
  const waves = buildWaves([task("01"), task("02"), task("03")]);
  assert.equal(waves.length, 1);
  assert.equal(waves[0]?.length, 3);
});

test("buildWaves orders tasks with dependencies into sequential waves", () => {
  const waves = buildWaves([task("02", ["01"]), task("01"), task("03", ["02"])]);
  assert.equal(waves.length, 3);
  assert.equal(waves[0]?.[0]?.taskId, "01");
  assert.equal(waves[1]?.[0]?.taskId, "02");
  assert.equal(waves[2]?.[0]?.taskId, "03");
});

test("buildWaves handles mixed dependency depths", () => {
  const waves = buildWaves([task("03"), task("02", ["01"]), task("01")]);
  assert.equal(waves.length, 2);
  const wave1Ids = waves[0]?.map((t) => t.taskId).sort() ?? [];
  assert.deepEqual(wave1Ids, ["01", "03"]);
});

test("buildWaves falls back to a single wave when dependency cycle detected", () => {
  const waves = buildWaves([task("01", ["02"]), task("02", ["01"])]);
  assert.equal(waves.length, 1);
  assert.equal(waves[0]?.length, 2);
});

test("buildWaves returns empty array for empty input", () => {
  assert.deepEqual(buildWaves([]), []);
});

// ---------------------------------------------------------------------------
// classifyIntegrationLoop
// ---------------------------------------------------------------------------

test("classifyIntegrationLoop returns LOOP_DESIGN when Affected Artifact is design", () => {
  const markdown = "**Affected Artifact**: design\nSome details.";
  assert.equal(classifyIntegrationLoop(markdown), "LOOP_DESIGN");
});

test("classifyIntegrationLoop returns LOOP_DESIGN for Design artifact", () => {
  const markdown = "**Affected Artifact**: Design\nSome details.";
  assert.equal(classifyIntegrationLoop(markdown), "LOOP_DESIGN");
});

test("classifyIntegrationLoop returns LOCAL_SLICE for plan or anything else", () => {
  assert.equal(classifyIntegrationLoop("**Affected Artifact**: plan"), "LOCAL_SLICE");
  assert.equal(classifyIntegrationLoop("No affected artifact mentioned."), "LOCAL_SLICE");
  assert.equal(classifyIntegrationLoop("**Affected Artifact**: structure"), "LOCAL_SLICE");
});
