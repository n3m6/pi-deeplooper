import { type ModelRegistry, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

import type { DispatchCustomToolCall } from "../../application/port/index.js";

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any -- resolveModel works with SDK Model generic; Phase 7 will introduce opaque ModelHandle */
/**
 * Resolves which model to use for a dispatch.
 *
 * Lookup order:
 *   1. Exact match by `desiredModelName` (id or provider/id format).
 *   2. `currentModel` (the model active in the pi session).
 *   3. First available model from the registry.
 *   4. First registered model (regardless of availability).
 */
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

// ---------------------------------------------------------------------------
// Tool allowlist
// ---------------------------------------------------------------------------

/**
 * Merges the target's declared tool list, an optional per-request override, and the
 * names of any custom tools into a deduplicated allowlist for the session.
 *
 * `overrideTools` (when present) replaces `targetTools` as the base set.
 */
export function mergeToolAllowlist(
  targetTools: string[],
  overrideTools: string[] | undefined,
  customTools: ToolDefinition[],
): string[] {
  const base = overrideTools ?? targetTools;
  const customNames = customTools.map((tool) => tool.name);
  return [...new Set([...base, ...customNames])];
}

// ---------------------------------------------------------------------------
// Custom tool instrumentation
// ---------------------------------------------------------------------------

/**
 * Wraps each tool so that every invocation is recorded in `sink` and
 * `onToolCall` is notified with the tool name after the execute resolves.
 *
 * The wrapper is transparent: it forwards all arguments and returns the original
 * result unchanged.
 */
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
