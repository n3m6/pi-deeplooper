import { test } from "node:test";
import assert from "node:assert/strict";

import { nextStageFor } from "../../src/domain/stage/transition-policy.js";

test("linear happy-path transitions", () => {
  assert.equal(nextStageFor("goals"), "research");
  assert.equal(nextStageFor("research"), "design");
  assert.equal(nextStageFor("design"), "skeleton");
  assert.equal(nextStageFor("skeleton"), "baseline");
  assert.equal(nextStageFor("baseline"), "slice-loop");
  assert.equal(nextStageFor("slice-loop"), "verify");
  assert.equal(nextStageFor("verify"), "accept");
  assert.equal(nextStageFor("accept"), "report");
  assert.equal(nextStageFor("report"), "done");
});

test("verify routes to slice-loop when remediationSlicesAdded", () => {
  assert.equal(nextStageFor("verify", { remediationSlicesAdded: true }), "slice-loop");
  assert.equal(nextStageFor("verify", { remediationSlicesAdded: false }), "accept");
});

test("accept routes to slice-loop when remediationSlicesAdded", () => {
  assert.equal(nextStageFor("accept", { remediationSlicesAdded: true }), "slice-loop");
  assert.equal(nextStageFor("accept", { remediationSlicesAdded: false }), "report");
});
