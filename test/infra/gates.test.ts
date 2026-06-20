import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createAskHumanTool,
  DefaultGateManager,
  determineInteractionMode,
  parseExplicitRunOptions,
} from "../../src/infra/pi/human-gate.js";
import { createGoalsReturnTool, createInterviewReturnTool } from "../../src/infra/pi/stage-return-tool.js";
import { stripCommandFlags } from "../../src/index.js";

test("parseExplicitRunOptions reads mode failure and run-id flags", () => {
  const options = parseExplicitRunOptions("resume run-id:dl-20260601-123456 mode:automated failure:best-effort");
  assert.equal(options.mode, "automated");
  assert.equal(options.failurePolicy, "best-effort");
  assert.equal(options.resumeRunId, "dl-20260601-123456");
});

test("parseExplicitRunOptions parses review:fast", () => {
  const options = parseExplicitRunOptions("some task review:fast failure:best-effort");
  assert.equal(options.reviewDepth, "fast");
});

test("parseExplicitRunOptions defaults reviewDepth to undefined (thorough by convention)", () => {
  const options = parseExplicitRunOptions("some task failure:best-effort");
  assert.equal(options.reviewDepth, undefined);
});

test("determineInteractionMode defaults to automated without UI", () => {
  const result = determineInteractionMode({ hasUI: false } as never, "ship it");
  assert.equal(result.interactionMode, "automated");
  assert.equal(result.failurePolicy, "best-effort");
});

test("determineInteractionMode parses review:fast and surfaces reviewDepth", () => {
  const result = determineInteractionMode({ hasUI: false } as never, "some task review:fast");
  assert.equal(result.reviewDepth, "fast");
});

test("determineInteractionMode defaults reviewDepth to thorough when flag absent", () => {
  const result = determineInteractionMode({ hasUI: false } as never, "some task");
  assert.equal(result.reviewDepth, "thorough");
});

test("ask_human returns no answer when the gate manager cannot prompt", async () => {
  const tool = createAskHumanTool({
    interactionMode: "automated",
    failurePolicy: "best-effort",
    async askText() {
      return undefined;
    },
    async choose() {
      return undefined;
    },
    async confirm() {
      return false;
    },
    createAskHumanTool() {
      return createAskHumanTool(this);
    },
    createGoalsReturnTool() {
      return createGoalsReturnTool();
    },
    createInterviewReturnTool() {
      return createInterviewReturnTool();
    },
  });

  const result = await tool.execute(
    "tool-1",
    {
      title: "Clarify",
      question: "What should happen?",
    },
    undefined,
    undefined,
    {} as never,
  );

  assert.deepEqual(result.details, {});
});

test("parseExplicitRunOptions parses models: flag into modelProfile", () => {
  const options = parseExplicitRunOptions("my task models:balanced");
  assert.equal(options.modelProfile, "balanced");
});

test("parseExplicitRunOptions parses models: flag with hyphens", () => {
  const options = parseExplicitRunOptions("my task models:my-custom-profile");
  assert.equal(options.modelProfile, "my-custom-profile");
});

test("parseExplicitRunOptions leaves modelProfile undefined when flag absent", () => {
  const options = parseExplicitRunOptions("my task mode:automated");
  assert.equal(options.modelProfile, undefined);
});

test("stripCommandFlags removes models: flag from task text", () => {
  const stripped = stripCommandFlags("build a health-check endpoint models:cheap mode:automated");
  assert.equal(stripped, "build a health-check endpoint");
});

test("stripCommandFlags leaves task text unchanged when no models: flag", () => {
  const stripped = stripCommandFlags("build a health-check endpoint");
  assert.equal(stripped, "build a health-check endpoint");
});

test("DefaultGateManager choose falls back to confirm when select is unavailable", async () => {
  const ctx = {
    hasUI: true,
    ui: {
      confirm: async (_title: string, message: string) => message.includes("first"),
      input: async () => undefined,
    },
  } as never;
  const gates = new DefaultGateManager(ctx, {
    interactionMode: "interactive",
    failurePolicy: "fail-closed",
  });

  const choice = await gates.choose("Pick", [
    { value: "first", label: "first option" },
    { value: "second", label: "second option" },
  ]);

  assert.equal(choice?.value, "first");
});
