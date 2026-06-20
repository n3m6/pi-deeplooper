import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createStageReturnTool,
  normalizeStageReturn,
  type StageReturnPayload,
} from "../../src/infra/pi/stage-return-tool.js";

test("stage_return captures structured payloads", async () => {
  const sink: StageReturnPayload[] = [];
  const tool = createStageReturnTool(sink);
  const result = await tool.execute(
    "tool-1",
    {
      status: "PASS",
      filesWritten: ["foo.md"],
      summary: "ok",
    },
    undefined,
    undefined,
    {} as never,
  );

  assert.equal(sink.length, 1);
  assert.equal(result.details.status, "PASS");
});

test("normalizeStageReturn synthesizes failure without tool call", () => {
  const outcome = normalizeStageReturn({
    text: "",
    messages: [],
    customToolCalls: [],
  });

  assert.equal(outcome.status, "FAIL");
  assert.match(outcome.summary, /without calling stage_return/);
});

test("normalizeStageReturn reports dispatch timeouts", () => {
  const outcome = normalizeStageReturn({
    text: "",
    messages: [],
    customToolCalls: [],
    endReason: "timeout",
  });

  assert.equal(outcome.status, "FAIL");
  assert.match(outcome.summary, /timed out/);
  assert.equal(outcome.telemetry?.dispatch_end_reason, "timeout");
});
