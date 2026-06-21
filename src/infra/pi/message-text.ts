import type { LeafAgentDefinition } from "../../application/port/index.js";
import { textFromContentParts } from "./content-text.js";

// ---------------------------------------------------------------------------
// Assistant-message extraction
// ---------------------------------------------------------------------------

/** Returns the text content of the last assistant message in a raw message list. */
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

// ---------------------------------------------------------------------------
// Content coercion
// ---------------------------------------------------------------------------

/**
 * Coerces a message content value to plain text.
 *
 * Handles three shapes:
 *   - plain string → returned as-is
 *   - array of strings or `{type:"text", text}` objects → joined with newline
 *   - anything else → empty string
 */
export function contentToText(content: unknown): string {
  return textFromContentParts(content, "\n");
}

// ---------------------------------------------------------------------------
// Leaf prompt builder
// ---------------------------------------------------------------------------

/** Builds the full prompt sent to a leaf agent: system body followed by the user prompt. */
export function buildLeafPrompt(definition: LeafAgentDefinition, prompt: string): string {
  return `${definition.body.trim()}\n\n${prompt.trim()}`;
}
