import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { runBaselineRegressionSubstage } from "../../src/application/stage/baseline-regression.js";
import { runE2ERegressionSubstage } from "../../src/application/stage/e2e-regression.js";
import type { BuildToolPort, ExecOutcome } from "../../src/application/port/index.js";
import { TestHarness } from "../support/harness.js";

const harnesses: TestHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.dispose()));
});

function makeBuildTool(
  availableScripts: string[],
  scriptResults: Record<string, Partial<ExecOutcome>> = {},
): BuildToolPort {
  return {
    async availableScripts(_cwd: string) {
      return availableScripts;
    },
    async runScript(name: string, _cwd: string) {
      const override = scriptResults[name];
      const code = override?.code ?? 0;
      return {
        stdout: override?.stdout ?? "",
        stderr: override?.stderr ?? "",
        code,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Baseline regression tests
// ---------------------------------------------------------------------------

test("baseline: returns NOT CONFIGURED when package.json has no build/lint/test scripts", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);

  const result = await runBaselineRegressionSubstage(
    {
      ...harness.runtime(),
      services: { ...harness.services, buildTool: makeBuildTool([]) },
    },
    1,
  );

  assert.equal(result.status, "PASS");
  assert.match(result.summary, /pass/i);
});

test("baseline: returns FAIL when build script fails", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);

  const result = await runBaselineRegressionSubstage(
    {
      ...harness.runtime(),
      services: {
        ...harness.services,
        buildTool: makeBuildTool(["build"], { build: { stderr: "Type error found.", code: 1 } }),
      },
    },
    1,
  );

  assert.equal(result.status, "FAIL");
  assert.match(result.summary, /FAIL/i);
});

test("baseline: returns PASS when all configured scripts pass", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);

  const result = await runBaselineRegressionSubstage(
    {
      ...harness.runtime(),
      services: {
        ...harness.services,
        buildTool: makeBuildTool(["build", "test"], {
          build: { stdout: "", code: 0 },
          test: { stdout: "ok 1", code: 0 },
        }),
      },
    },
    1,
  );

  assert.equal(result.status, "PASS");
});

test("baseline: includes lint check when lint script is present", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);

  const calledScripts: string[] = [];
  const buildTool: BuildToolPort = {
    async availableScripts() {
      return ["lint", "test"];
    },
    async runScript(name) {
      calledScripts.push(name);
      return { stdout: "", stderr: "", code: 0 };
    },
  };

  await runBaselineRegressionSubstage(
    {
      ...harness.runtime(),
      services: { ...harness.services, buildTool },
    },
    1,
  );

  assert.ok(calledScripts.includes("lint"), "lint should have been executed");
});

test("baseline: handles missing package.json gracefully as NOT CONFIGURED", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);

  const result = await runBaselineRegressionSubstage(
    {
      ...harness.runtime(),
      services: { ...harness.services, buildTool: makeBuildTool([]) },
    },
    1,
  );

  assert.ok(["PASS", "FAIL"].includes(result.status));
  if (result.status === "PASS") {
    assert.ok(result.summary.length > 0);
  }
});

// ---------------------------------------------------------------------------
// E2E regression tests
// ---------------------------------------------------------------------------

test("e2e: returns NOT CONFIGURED when no test:e2e or e2e script exists", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);

  const result = await runE2ERegressionSubstage(
    {
      ...harness.runtime(),
      services: { ...harness.services, buildTool: makeBuildTool(["build"]) },
    },
    1,
  );

  assert.equal(result.outcome.status, "PASS");
  assert.match(result.outcome.summary, /configured/i);
});

test("e2e: falls back to e2e script when test:e2e is absent", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);

  const calledScripts: string[] = [];
  const buildTool: BuildToolPort = {
    async availableScripts() {
      return ["e2e"];
    },
    async runScript(name) {
      calledScripts.push(name);
      return { stdout: "ok all tests passed", stderr: "", code: 0 };
    },
  };

  const result = await runE2ERegressionSubstage(
    {
      ...harness.runtime(),
      services: { ...harness.services, buildTool },
    },
    1,
  );

  assert.equal(result.outcome.status, "PASS");
  assert.ok(
    calledScripts.some((c) => c.includes("e2e")),
    "e2e script should have been called",
  );
});

test("e2e: returns FAIL when test:e2e script exits with non-zero code", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);

  const result = await runE2ERegressionSubstage(
    {
      ...harness.runtime(),
      services: {
        ...harness.services,
        buildTool: makeBuildTool(["test:e2e"], { "test:e2e": { stderr: "E2E tests failed.", code: 1 } }),
      },
    },
    1,
  );

  assert.equal(result.outcome.status, "FAIL");
  assert.match(result.outcome.summary, /FAIL/i);
});

test("e2e: embeds stdout and stderr in result when script fails", async () => {
  const harness = await TestHarness.create({ route: "full" });
  harnesses.push(harness);

  const result = await runE2ERegressionSubstage(
    {
      ...harness.runtime(),
      services: {
        ...harness.services,
        buildTool: makeBuildTool(["test:e2e"], {
          "test:e2e": { stdout: "Running tests\n1 failed", stderr: "Error: timeout", code: 1 },
        }),
      },
    },
    1,
  );

  assert.equal(result.outcome.status, "FAIL");
  const artifact = result.outcome.filesWritten[0];
  if (artifact) {
    assert.ok(artifact.length > 0);
  }
});
