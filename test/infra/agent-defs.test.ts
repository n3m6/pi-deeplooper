import { test } from "node:test";
import assert from "node:assert/strict";

import { isOrchestrator, loadAgentDefinitions } from "../../src/infra/pi/agent-catalog.js";

test("loadAgentDefinitions returns retained markdown leaf agents only", async () => {
  const definitions = await loadAgentDefinitions();

  assert.equal(definitions.size, 39); // 39 dl-* leaf agent files
  assert.ok(definitions.has("dl-goals-synthesizer"));
  assert.ok(definitions.has("dl-reporter"));
  assert.ok(!definitions.has("dl-goals"));
  assert.ok(!definitions.has("dl-plan"));

  for (const definition of definitions.values()) {
    assert.equal(isOrchestrator(definition), false);
  }
});
