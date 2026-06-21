import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

import type {
  DispatchCustomToolCall,
  DispatchRequest,
  DispatchResult,
  Dispatcher,
  ModelPolicy,
  StageOutcome,
} from "../../application/port/index.js";
import { ActivityReporter, type ActivityPresenter } from "./session-activity.js";
import { buildDefaultSessionFactory, type AgentSession, type SessionFactory } from "./session-factory.js";
import { waitForPromptCompletion } from "./prompt-completion.js";
import { resolveModel, mergeToolAllowlist, instrumentCustomTools } from "./model-resolution.js";
import { extractAssistantText } from "./message-text.js";
import { createStageReturnTool, normalizeStageReturn, type StageReturnPayload } from "./stage-return-tool.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tool names whose invocation signals that a stage has produced its structured result. */
const RETURN_TOOL_NAMES: readonly string[] = ["stage_return", "goals_return", "interview_return"];

/** Default tool set for generic-coding sessions when the caller does not override. */
const DEFAULT_GENERIC_CODING_TOOLS: string[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];

const DEFAULT_LEAF_TIMEOUT_MS = 3_600_000;
const DEFAULT_GENERIC_TIMEOUT_MS = 600_000;

// ---------------------------------------------------------------------------
// PiSessionDispatcher
// ---------------------------------------------------------------------------

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
    this.sessionFactory = sessionFactory ?? buildDefaultSessionFactory(this.modelRegistry);
  }

  // ---------------------------------------------------------------------------
  // Public dispatch methods
  // ---------------------------------------------------------------------------

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    const { customTools, customToolCalls, stageReturn } = this.buildInstrumentedTools(request);
    const target = request.target;
    const isLeaf = target.kind === "leaf";
    const toolAllowlist = mergeToolAllowlist(target.tools, request.tools, customTools);
    const { effectiveRequest, model } = this.buildModelRouting(request);
    const session = await this.sessionFactory(effectiveRequest, customTools, toolAllowlist, model);

    const correlationId = request.correlationId ?? request.target.name;
    const activityLabel = request.activityLabel ?? request.target.name;
    const reporter = this.attachReporter(session, correlationId, activityLabel);

    try {
      const endReason = await waitForPromptCompletion(
        session,
        request.prompt,
        stageReturn,
        request.signal,
        request.timeoutMs ?? (isLeaf ? DEFAULT_LEAF_TIMEOUT_MS : DEFAULT_GENERIC_TIMEOUT_MS),
      );
      return {
        text: extractAssistantText(session.messages),
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
        tools: options?.tools ?? DEFAULT_GENERIC_CODING_TOOLS,
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

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Instruments the request's custom tools and wires the stage-return promise. */
  private buildInstrumentedTools(request: DispatchRequest): {
    customTools: ToolDefinition[];
    customToolCalls: DispatchCustomToolCall[];
    stageReturn: Promise<void>;
  } {
    const customToolCalls: DispatchCustomToolCall[] = [];
    let resolveStageReturn: (() => void) | undefined;
    const stageReturn = new Promise<void>((resolve) => {
      resolveStageReturn = resolve;
    });
    // Cast opaque CustomTool[] to SDK ToolDefinition[] at the infrastructure boundary
    const sdkTools = (request.customTools ?? []) as unknown as ToolDefinition[];
    const customTools = instrumentCustomTools(sdkTools, customToolCalls, (toolName) => {
      if (RETURN_TOOL_NAMES.includes(toolName)) {
        resolveStageReturn?.();
      }
    });
    return { customTools, customToolCalls, stageReturn };
  }

  /* eslint-disable @typescript-eslint/no-explicit-any -- SDK Model generic; Phase 7 will introduce opaque ModelHandle */
  /**
   * Resolves the effective model and request to use for this dispatch.
   *
   * Precedence for model: tier-profile binding → leaf agent frontmatter → pi session default.
   * When the policy supplies a thinking override it is merged into the returned request
   * so the session factory picks it up.
   */
  private buildModelRouting(request: DispatchRequest): {
    effectiveRequest: DispatchRequest;
    model: Model<any> | undefined;
  } {
    const target = request.target;
    const routing = this.modelPolicy?.resolve(target);
    const leafModelName = target.kind === "leaf" ? target.modelName : undefined;
    const modelName = routing?.modelName ?? leafModelName;
    const model = resolveModel(this.modelRegistry, this.currentModel, modelName);
    const effectiveRequest =
      routing?.thinkingLevel !== undefined
        ? { ...request, target: { ...target, thinkingLevel: routing.thinkingLevel } }
        : request;
    return { effectiveRequest, model };
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  /**
   * Attaches a live-activity reporter to the session if a presenter is configured.
   * Returns the reporter (for later detach) or undefined in headless runs.
   */
  private attachReporter(
    session: AgentSession,
    correlationId: string,
    activityLabel: string,
  ): ActivityReporter | undefined {
    if (!this.presenter) return undefined;
    const reporter = new ActivityReporter(correlationId, this.presenter);
    this.presenter.onSessionStart(correlationId, activityLabel);
    reporter.attach(session);
    return reporter;
  }
}

// ---------------------------------------------------------------------------
// Re-exports — keep all symbols importable from this module's original path
// ---------------------------------------------------------------------------

export type { AgentSession, SessionFactory } from "./session-factory.js";
export { waitForPromptCompletion } from "./prompt-completion.js";
export { resolveModel, mergeToolAllowlist, instrumentCustomTools } from "./model-resolution.js";
export { extractAssistantText, contentToText, buildLeafPrompt } from "./message-text.js";
export { existingPaths } from "./fs-paths.js";
