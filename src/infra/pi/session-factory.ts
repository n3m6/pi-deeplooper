import {
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  createAgentSession,
  getAgentDir,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

import type { DispatchRequest } from "../../application/port/index.js";
import { existingPaths } from "./fs-paths.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal interface over the SDK's agent session, used at the dispatcher boundary. */
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

// ---------------------------------------------------------------------------
// Default session factory
// ---------------------------------------------------------------------------

/** Fall-back max-turn budget for generic-coding sessions (no leaf frontmatter). */
const DEFAULT_GENERIC_MAX_TURNS = 40;

/**
 * Builds the default SessionFactory backed by `createAgentSession`.
 *
 * Each call to the returned factory:
 *   1. Constructs a minimal `DefaultResourceLoader` (no extensions, skills,
 *      themes, or context files) to isolate sub-sessions from the host session.
 *   2. Applies any system-prompt override declared in the leaf agent's frontmatter
 *      (`systemPromptMode: "replace"` or `"append"`).
 *   3. Creates and returns the session, exposing it through the `AgentSession` interface.
 */
export function buildDefaultSessionFactory(modelRegistry: ModelRegistry): SessionFactory {
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
      modelRegistry,
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
