/**
 * Utilities for inspecting built-in tool usage in dispatched session message transcripts.
 *
 * Built-in tools (websearch, webfetch, bash, etc.) are not instrumented as custom tools,
 * so their calls do not appear in DispatchResult.customToolCalls. However, when the
 * underlying model actually invokes a built-in tool, the SDK records a tool_use content
 * part in the raw session message transcript. When the model only *describes* a tool call
 * in prose (outputting literal <tool_call> markup instead of running the tool), no such
 * entry appears.
 */

/** Sentinel phrase emitted by dl-web-researcher when no relevant sources were found. */
const NO_SOURCES_SENTINEL = "No relevant external sources found for this question.";

/** Matches literal tool-call or bash markup accidentally emitted as assistant text. */
const INERT_MARKUP_PATTERN = /<tool_call\b|<\/tool_call>|<bash>|<\/bash>/i;

/** Requires at least one https?:// reference in the text. */
const URL_PATTERN = /https?:\/\/\S+/;

/**
 * Counts the number of times any tool from the given set was invoked as a built-in
 * tool call in the raw session message transcript.
 *
 * A built-in tool call appears as a message content part with `type: "tool_use"` and a
 * `name` matching one of the requested tool names. Returns 0 when the model described
 * tool calls in prose without actually executing them.
 */
export function countBuiltinToolCalls(messages: unknown[], toolNames: string[]): number {
  const nameSet = new Set(toolNames);
  let count = 0;
  for (const message of messages) {
    const content = (message as { content?: unknown })?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const p = part as { type?: unknown; name?: unknown };
      if (p?.type === "tool_use" && typeof p.name === "string" && nameSet.has(p.name)) {
        count++;
      }
    }
  }
  return count;
}

/**
 * Returns true when a web researcher's output text contains no real evidence:
 *
 * - The text contains literal `<tool_call>` / `<bash>` markup (the model described a
 *   call as prose instead of running it), OR
 * - The text has no URL references AND does not contain the explicit
 *   "No relevant external sources found" sentinel defined by the agent contract.
 *
 * Only applies to `web` / `hybrid` questions; do not use for codebase researchers.
 */
export function isNoEvidenceText(text: string): boolean {
  if (INERT_MARKUP_PATTERN.test(text)) {
    return true;
  }
  if (!URL_PATTERN.test(text) && !text.includes(NO_SOURCES_SENTINEL)) {
    return true;
  }
  return false;
}

/**
 * Stable hashing of concatenated artifact texts used for no-progress detection.
 *
 * Returns a hex digest of the joined input strings. Two calls with materially
 * identical artifact content return the same hash regardless of call-site.
 */
export function hashArtifactTexts(texts: string[]): string {
  // Use a simple but stable polynomial hash so we avoid importing node:crypto.
  // Collision probability over ~5 artifact rounds is negligible for this use case.
  let h = 0x811c9dc5;
  const joined = texts.join("\n---\n");
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    h = (Math.imul(h, 0x01000193) | 0) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
