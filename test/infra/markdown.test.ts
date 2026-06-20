import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeNewlines,
  parseMarkdownSections,
  parseKeyValueLines,
  asOneLine,
  parseFrontmatterDate,
  extractStatusLine,
  extractSummary,
  extractCodeBlock,
  parsePipeTable,
} from "../../src/infra/codec/markdown-codec.js";

// ---------------------------------------------------------------------------
// normalizeNewlines
// ---------------------------------------------------------------------------

test("normalizeNewlines converts CRLF to LF", () => {
  assert.equal(normalizeNewlines("a\r\nb\r\nc"), "a\nb\nc");
});

test("normalizeNewlines leaves LF-only text unchanged", () => {
  assert.equal(normalizeNewlines("a\nb\nc"), "a\nb\nc");
});

test("normalizeNewlines handles empty string", () => {
  assert.equal(normalizeNewlines(""), "");
});

test("normalizeNewlines leaves CR-only unchanged (macOS legacy)", () => {
  assert.equal(normalizeNewlines("a\rb\rc"), "a\rb\rc");
});

// ---------------------------------------------------------------------------
// parseMarkdownSections
// ---------------------------------------------------------------------------

test("parseMarkdownSections parses ### headings into sections", () => {
  const sections = parseMarkdownSections("### Foo\n\nContent A.\n\n### Bar\n\nContent B.");
  assert.equal(sections["Foo"], "Content A.");
  assert.equal(sections["Bar"], "Content B.");
});

test("parseMarkdownSections handles CRLF line endings", () => {
  const sections = parseMarkdownSections("### Alpha\r\n\r\nData.\r\n### Beta\r\n\r\nMore.");
  assert.equal(sections["Alpha"], "Data.");
  assert.equal(sections["Beta"], "More.");
});

test("parseMarkdownSections returns empty object for text with no ### headings", () => {
  assert.deepEqual(parseMarkdownSections("No headings here."), {});
});

test("parseMarkdownSections trims whitespace from section content", () => {
  const sections = parseMarkdownSections("### Section\n\n  trimmed  \n\n");
  assert.equal(sections["Section"], "trimmed");
});

test("parseMarkdownSections handles sections with no content between headings", () => {
  const sections = parseMarkdownSections("### A\n### B\n\nContent.");
  assert.equal(sections["A"], "");
  assert.equal(sections["B"], "Content.");
});

// ---------------------------------------------------------------------------
// parseKeyValueLines
// ---------------------------------------------------------------------------

test("parseKeyValueLines parses key: value lines", () => {
  const result = parseKeyValueLines("route: full\nphase: 2");
  assert.equal(result["route"], "full");
  assert.equal(result["phase"], "2");
});

test("parseKeyValueLines handles CRLF", () => {
  const result = parseKeyValueLines("a: 1\r\nb: 2\r\n");
  assert.equal(result["a"], "1");
  assert.equal(result["b"], "2");
});

test("parseKeyValueLines ignores lines without colons", () => {
  const result = parseKeyValueLines("no value here\nkey: value");
  assert.equal(Object.keys(result).length, 1);
  assert.equal(result["key"], "value");
});

test("parseKeyValueLines handles dashes and underscores in keys", () => {
  const result = parseKeyValueLines("run_id: abc\ntotal-phases: 3");
  assert.equal(result["run_id"], "abc");
  assert.equal(result["total-phases"], "3");
});

test("parseKeyValueLines trims whitespace from values", () => {
  const result = parseKeyValueLines("key:    padded value   ");
  assert.equal(result["key"], "padded value");
});

// ---------------------------------------------------------------------------
// asOneLine
// ---------------------------------------------------------------------------

test("asOneLine joins multi-line text on a single line", () => {
  assert.equal(asOneLine("  hello  \n  world  "), "hello world");
});

test("asOneLine filters out blank lines", () => {
  assert.equal(asOneLine("a\n\nb"), "a b");
});

test("asOneLine handles single line", () => {
  assert.equal(asOneLine("single"), "single");
});

test("asOneLine handles CRLF", () => {
  assert.equal(asOneLine("a\r\nb"), "a b");
});

// ---------------------------------------------------------------------------
// parseFrontmatterDate
// ---------------------------------------------------------------------------

test("parseFrontmatterDate extracts the created field from YAML frontmatter", () => {
  const md = "---\ncreated: 2026-06-01\nroute: full\n---\n\nContent.";
  assert.equal(parseFrontmatterDate(md), "2026-06-01");
});

test("parseFrontmatterDate returns undefined when no frontmatter", () => {
  assert.equal(parseFrontmatterDate("No frontmatter here."), undefined);
});

test("parseFrontmatterDate returns undefined when created field is missing", () => {
  const md = "---\nroute: full\n---\n\nContent.";
  assert.equal(parseFrontmatterDate(md), undefined);
});

test("parseFrontmatterDate handles CRLF in frontmatter", () => {
  const md = "---\r\ncreated: 2026-06-02\r\nroute: full\r\n---\r\n\r\nContent.";
  assert.equal(parseFrontmatterDate(md), "2026-06-02");
});

// ---------------------------------------------------------------------------
// extractStatusLine
// ---------------------------------------------------------------------------

test("extractStatusLine extracts the status portion from a ### Status heading", () => {
  assert.equal(extractStatusLine("### Status — PASS\n\nDetails."), "PASS");
  assert.equal(extractStatusLine("### Status — FAIL\n\nDetails."), "FAIL");
});

test("extractStatusLine uses em-dash or hyphen-minus", () => {
  assert.equal(extractStatusLine("### Status - PARTIAL"), "PARTIAL");
});

test("extractStatusLine returns undefined when no status heading", () => {
  assert.equal(extractStatusLine("No status here."), undefined);
});

// ---------------------------------------------------------------------------
// extractSummary
// ---------------------------------------------------------------------------

test("extractSummary returns the Summary section content when present", () => {
  const md = "### Summary\n\nThis is the summary text.";
  assert.equal(extractSummary(md), "This is the summary text.");
});

test("extractSummary falls back to the first 240 characters of the text when no Summary section", () => {
  const md = "No section heading but there is some text that should appear.";
  assert.equal(extractSummary(md), "No section heading but there is some text that should appear.");
});

test("extractSummary truncates to 240 characters when no Summary section and text is very long", () => {
  const long = "word ".repeat(100);
  const result = extractSummary(long);
  assert.ok(result.length <= 240, `Expected <= 240, got ${result.length}`);
});

// ---------------------------------------------------------------------------
// extractCodeBlock
// ---------------------------------------------------------------------------

test("extractCodeBlock returns the content of the first code block", () => {
  const md = 'Some text\n\n```json\n{ "key": "value" }\n```\n\nMore text.';
  assert.equal(extractCodeBlock(md), '{ "key": "value" }');
});

test("extractCodeBlock returns undefined when no code block exists", () => {
  assert.equal(extractCodeBlock("No code here."), undefined);
});

test("extractCodeBlock works with unlabelled code blocks", () => {
  const md = "```\nraw content\n```";
  assert.equal(extractCodeBlock(md), "raw content");
});

// ---------------------------------------------------------------------------
// parsePipeTable
// ---------------------------------------------------------------------------

test("parsePipeTable parses a simple pipe table", () => {
  const md = "| A | B | C |\n| - | - | - |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |";
  const rows = parsePipeTable(md);
  assert.equal(rows.length, 3); // header + 2 data rows (separator filtered)
  assert.deepEqual(rows[0], ["A", "B", "C"]);
  assert.deepEqual(rows[1], ["1", "2", "3"]);
});

test("parsePipeTable filters out separator rows", () => {
  const md = "| A | B |\n| --- | --- |\n| 1 | 2 |";
  const rows = parsePipeTable(md);
  assert.equal(rows.length, 2); // header + data, separator filtered
  assert.deepEqual(rows[0], ["A", "B"]);
});

test("parsePipeTable returns empty array for text with no pipe table", () => {
  assert.deepEqual(parsePipeTable("No table here."), []);
});

test("parsePipeTable handles CRLF in tables", () => {
  const md = "| A | B |\r\n| --- | --- |\r\n| 1 | 2 |";
  const rows = parsePipeTable(md);
  assert.ok(rows.length >= 1);
  assert.deepEqual(rows[0], ["A", "B"]);
});

test("parsePipeTable trims cell whitespace", () => {
  const md = "|  A  |  B  |\n|  1  |  2  |";
  const rows = parsePipeTable(md);
  assert.deepEqual(rows[0], ["A", "B"]);
  assert.deepEqual(rows[1], ["1", "2"]);
});
