/**
 * Shared content-parts text extractor for the pi adapter.
 *
 * The SDK surfaces message content as either a plain string or an array of
 * content-part objects shaped like `{type:"text", text:"..."}`.  The same
 * walking logic was duplicated across three places:
 *
 *   - message-text.ts   (contentToText, joins with "\n")
 *   - session-activity.ts (extractPartialText + extractMessageText, join with "")
 *
 * `textFromContentParts` provides the single implementation; callers supply
 * the appropriate `separator` for their context.
 */

/**
 * Extracts text from a raw content value.
 *
 *   - Plain string       → returned as-is.
 *   - Array              → each item is inspected; strings are taken directly,
 *                          objects with a string `text` property contribute that text.
 *   - Anything else      → empty string.
 *
 * The optional `separator` is used to join the extracted text pieces.
 * Use `"\n"` for multi-block message content, `""` for streaming output chunks.
 */
export function textFromContentParts(content: unknown, separator = ""): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (item && typeof item === "object" && "text" in item && typeof (item as { text?: unknown }).text === "string") {
        return (item as { text: string }).text;
      }
      return "";
    })
    .filter(Boolean)
    .join(separator);
}
