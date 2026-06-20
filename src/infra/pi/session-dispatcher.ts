import { access } from "node:fs/promises";

import {
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  createAgentSession,
  getAgentDir,
  type AgentSessionEvent,
  type AgentToolResult,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

import type {
  DispatchCustomToolCall,
  DispatchRequest,
  DispatchResult,
  Dispatcher,
  LeafAgentDefinition,
  ModelPolicy,
  StageOutcome,
} from "../../application/port/index.js";
import type { ActivityPresenter } from "./session-activity.js";
import { ActivityReporter } from "./session-activity.js";
import { createStageReturnTool, normalizeStageReturn, type StageReturnPayload } from "./stage-return-tool.js";

const DEFAULT_GENERIC_MAX_TURNS = 40;
const DEFAULT_LEAF_TIMEOUT_MS = 3_600_000;
const DEFAULT_GENERIC_TIMEOUT_MS = 600_000;
type DispatchEndReason = NonNullable<DispatchResult["endReason"]>;

export interface AgentSession {
  subscribe(handler: (event: AgentSessionEvent) => void): () => void;
  abort(): Promise<void>;
  prompt(text: string, options: { source: string }): Promise<void>;
  dispose(): void;
  messages: unknown[];
}

export type SessionFactory = (
  request: DispatchRequest,
  customTools: ToolDefinition[],
  toolAllowlist: string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK Model generic; Phase 7 will wrap with opaque ModelHandle
  model: Model<any> | undefined,
) => Promise<AgentSession>;

export class PiSessionDispatcher implements Dispatcher {
  private readonly sessionFactory: SessionFactory;

  constructor(
    private readonly modelRegistry: ModelRegistry,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK Model generic; Phase 7 will wrap with opaque ModelHandle
    private readonly currentModel?: Model<any>,
    sessionFactory?: SessionFactory,
    private readonly presenter?: ActivityPresenter,
    private readonly modelPolicy?: ModelPolicy,
  ) {
    this.sessionFactory = sessionFactory ?? this.buildDefaultSessionFactory();
  }

  private buildDefaultSessionFactory(): SessionFactory {
    return async (request, customTools, toolAllowlist, model) => {
      const target = request.target;
      const isLeaf = target.kind === "leaf";
      const loader = new DefaultResourceLoader({
        cwd: request.cwd,
        agentDir: getAgentDir(),
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        additionalExtensionPaths: isLeaf ? await existingPaths(target.extensions) : [],
        ...(isLeaf && target.systemPromptMode === "replace"
          ? { systemPromptOverride: (base: string | undefined) => target.body || base }
          : {}),
        ...(isLeaf && target.systemPromptMode === "append"
          ? { appendSystemPromptOverride: (base: string[]) => [...base, target.body] }
          : {}),
      });
      await loader.reload();

      const sessionOptions = {
        cwd: request.cwd,
        agentDir: getAgentDir(),
        modelRegistry: this.modelRegistry,
        thinkingLevel: (request.target.thinkingLevel ?? "high") as never,
        maxTurns: isLeaf ? target.maxTurns : DEFAULT_GENERIC_MAX_TURNS,
        tools: toolAllowlist,
        customTools,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(request.cwd),
        ...(model ? { model } : {}),
      };
      const { session } = await createAgentSession(sessionOptions);
      return session as AgentSession;
    };
  }

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    const customToolCalls: DispatchCustomToolCall[] = [];
    let resolveStageReturn: (() => void) | undefined;
    const stageReturn = new Promise<void>((resolve) => {
      resolveStageReturn = resolve;
    });
    // Cast opaque CustomTool[] to SDK ToolDefinition[] at the infrastructure boundary
    const sdkTools = (request.customTools ?? []) as unknown as ToolDefinition[];
    const customTools = instrumentCustomTools(sdkTools, customToolCalls, (toolName) => {
      if (toolName === "stage_return" || toolName === "goals_return" || toolName === "interview_return") {
        resolveStageReturn?.();
      }
    });
    const target = request.target;
    const isLeaf = target.kind === "leaf";
    const toolAllowlist = mergeToolAllowlist(target.tools, request.tools, customTools);
    const routing = this.modelPolicy?.resolve(target);
    // Precedence: tier-profile model (from .deeplooper/models.json) -> the agent's own
    // frontmatter model: -> pi session default. The frontmatter fallback keeps agents
    // honoring their declared model when no profile binding covers their tier.
    const modelName = routing?.modelName ?? (isLeaf ? target.modelName : undefined);
    const model = resolveModel(this.modelRegistry, this.currentModel, modelName);
    // When the policy supplies a thinking override, propagate it into the request
    // so the session factory (which reads request.target.thinkingLevel) picks it up.
    const effectiveRequest =
      routing?.thinkingLevel !== undefined
        ? { ...request, target: { ...target, thinkingLevel: routing.thinkingLevel } }
        : request;
    const session = await this.sessionFactory(effectiveRequest, customTools, toolAllowlist, model);

    // Attach live-activity reporter if a presenter is configured
    const correlationId = request.correlationId ?? request.target.name;
    const activityLabel = request.activityLabel ?? request.target.name;
    const reporter = this.presenter ? new ActivityReporter(correlationId, this.presenter) : undefined;

    if (reporter && this.presenter) {
      this.presenter.onSessionStart(correlationId, activityLabel);
      reporter.attach(session);
    }

    try {
      const endReason = await waitForPromptCompletion(
        session,
        request.prompt,
        stageReturn,
        request.signal,
        request.timeoutMs ?? (isLeaf ? DEFAULT_LEAF_TIMEOUT_MS : DEFAULT_GENERIC_TIMEOUT_MS),
      );
      const text = extractAssistantText(session.messages);
      return {
        text,
        messages: session.messages,
        customToolCalls,
        endReason,
      };
    } catch (error) {
      return {
        text: "",
        messages: session.messages,
        customToolCalls,
        endReason: request.signal?.aborted ? "aborted" : "session_error",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    } finally {
      reporter?.detach();
      this.presenter?.onSessionEnd(correlationId);
      session.dispose();
    }
  }

  async dispatchParallel(requests: DispatchRequest[]): Promise<DispatchResult[]> {
    return Promise.all(requests.map((request) => this.dispatch(request)));
  }

  async dispatchChain(requests: DispatchRequest[]): Promise<DispatchResult[]> {
    const results: DispatchResult[] = [];
    for (const request of requests) {
      const previous = results.at(-1)?.text ?? "";
      const prompt = request.prompt.replaceAll("{previous}", previous);
      results.push(await this.dispatch({ ...request, prompt }));
    }
    return results;
  }

  async dispatchGenericCoding(
    prompt: string,
    options?: { cwd?: string; tools?: string[]; signal?: AbortSignal; correlationId?: string; activityLabel?: string },
  ): Promise<StageOutcome> {
    const stageReturns: StageReturnPayload[] = [];
    const result = await this.dispatch({
      target: {
        kind: "generic",
        name: "generic-coding",
        tools: options?.tools ?? ["read", "bash", "edit", "write", "grep", "find", "ls"],
        thinkingLevel: "high",
      },
      prompt,
      cwd: options?.cwd ?? "",
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.correlationId ? { correlationId: options.correlationId } : {}),
      ...(options?.activityLabel ? { activityLabel: options.activityLabel } : {}),
      customTools: [createStageReturnTool(stageReturns)],
    });
    return normalizeStageReturn(result);
  }
}

export async function waitForPromptCompletion(
  session: AgentSession,
  prompt: string,
  stageReturn: Promise<void>,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<DispatchEndReason> {
  if (signal?.aborted) {
    void session.abort().catch(() => undefined);
    return "aborted";
  }

  let resolveDone!: (reason: DispatchEndReason) => void;
  const done = new Promise<DispatchEndReason>((resolve) => {
    resolveDone = resolve;
  });

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "agent_end") {
      resolveDone("agent_end");
    }
  });

  const abortListener = () => {
    void session.abort().catch(() => undefined);
    resolveDone("aborted");
  };
  signal?.addEventListener("abort", abortListener, { once: true });

  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<DispatchEndReason>((resolve) => {
    if (!timeoutMs || timeoutMs <= 0) {
      return;
    }
    timeout = setTimeout(() => {
      void session.abort().catch(() => undefined);
      resolve("timeout");
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      session.prompt(prompt, { source: "extension" }).then(() => "agent_end" as const),
      done,
      stageReturn.then(() => {
        void session.abort().catch(() => undefined);
        return "stage_return" as const;
      }),
      timeoutPromise,
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    signal?.removeEventListener("abort", abortListener);
    unsubscribe();
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any -- resolveModel works with SDK Model generic; Phase 7 will introduce opaque ModelHandle */
export function resolveModel(
  modelRegistry: ModelRegistry,
  currentModel: Model<any> | undefined,
  desiredModelName: string | undefined,
): Model<any> | undefined {
  const all = modelRegistry.getAll();
  if (desiredModelName) {
    const exact = all.find(
      (model) => model.id === desiredModelName || `${model.provider}/${model.id}` === desiredModelName,
    );
    if (exact) {
      return exact;
    }
  }
  return currentModel ?? modelRegistry.getAvailable()[0] ?? all[0];
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function mergeToolAllowlist(
  targetTools: string[],
  overrideTools: string[] | undefined,
  customTools: ToolDefinition[],
): string[] {
  const base = overrideTools ?? targetTools;
  const customNames = customTools.map((tool) => tool.name);
  return [...new Set([...base, ...customNames])];
}

export function instrumentCustomTools<T extends ToolDefinition[]>(
  tools: T,
  sink: DispatchCustomToolCall[],
  onToolCall: (toolName: string) => void,
): T {
  return tools.map((tool) => ({
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      const result = await tool.execute(toolCallId, params, signal, onUpdate, ctx);
      sink.push({ name: tool.name, result });
      onToolCall(tool.name);
      return result;
    },
  })) as T;
}

export async function existingPaths(paths: string[]): Promise<string[]> {
  const existing: string[] = [];
  for (const filePath of paths) {
    try {
      await access(filePath);
      existing.push(filePath);
    } catch {
      // Ignore missing optional extensions.
    }
  }
  return existing;
}

export function extractAssistantText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: string; content?: unknown };
    if (message?.role !== "assistant") {
      continue;
    }
    return contentToText(message.content);
  }
  return "";
}

export function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (
          item &&
          typeof item === "object" &&
          "text" in item &&
          typeof (item as { text?: unknown }).text === "string"
        ) {
          return (item as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function buildLeafPrompt(definition: LeafAgentDefinition, prompt: string): string {
  return `${definition.body.trim()}\n\n${prompt.trim()}`;
}
