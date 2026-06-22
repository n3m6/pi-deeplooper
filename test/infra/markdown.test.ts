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
  parseSliceManifest,
  designDeclaresSlices,
  normalizeAgentSection,
  isEmptySectionValue,
  parseDoneChecklist,
  parseBlockedCriteria,
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

// ---------------------------------------------------------------------------
// parseSliceManifest
// ---------------------------------------------------------------------------

const VALID_MANIFEST_MD = `# Design

## Vertical Slices

### Slice 1: Health endpoint

## Slice Manifest

\`\`\`json
{
  "slices": [
    {
      "id": "S1",
      "title": "Health endpoint",
      "deps": [],
      "acceptanceCriteria": ["GET /health returns 200"]
    },
    {
      "id": "S2",
      "title": "Auth endpoint",
      "deps": ["S1"],
      "acceptanceCriteria": ["POST /login returns token", "Invalid creds return 401"]
    }
  ]
}
\`\`\`

## Other Section
Ignored.
`;

test("parseSliceManifest returns ok:true with well-formed manifest", () => {
  const result = parseSliceManifest(VALID_MANIFEST_MD);
  assert.ok(result.ok, "expected ok: true");
  if (!result.ok) return;
  assert.equal(result.slices.length, 2);
  assert.equal(result.slices[0]?.id, "S1");
  assert.deepEqual(result.slices[0]?.deps, []);
  assert.deepEqual(result.slices[0]?.acceptanceCriteria, ["GET /health returns 200"]);
  assert.equal(result.slices[1]?.id, "S2");
  assert.deepEqual(result.slices[1]?.deps, ["S1"]);
});

test("parseSliceManifest returns ok:false when section is absent", () => {
  const result = parseSliceManifest("# Design\n\n## Vertical Slices\n\n### S1: Foo\n");
  assert.ok(!result.ok);
});

test("parseSliceManifest returns ok:false when JSON is malformed", () => {
  const md = `# Design\n\n## Slice Manifest\n\n\`\`\`json\n{ broken json\n\`\`\`\n`;
  const result = parseSliceManifest(md);
  assert.ok(!result.ok);
});

test("parseSliceManifest returns ok:false when id contains spaces", () => {
  const md = `# Design\n\n## Slice Manifest\n\n\`\`\`json\n{"slices":[{"id":"Slice 1","title":"x","deps":[],"acceptanceCriteria":["y"]}]}\n\`\`\`\n`;
  const result = parseSliceManifest(md);
  assert.ok(!result.ok);
});

test("parseSliceManifest returns ok:false when acceptanceCriteria is empty", () => {
  const md = `# Design\n\n## Slice Manifest\n\n\`\`\`json\n{"slices":[{"id":"S1","title":"x","deps":[],"acceptanceCriteria":[]}]}\n\`\`\`\n`;
  const result = parseSliceManifest(md);
  assert.ok(!result.ok);
});

// ---------------------------------------------------------------------------
// designDeclaresSlices
// ---------------------------------------------------------------------------

test("designDeclaresSlices returns true when ## Slice Manifest is present", () => {
  assert.ok(designDeclaresSlices("# Design\n\n## Slice Manifest\n\n```json\n{}\n```\n"));
});

test("designDeclaresSlices returns true when ## Vertical Slices is present", () => {
  assert.ok(designDeclaresSlices("# Design\n\n## Vertical Slices\n\n### S1: Foo\n"));
});

test("designDeclaresSlices returns false for design without slice sections", () => {
  assert.ok(!designDeclaresSlices("# Design\n\n## Approach\n\nJust prose.\n"));
});

// ---------------------------------------------------------------------------
// normalizeAgentSection
// ---------------------------------------------------------------------------

test("normalizeAgentSection trims surrounding whitespace", () => {
  assert.equal(normalizeAgentSection("  hello  "), "hello");
});

test("normalizeAgentSection strips trailing stray fence after content", () => {
  const raw = "Some content.\n```";
  assert.equal(normalizeAgentSection(raw), "Some content.");
});

test('normalizeAgentSection handles the "None.\\n```" stray fence pattern', () => {
  const raw = "None.\n```";
  assert.equal(normalizeAgentSection(raw), "None.");
});

test("normalizeAgentSection does not strip balanced fences", () => {
  const raw = "```typescript\nconst x = 1;\n```";
  assert.equal(normalizeAgentSection(raw), raw);
});

test("normalizeAgentSection handles multiple balanced fences", () => {
  const raw = "Before.\n```json\n{}\n```\nAfter.";
  assert.equal(normalizeAgentSection(raw), raw);
});

// ---------------------------------------------------------------------------
// isEmptySectionValue
// ---------------------------------------------------------------------------

test('isEmptySectionValue returns true for "None."', () => {
  assert.ok(isEmptySectionValue("None."));
});

test('isEmptySectionValue returns true for "none"', () => {
  assert.ok(isEmptySectionValue("none"));
});

test('isEmptySectionValue returns true for "NONE."', () => {
  assert.ok(isEmptySectionValue("NONE."));
});

test("isEmptySectionValue returns true for empty string", () => {
  assert.ok(isEmptySectionValue(""));
});

test("isEmptySectionValue returns true for whitespace-only string", () => {
  assert.ok(isEmptySectionValue("   "));
});

test("isEmptySectionValue returns false for valid content", () => {
  assert.ok(!isEmptySectionValue("## FR1\nBuild a server."));
});

// ---------------------------------------------------------------------------
// parseDoneChecklist
// ---------------------------------------------------------------------------

test("parseDoneChecklist parses file-exists item", () => {
  const md = `## Done Checklist\n- file-exists: src/app.ts\n`;
  const { items, unsupportedLines } = parseDoneChecklist(md);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], { kind: "file-exists", path: "src/app.ts" });
  assert.equal(unsupportedLines.length, 0);
});

test("parseDoneChecklist parses symbol-exists item", () => {
  const md = `## Done Checklist\n- symbol-exists: createApp in src/app.ts\n`;
  const { items } = parseDoneChecklist(md);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], { kind: "symbol-exists", symbol: "createApp", path: "src/app.ts" });
});

test("parseDoneChecklist parses command-exits-0 item", () => {
  const md = `## Done Checklist\n- command-exits-0: npm run build\n`;
  const { items } = parseDoneChecklist(md);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], { kind: "command-exits-0", command: "npm run build" });
});

test("parseDoneChecklist parses test-passes item", () => {
  const md = `## Done Checklist\n- test-passes: npm test -- --grep health\n`;
  const { items } = parseDoneChecklist(md);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], { kind: "test-passes", description: "npm test -- --grep health" });
});

test("parseDoneChecklist parses multiple items", () => {
  const md = [
    "## Done Checklist",
    "- file-exists: src/server.ts",
    "- command-exits-0: npm run build",
    "- test-passes: npm test",
  ].join("\n");
  const { items } = parseDoneChecklist(md);
  assert.equal(items.length, 3);
  assert.equal(items[0]?.kind, "file-exists");
  assert.equal(items[1]?.kind, "command-exits-0");
  assert.equal(items[2]?.kind, "test-passes");
});

test("parseDoneChecklist collects unsupported item kinds", () => {
  const md = `## Done Checklist\n- unknown-kind: something\n`;
  const { items, unsupportedLines } = parseDoneChecklist(md);
  assert.equal(items.length, 0);
  assert.equal(unsupportedLines.length, 1);
  assert.ok(unsupportedLines[0]?.includes("unknown-kind"));
});

test("parseDoneChecklist returns empty when section absent", () => {
  const { items, unsupportedLines } = parseDoneChecklist("# Task\n\nSome prose.\n");
  assert.equal(items.length, 0);
  assert.equal(unsupportedLines.length, 0);
});

// ---------------------------------------------------------------------------
// parseBlockedCriteria
// ---------------------------------------------------------------------------

test("parseBlockedCriteria extracts blocked criteria from pipe table", () => {
  const md = [
    "| # | Criterion | Test file | Action | Notes |",
    "|---|-----------|-----------|--------|-------|",
    "| 1 | GET /health returns 200 | tests/health.test.ts | write | |",
    "| 2 | Git commit exists | — | blocked | process criterion |",
    "| 3 | Server starts in < 5s | — | blocked | load test required |",
  ].join("\n");
  const blocked = parseBlockedCriteria(md);
  assert.equal(blocked.length, 2);
  assert.ok(blocked.includes("Git commit exists"));
  assert.ok(blocked.includes("Server starts in < 5s"));
});

test("parseBlockedCriteria returns empty for table with no blocked rows", () => {
  const md = [
    "| # | Criterion | Test file | Action | Notes |",
    "|---|-----------|-----------|--------|-------|",
    "| 1 | GET /health returns 200 | tests/health.test.ts | write | |",
  ].join("\n");
  assert.deepEqual(parseBlockedCriteria(md), []);
});

test("parseBlockedCriteria returns empty for malformed / empty input", () => {
  assert.deepEqual(parseBlockedCriteria(""), []);
  assert.deepEqual(parseBlockedCriteria("No table here."), []);
});
