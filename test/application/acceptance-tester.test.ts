/**
 * In DEEPLOOPER, runAcceptanceTesterSubstage is a stub — acceptance testing is
 * done globally by accept.ts. This test just verifies the stub's contract.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { runAcceptanceTesterSubstage } from "../../src/application/stage/acceptance-tester.js";
import type { StageRuntime } from "../../src/application/port/index.js";

test("runAcceptanceTesterSubstage returns FAIL with stub message", async () => {
  const result = await runAcceptanceTesterSubstage({} as unknown as StageRuntime);
  assert.equal(result.status, "FAIL");
  assert.match(result.summary, /not used in DEEPLOOPER/);
});
