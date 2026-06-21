import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AGENT_TIERS, tierForAgentName } from "../../src/domain/model/tier-policy.js";
import { loadAgentDefinitions } from "../../src/infra/pi/agent-catalog.js";
import { loadModelConfig, resolveProfile } from "../../src/infra/config/model-config.js";
import { ConfiguredModelPolicy } from "../../src/infra/pi/model-policy.js";

// ---------------------------------------------------------------------------
// Tier map
// ---------------------------------------------------------------------------

test("AGENT_TIERS covers exactly 40 agents", () => {
  assert.equal(Object.keys(AGENT_TIERS).length, 40);
});

test("AGENT_TIERS has 7 architect agents", () => {
  const architects = Object.values(AGENT_TIERS).filter((t) => t === "architect");
  assert.equal(architects.length, 7);
});

test("AGENT_TIERS has 23 review agents", () => {
  const reviewers = Object.values(AGENT_TIERS).filter((t) => t === "review");
  assert.equal(reviewers.length, 23);
});

test("AGENT_TIERS has 10 utility agents", () => {
  const utility = Object.values(AGENT_TIERS).filter((t) => t === "utility");
  assert.equal(utility.length, 10);
});

test("AGENT_TIERS has no coding agents (generic-coding is not a leaf)", () => {
  const coding = Object.values(AGENT_TIERS).filter((t) => t === "coding");
  assert.equal(coding.length, 0);
});

test("tierForAgentName returns correct tier for known agents", () => {
  assert.equal(tierForAgentName("dl-goals-synthesizer"), "architect");
  assert.equal(tierForAgentName("dl-goals-reviewer"), "review");
  assert.equal(tierForAgentName("dl-reporter"), "utility");
});

test("tierForAgentName defaults to utility for unknown agent names", () => {
  assert.equal(tierForAgentName("dl-unknown-future-agent"), "utility");
  assert.equal(tierForAgentName("generic-coding"), "utility");
});

test("every loaded agent definition name has a tier in AGENT_TIERS", async () => {
  const definitions = await loadAgentDefinitions();
  const untiered: string[] = [];
  for (const name of definitions.keys()) {
    if (!(name in AGENT_TIERS)) {
      untiered.push(name);
    }
  }
  assert.deepEqual(untiered, [], `These agents are missing from AGENT_TIERS: ${untiered.join(", ")}`);
});

// ---------------------------------------------------------------------------
// loadModelConfig
// ---------------------------------------------------------------------------

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "deeplooper-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("loadModelConfig returns empty config when .deeplooper/models.json is missing", async () => {
  await withTempDir(async (dir) => {
    const config = await loadModelConfig(dir);
    assert.deepEqual(config, {});
  });
});

test("loadModelConfig parses a valid models.json", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, ".deeplooper"));
    await writeFile(
      join(dir, ".deeplooper", "models.json"),
      JSON.stringify({
        profile: "balanced",
        profiles: {
          balanced: {
            architect: { model: "my/model-pro", thinking: "high" },
            review: { model: "my/model-flash", thinking: "medium" },
          },
        },
      }),
      "utf8",
    );
    const config = await loadModelConfig(dir);
    assert.equal(config.profile, "balanced");
    assert.equal(config.profiles?.["balanced"]?.["architect"]?.model, "my/model-pro");
    assert.equal(config.profiles?.["balanced"]?.["architect"]?.thinking, "high");
    assert.equal(config.profiles?.["balanced"]?.["review"]?.thinking, "medium");
  });
});

test("loadModelConfig returns empty config and calls warn on malformed JSON", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, ".deeplooper"));
    await writeFile(join(dir, ".deeplooper", "models.json"), "{ invalid json", "utf8");
    const warnings: string[] = [];
    const config = await loadModelConfig(dir, (msg) => warnings.push(msg));
    assert.deepEqual(config, {});
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /invalid JSON/);
  });
});

test("loadModelConfig returns empty config and calls warn when root is not an object", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, ".deeplooper"));
    await writeFile(join(dir, ".deeplooper", "models.json"), '"just a string"', "utf8");
    const warnings: string[] = [];
    const config = await loadModelConfig(dir, (msg) => warnings.push(msg));
    assert.deepEqual(config, {});
    assert.equal(warnings.length, 1);
  });
});

test("loadModelConfig silently ignores invalid tier keys in a profile", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, ".deeplooper"));
    await writeFile(
      join(dir, ".deeplooper", "models.json"),
      JSON.stringify({ profiles: { p1: { notATier: { model: "x" }, architect: { model: "y" } } } }),
      "utf8",
    );
    const config = await loadModelConfig(dir);
    assert.equal(config.profiles?.["p1"]?.["architect"]?.model, "y");
    assert.ok(!("notATier" in (config.profiles?.["p1"] ?? {})));
  });
});

// ---------------------------------------------------------------------------
// resolveProfile
// ---------------------------------------------------------------------------

test("resolveProfile returns empty object when config has no profiles", () => {
  assert.deepEqual(resolveProfile({}, "balanced"), {});
});

test("resolveProfile returns empty object when profile name is undefined", () => {
  assert.deepEqual(resolveProfile({ profiles: { balanced: { architect: { model: "x" } } } }, undefined), {});
});

test("resolveProfile returns empty object when named profile is absent", () => {
  assert.deepEqual(resolveProfile({ profiles: { balanced: { architect: { model: "x" } } } }, "cheap"), {});
});

test("resolveProfile returns the matching profile", () => {
  const profile = resolveProfile(
    { profiles: { balanced: { architect: { model: "pro", thinking: "high" } } } },
    "balanced",
  );
  assert.equal(profile["architect"]?.model, "pro");
});

// ---------------------------------------------------------------------------
// ConfiguredModelPolicy
// ---------------------------------------------------------------------------

test("ConfiguredModelPolicy.resolve returns model and thinking for an architect agent", () => {
  const policy = new ConfiguredModelPolicy({
    architect: { model: "pro-model", thinking: "high" },
    review: { model: "flash-model", thinking: "medium" },
  });
  const routing = policy.resolve({
    kind: "leaf",
    name: "dl-goals-synthesizer",
    description: "",
    tools: [],
    maxTurns: 40,
    systemPromptMode: "replace",
    extensions: [],
    filePath: "",
    body: "",
  });
  assert.equal(routing.modelName, "pro-model");
  assert.equal(routing.thinkingLevel, "high");
});

test("ConfiguredModelPolicy.resolve maps generic-coding to the coding tier", () => {
  const policy = new ConfiguredModelPolicy({
    coding: { model: "coder-model", thinking: "xhigh" },
  });
  const routing = policy.resolve({
    kind: "generic",
    name: "generic-coding",
    tools: [],
  });
  assert.equal(routing.modelName, "coder-model");
  assert.equal(routing.thinkingLevel, "xhigh");
});

test("ConfiguredModelPolicy.resolve returns undefined model+thinking when tier is absent from profile", () => {
  const policy = new ConfiguredModelPolicy({
    architect: { model: "pro-model", thinking: "high" },
  });
  const routing = policy.resolve({
    kind: "leaf",
    name: "dl-reporter", // utility tier
    description: "",
    tools: [],
    maxTurns: 5,
    systemPromptMode: "replace",
    extensions: [],
    filePath: "",
    body: "",
  });
  assert.equal(routing.modelName, undefined);
  assert.equal(routing.thinkingLevel, undefined);
});

test("ConfiguredModelPolicy.resolve returns undefined for all fields with empty profile", () => {
  const policy = new ConfiguredModelPolicy({});
  const routing = policy.resolve({
    kind: "generic",
    name: "generic-coding",
    tools: [],
  });
  assert.equal(routing.modelName, undefined);
  assert.equal(routing.thinkingLevel, undefined);
});

test("ConfiguredModelPolicy.resolve returns only thinking when model is absent from binding", () => {
  const policy = new ConfiguredModelPolicy({ utility: { thinking: "low" } });
  const routing = policy.resolve({
    kind: "leaf",
    name: "dl-reporter",
    description: "",
    tools: [],
    maxTurns: 5,
    systemPromptMode: "replace",
    extensions: [],
    filePath: "",
    body: "",
  });
  assert.equal(routing.modelName, undefined);
  assert.equal(routing.thinkingLevel, "low");
});

test("ConfiguredModelPolicy.resolve returns correct tier for each tier class", () => {
  const policy = new ConfiguredModelPolicy({
    architect: { model: "arch-model" },
    coding: { model: "code-model" },
    review: { model: "review-model" },
    utility: { model: "util-model" },
  });

  const leaf = (name: string) => ({
    kind: "leaf" as const,
    name,
    description: "",
    tools: [],
    maxTurns: 10,
    systemPromptMode: "replace" as const,
    extensions: [],
    filePath: "",
    body: "",
  });

  assert.equal(policy.resolve(leaf("dl-design-synthesizer")).modelName, "arch-model");
  assert.equal(policy.resolve(leaf("dl-review-security")).modelName, "review-model");
  assert.equal(policy.resolve(leaf("dl-coverage-planner")).modelName, "util-model");
  assert.equal(policy.resolve({ kind: "generic", name: "generic-coding", tools: [] }).modelName, "code-model");
});
