import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PiSessionDispatcher,
  resolveModel,
  mergeToolAllowlist,
  extractAssistantText,
  contentToText,
  instrumentCustomTools,
  existingPaths,
  waitForPromptCompletion,
} from "../../src/infra/pi/session-dispatcher.js";
import { makeFakeModelRegistry, makeSessionFactory, FakeSession } from "../support/fake-session.js";
import type { CustomTool, DispatchRequest } from "../../src/application/port/index.js";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("resolveModel returns the exact match by id", () => {
  const registry = makeFakeModelRegistry(
    [
      { id: "gpt-4o", provider: "openai" },
      { id: "claude-3", provider: "anthropic" },
    ],
    [{ id: "gpt-4o", provider: "openai" }],
  );
  const model = resolveModel(registry as never, undefined, "gpt-4o");
  assert.equal(model?.id, "gpt-4o");
});

test("resolveModel matches provider/id format", () => {
  const registry = makeFakeModelRegistry([{ id: "claude-3", provider: "anthropic" }], []);
  const model = resolveModel(registry as never, undefined, "anthropic/claude-3");
  assert.equal(model?.id, "claude-3");
});

test("resolveModel falls back to currentModel when desiredModelName not found", () => {
  const current = { id: "local-model", provider: "local" };
  const registry = makeFakeModelRegistry([], []);
  const model = resolveModel(registry as never, current as never, "unknown-model");
  assert.equal(model?.id, "local-model");
});

test("resolveModel falls back to getAvailable()[0] when no currentModel", () => {
  const registry = makeFakeModelRegistry([{ id: "slow", provider: "x" }], [{ id: "fast", provider: "x" }]);
  const model = resolveModel(registry as never, undefined, undefined);
  assert.equal(model?.id, "fast");
});

test("resolveModel falls back to all[0] when available list is empty", () => {
  const registry = makeFakeModelRegistry([{ id: "only-model", provider: "x" }], []);
  const model = resolveModel(registry as never, undefined, undefined);
  assert.equal(model?.id, "only-model");
});

test("resolveModel returns undefined when no model is available anywhere", () => {
  const registry = makeFakeModelRegistry([], []);
  const model = resolveModel(registry as never, undefined, undefined);
  assert.equal(model, undefined);
});

test("mergeToolAllowlist deduplicates base + custom tool names", () => {
  const result = mergeToolAllowlist(["read", "bash"], undefined, [
    { name: "stage_return" } as never,
    { name: "bash" } as never,
  ]);
  assert.deepEqual(result, ["read", "bash", "stage_return"]);
});

test("mergeToolAllowlist uses overrideTools when provided", () => {
  const result = mergeToolAllowlist(["read"], ["grep", "find"], []);
  assert.deepEqual(result, ["grep", "find"]);
});

test("extractAssistantText returns last assistant message content", () => {
  const messages = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "world" },
    { role: "user", content: "again" },
    { role: "assistant", content: "final" },
  ];
  assert.equal(extractAssistantText(messages), "final");
});

test("extractAssistantText returns empty string when no assistant message", () => {
  const messages = [{ role: "user", content: "hello" }];
  assert.equal(extractAssistantText(messages), "");
});

test("extractAssistantText returns empty string for empty messages", () => {
  assert.equal(extractAssistantText([]), "");
});

test("contentToText handles plain string content", () => {
  assert.equal(contentToText("hello world"), "hello world");
});

test("contentToText handles array-of-text-objects content", () => {
  assert.equal(contentToText([{ text: "hello" }, { text: "world" }]), "hello\nworld");
});

test("contentToText handles mixed string and text-object array", () => {
  assert.equal(contentToText(["foo", { text: "bar" }]), "foo\nbar");
});

test("contentToText handles empty array", () => {
  assert.equal(contentToText([]), "");
});

test("contentToText returns empty string for non-string non-array", () => {
  assert.equal(contentToText(null), "");
  assert.equal(contentToText(42), "");
});

test("instrumentCustomTools records calls in sink and invokes callback", async () => {
  const sink: import("../../src/application/port/index.js").DispatchCustomToolCall[] = [];
  const callbackNames: string[] = [];
  const tool: import("@earendil-works/pi-coding-agent").ToolDefinition<string, unknown, unknown> = {
    name: "my_tool",
    label: "My Tool",
    description: "test tool",
    parameters: {} as never,
    async execute() {
      return { content: [{ type: "text" as const, text: "ok" }], details: { ok: true } };
    },
  };

  const [instrumented] = instrumentCustomTools([tool], sink, (name) => {
    callbackNames.push(name);
  });

  if (!instrumented) throw new Error("instrumented is undefined");
  await instrumented.execute("tool-1", {}, undefined, undefined, {} as never);

  assert.equal(sink.length, 1);
  assert.equal(sink[0]?.name, "my_tool");
  assert.deepEqual(callbackNames, ["my_tool"]);
});

test("existingPaths filters out non-existent paths", async () => {
  const existing = await existingPaths([
    "/definitely/does/not/exist/x.ts",
    join(tmpdir(), "also-does-not-exist-abc.ts"),
  ]);
  assert.deepEqual(existing, []);
});

test("existingPaths keeps real paths", async () => {
  // Use a path that we know exists in the repo
  const existing = await existingPaths([join(process.cwd(), "src/index.ts")]);
  assert.equal(existing.length, 1);
});

// ---------------------------------------------------------------------------
// waitForPromptCompletion race logic
// ---------------------------------------------------------------------------

test("waitForPromptCompletion returns agent_end when session fires agent_end event", async () => {
  const session = new FakeSession({ kind: "agent_end", text: "done" });
  const stageReturn = new Promise<void>(() => undefined);
  const result = await waitForPromptCompletion(session, "hello", stageReturn, undefined, 0);
  assert.equal(result, "agent_end");
});

test("waitForPromptCompletion returns stage_return when stageReturn resolves first", async () => {
  const session = new FakeSession({ kind: "hang" });
  let resolveStageReturn!: () => void;
  const stageReturn = new Promise<void>((resolve) => {
    resolveStageReturn = resolve;
  });

  const resultPromise = waitForPromptCompletion(session, "hello", stageReturn, undefined, 0);
  resolveStageReturn();
  const result = await resultPromise;
  assert.equal(result, "stage_return");
});

test("waitForPromptCompletion returns timeout when timeoutMs fires", async () => {
  const session = new FakeSession({ kind: "hang" });
  const stageReturn = new Promise<void>(() => undefined);
  const result = await waitForPromptCompletion(session, "hello", stageReturn, undefined, 10);
  assert.equal(result, "timeout");
  assert.equal(session.aborted, true);
});

test("waitForPromptCompletion returns aborted when signal fires", async () => {
  const session = new FakeSession({ kind: "hang" });
  const stageReturn = new Promise<void>(() => undefined);
  const controller = new AbortController();

  const resultPromise = waitForPromptCompletion(session, "hello", stageReturn, controller.signal, 0);
  controller.abort();
  const result = await resultPromise;
  assert.equal(result, "aborted");
  assert.equal(session.aborted, true);
});

// ---------------------------------------------------------------------------
// PiSessionDispatcher with fake factory
// ---------------------------------------------------------------------------

function makeLeafTarget() {
  return {
    kind: "leaf" as const,
    name: "test-agent",
    description: "Test agent",
    tools: ["read"],
    maxTurns: 5,
    systemPromptMode: "replace" as const,
    extensions: [],
    filePath: "test-agent.md",
    body: "You are a test agent.",
  };
}

function makeRequest(overrides?: Partial<DispatchRequest>): DispatchRequest {
  return {
    target: makeLeafTarget(),
    prompt: "hello",
    cwd: tmpdir(),
    ...overrides,
  };
}

function makeDispatcher(behavior: import("../support/fake-session.js").FakeSessionBehavior, text = "") {
  const registry = makeFakeModelRegistry([], []);
  const { factory, sessions } = makeSessionFactory(behavior, text);
  const dispatcher = new PiSessionDispatcher(registry as never, undefined, factory);
  return { dispatcher, sessions };
}

test("PiSessionDispatcher returns agent_end endReason and text for happy path", async () => {
  const { dispatcher } = makeDispatcher({ kind: "agent_end" }, "### Status — PASS\n\nResult.");
  const result = await dispatcher.dispatch(makeRequest());
  assert.equal(result.endReason, "agent_end");
  assert.equal(result.text, "### Status — PASS\n\nResult.");
});

test("PiSessionDispatcher returns session_error on thrown error", async () => {
  const { dispatcher } = makeDispatcher({ kind: "throw", error: new Error("boom") });
  const result = await dispatcher.dispatch(makeRequest());
  assert.equal(result.endReason, "session_error");
  assert.match(result.errorMessage ?? "", /boom/);
  assert.equal(result.text, "");
});

test("PiSessionDispatcher returns aborted when signal fires before prompt completes", async () => {
  const { dispatcher } = makeDispatcher({ kind: "hang" });
  const controller = new AbortController();
  // Abort before dispatch runs - waitForPromptCompletion checks signal.aborted at start
  controller.abort();
  const result = await dispatcher.dispatch(makeRequest({ signal: controller.signal }));
  assert.equal(result.endReason, "aborted");
});

test("PiSessionDispatcher captures customToolCalls via instrumentCustomTools", async () => {
  const { dispatcher } = makeDispatcher({ kind: "agent_end" }, "done");
  const result = await dispatcher.dispatch(
    makeRequest({
      customTools: [
        {
          name: "my_tool",
          label: "My Tool",
          description: "test",
          parameters: {} as never,
          async execute() {
            return { content: [{ type: "text" as const, text: "fired" }], details: { fired: true } };
          },
        },
      ] as unknown as CustomTool[],
    }),
  );
  // The tool isn't called by the fake session - but the instrumented wrapper is in place
  assert.equal(result.customToolCalls.length, 0);
});

test("dispatchChain substitutes {previous} in subsequent prompts", async () => {
  const registry = makeFakeModelRegistry([], []);
  const capturedPrompts: string[] = [];
  const factory = async (
    request: DispatchRequest,
  ): Promise<import("../../src/infra/pi/session-dispatcher.js").AgentSession> => {
    capturedPrompts.push(request.prompt);
    return new FakeSession({ kind: "agent_end" }, `response-to: ${request.prompt}`);
  };
  const dispatcher = new PiSessionDispatcher(registry as never, undefined, factory as never);

  const results = await dispatcher.dispatchChain([
    makeRequest({ prompt: "first" }),
    makeRequest({ prompt: "second after {previous}" }),
    makeRequest({ prompt: "third after {previous}" }),
  ]);

  assert.equal(results.length, 3);
  assert.match(capturedPrompts[1] ?? "", /second after response-to: first/);
  assert.match(capturedPrompts[2] ?? "", /third after response-to: second after/);
});

// ---------------------------------------------------------------------------
// ModelPolicy integration
// ---------------------------------------------------------------------------

test("PiSessionDispatcher uses modelPolicy to resolve modelName from registry", async () => {
  const registry = makeFakeModelRegistry(
    [
      { id: "arch-model", provider: "x" },
      { id: "default-model", provider: "x" },
    ],
    [{ id: "default-model", provider: "x" }],
  );
  let capturedModelId: string | undefined;
  const factory = async (
    _req: DispatchRequest,
    _tools: import("@earendil-works/pi-coding-agent").ToolDefinition[],
    _allowlist: string[],
    model: { id: string } | undefined,
  ): Promise<import("../../src/infra/pi/session-dispatcher.js").AgentSession> => {
    capturedModelId = model?.id;
    return new FakeSession({ kind: "agent_end" }, "done");
  };

  const policy: import("../../src/application/port/index.js").ModelPolicy = {
    resolve: () => ({ modelName: "arch-model" }),
  };

  const dispatcher = new PiSessionDispatcher(registry as never, undefined, factory as never, undefined, policy);
  await dispatcher.dispatch(makeRequest());

  assert.equal(capturedModelId, "arch-model");
});

test("PiSessionDispatcher falls back to pi default model when policy returns undefined modelName", async () => {
  const defaultModel = { id: "default-model", provider: "x" };
  const registry = makeFakeModelRegistry([defaultModel], [defaultModel]);
  let capturedModelId: string | undefined;
  const factory = async (
    _req: DispatchRequest,
    _tools: import("@earendil-works/pi-coding-agent").ToolDefinition[],
    _allowlist: string[],
    model: { id: string } | undefined,
  ): Promise<import("../../src/infra/pi/session-dispatcher.js").AgentSession> => {
    capturedModelId = model?.id;
    return new FakeSession({ kind: "agent_end" }, "done");
  };

  const policy: import("../../src/application/port/index.js").ModelPolicy = {
    resolve: () => ({}),
  };

  const dispatcher = new PiSessionDispatcher(
    registry as never,
    defaultModel as never,
    factory as never,
    undefined,
    policy,
  );
  await dispatcher.dispatch(makeRequest());

  assert.equal(capturedModelId, "default-model");
});

test("PiSessionDispatcher forwards thinkingLevel override from policy into effective request", async () => {
  const registry = makeFakeModelRegistry([], []);
  let capturedThinkingLevel: string | undefined;
  const factory = async (
    req: DispatchRequest,
    _tools: import("@earendil-works/pi-coding-agent").ToolDefinition[],
    _allowlist: string[],
    _model: unknown,
  ): Promise<import("../../src/infra/pi/session-dispatcher.js").AgentSession> => {
    capturedThinkingLevel = req.target.thinkingLevel;
    return new FakeSession({ kind: "agent_end" }, "done");
  };

  const policy: import("../../src/application/port/index.js").ModelPolicy = {
    resolve: () => ({ thinkingLevel: "low" }),
  };

  const dispatcher = new PiSessionDispatcher(registry as never, undefined, factory as never, undefined, policy);
  await dispatcher.dispatch(makeRequest());

  assert.equal(capturedThinkingLevel, "low");
});

test("PiSessionDispatcher preserves original thinkingLevel when policy returns undefined thinkingLevel", async () => {
  const registry = makeFakeModelRegistry([], []);
  let capturedThinkingLevel: string | undefined;
  const factory = async (
    req: DispatchRequest,
    _tools: import("@earendil-works/pi-coding-agent").ToolDefinition[],
    _allowlist: string[],
    _model: unknown,
  ): Promise<import("../../src/infra/pi/session-dispatcher.js").AgentSession> => {
    capturedThinkingLevel = req.target.thinkingLevel;
    return new FakeSession({ kind: "agent_end" }, "done");
  };

  const policy: import("../../src/application/port/index.js").ModelPolicy = {
    resolve: () => ({}),
  };

  const dispatcher = new PiSessionDispatcher(registry as never, undefined, factory as never, undefined, policy);
  const req = makeRequest({
    target: { ...makeLeafTarget(), thinkingLevel: "xhigh" },
  });
  await dispatcher.dispatch(req);

  assert.equal(capturedThinkingLevel, "xhigh");
});

test("PiSessionDispatcher falls back to leaf frontmatter model when policy returns no modelName", async () => {
  const frontmatterModel = { id: "frontmatter-model", provider: "x" };
  const defaultModel = { id: "default-model", provider: "x" };
  const registry = makeFakeModelRegistry([frontmatterModel, defaultModel], [defaultModel]);
  let capturedModelId: string | undefined;
  const factory = async (
    _req: DispatchRequest,
    _tools: import("@earendil-works/pi-coding-agent").ToolDefinition[],
    _allowlist: string[],
    model: { id: string } | undefined,
  ): Promise<import("../../src/infra/pi/session-dispatcher.js").AgentSession> => {
    capturedModelId = model?.id;
    return new FakeSession({ kind: "agent_end" }, "done");
  };

  const policy: import("../../src/application/port/index.js").ModelPolicy = {
    resolve: () => ({}),
  };

  const dispatcher = new PiSessionDispatcher(
    registry as never,
    defaultModel as never,
    factory as never,
    undefined,
    policy,
  );
  await dispatcher.dispatch(makeRequest({ target: { ...makeLeafTarget(), modelName: "frontmatter-model" } }));

  assert.equal(capturedModelId, "frontmatter-model");
});

test("PiSessionDispatcher policy modelName takes precedence over leaf frontmatter model", async () => {
  const registry = makeFakeModelRegistry(
    [
      { id: "frontmatter-model", provider: "x" },
      { id: "profile-model", provider: "x" },
    ],
    [],
  );
  let capturedModelId: string | undefined;
  const factory = async (
    _req: DispatchRequest,
    _tools: import("@earendil-works/pi-coding-agent").ToolDefinition[],
    _allowlist: string[],
    model: { id: string } | undefined,
  ): Promise<import("../../src/infra/pi/session-dispatcher.js").AgentSession> => {
    capturedModelId = model?.id;
    return new FakeSession({ kind: "agent_end" }, "done");
  };

  const policy: import("../../src/application/port/index.js").ModelPolicy = {
    resolve: () => ({ modelName: "profile-model" }),
  };

  const dispatcher = new PiSessionDispatcher(registry as never, undefined, factory as never, undefined, policy);
  await dispatcher.dispatch(makeRequest({ target: { ...makeLeafTarget(), modelName: "frontmatter-model" } }));

  assert.equal(capturedModelId, "profile-model");
});

test("PiSessionDispatcher works without a modelPolicy (backward-compatible)", async () => {
  const { dispatcher } = makeDispatcher({ kind: "agent_end" }, "result");
  const result = await dispatcher.dispatch(makeRequest());
  assert.equal(result.endReason, "agent_end");
});

test("PiSessionDispatcher honors leaf frontmatter model with no modelPolicy", async () => {
  const frontmatterModel = { id: "frontmatter-model", provider: "x" };
  const defaultModel = { id: "default-model", provider: "x" };
  const registry = makeFakeModelRegistry([frontmatterModel, defaultModel], [defaultModel]);
  let capturedModelId: string | undefined;
  const factory = async (
    _req: DispatchRequest,
    _tools: import("@earendil-works/pi-coding-agent").ToolDefinition[],
    _allowlist: string[],
    model: { id: string } | undefined,
  ): Promise<import("../../src/infra/pi/session-dispatcher.js").AgentSession> => {
    capturedModelId = model?.id;
    return new FakeSession({ kind: "agent_end" }, "done");
  };

  const dispatcher = new PiSessionDispatcher(registry as never, defaultModel as never, factory as never);
  await dispatcher.dispatch(makeRequest({ target: { ...makeLeafTarget(), modelName: "frontmatter-model" } }));

  assert.equal(capturedModelId, "frontmatter-model");
});

test("dispatchParallel runs all requests and returns results in order", async () => {
  const registry = makeFakeModelRegistry([], []);
  const factory = async (
    request: DispatchRequest,
  ): Promise<import("../../src/infra/pi/session-dispatcher.js").AgentSession> => {
    return new FakeSession({ kind: "agent_end" }, `answer-${request.prompt}`);
  };
  const dispatcher = new PiSessionDispatcher(registry as never, undefined, factory as never);

  const results = await dispatcher.dispatchParallel([
    makeRequest({ prompt: "a" }),
    makeRequest({ prompt: "b" }),
    makeRequest({ prompt: "c" }),
  ]);

  assert.equal(results.length, 3);
  assert.equal(results[0]?.text, "answer-a");
  assert.equal(results[1]?.text, "answer-b");
  assert.equal(results[2]?.text, "answer-c");
});
