/**
 * In DEEPLOOPER, renderAcceptanceRepairContext always returns "".
 * The old phase-based acceptance repair context is no longer used.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { renderAcceptanceRepairContext } from "../../src/application/stage/acceptance-feedback.js";
import type { StageRuntime } from "../../src/application/port/index.js";

test("renderAcceptanceRepairContext returns empty string", async () => {
  const result = await renderAcceptanceRepairContext({} as unknown as StageRuntime);
  assert.equal(result, "");
});
