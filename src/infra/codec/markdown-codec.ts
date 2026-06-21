/**
 * MarkdownCodec — anti-corruption layer between raw agent text output and typed domain values.
 * Owns all markdown parsing utilities. Other modules import from here, not from markdown.ts.
 */

import type { Route, VerifyStatus } from "../../application/port/index.js";

// ---------------------------------------------------------------------------
// Low-level string utilities
// ---------------------------------------------------------------------------

export interface SectionMap {
  [heading: string]: string;
}

export function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

export function parseMarkdownSections(markdown: string): SectionMap {
  const lines = normalizeNewlines(markdown).split("\n");
  const sections: SectionMap = {};
  let current: string | undefined;
  let buffer: string[] = [];

  const flush = () => {
    if (!current) {
      return;
    }
    sections[current] = buffer.join("\n").trim();
    buffer = [];
  };

  for (const line of lines) {
    const match = line.match(/^###\s+(.+?)\s*$/);
    if (match) {
      flush();
      current = match[1];
      continue;
    }
    if (current) {
      buffer.push(line);
    }
  }

  flush();
  return sections;
}

export function parseFrontmatterDate(markdown: string): string | undefined {
  const match = normalizeNewlines(markdown).match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return undefined;
  }
  const frontmatterBlock = match[1] ?? "";
  const created = frontmatterBlock.match(/^created:\s*(.+)$/m);
  return created?.[1]?.trim();
}

export function parseKeyValueLines(markdown: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of normalizeNewlines(markdown).split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
    if (match) {
      const key = match[1];
      const value = match[2];
      if (key && value) {
        values[key] = value.trim();
      }
    }
  }
  return values;
}

export function asOneLine(text: string): string {
  return normalizeNewlines(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

export function extractStatusLine(markdown: string): string | undefined {
  return normalizeNewlines(markdown)
    .match(/^### Status\s+[—-]\s+(.+)$/m)?.[1]
    ?.trim();
}

export function extractSummary(markdown: string): string {
  const sections = parseMarkdownSections(markdown);
  return sections.Summary ? asOneLine(sections.Summary) : asOneLine(markdown).slice(0, 240);
}

export function extractCodeBlock(markdown: string): string | undefined {
  const match = normalizeNewlines(markdown).match(/```(?:[a-z]+)?\n([\s\S]*?)\n```/);
  return match?.[1];
}

export function parsePipeTable(markdown: string): string[][] {
  const rows = normalizeNewlines(markdown)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"));

  return rows
    .filter((line) => !/^(\|\s*-+\s*)+\|$/.test(line))
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );
}

// ---------------------------------------------------------------------------
// Higher-level semantic parsers
// ---------------------------------------------------------------------------

export function parseReviewStatus(markdown: string): "PASS" | "FAIL" {
  return /^### Status\s+[—-]\s+PASS\b/m.test(markdown) ? "PASS" : "FAIL";
}

export function parseOverallStatus(markdown: string): "PASS" | "PARTIAL" | "FAIL" {
  const m = markdown.match(/^###\s+(?:Overall\s+)?Status\s+[—-]\s+(PASS|PARTIAL|FAIL)\b/im);
  if (!m) {
    return "FAIL";
  }
  const s = m[1]?.toUpperCase();
  return s === "PASS" ? "PASS" : s === "PARTIAL" ? "PARTIAL" : "FAIL";
}

export function parseVerifyStatus(markdown: string): VerifyStatus | undefined {
  const status =
    markdown.match(/###\s+Overall\s+Status\s+[—-]\s+(PASS|PARTIAL|FAIL)\b/i)?.[1]?.toUpperCase() ??
    markdown.match(/###\s+Status\s+[—-]\s+(PASS|PARTIAL|FAIL)\b/i)?.[1]?.toUpperCase();
  return status === "PASS" || status === "PARTIAL" || status === "FAIL" ? status : undefined;
}

export function parseTotalPhases(markdown: string): number {
  const raw = parseKeyValueLines(markdown).total_phases ?? "";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export function parseRoute(markdown: string): Route {
  const route = parseKeyValueLines(markdown).route;
  return route === "full" ? "full" : "full";
}

export function extractPhaseSection(manifest: string, phase: number): string | undefined {
  const sections = parseMarkdownSections(manifest);
  return sections[`Phase ${phase}`] ?? sections[`Phase ${String(phase)}`];
}

export function extractFixGuidance(markdown: string): string {
  const sections = parseMarkdownSections(markdown);
  return sections["Fix Guidance"] ?? "None.";
}

export function requireMarkdownSection(markdown: string, sectionName: string): string {
  const sections = parseMarkdownSections(markdown);
  const section = sections[sectionName];
  if (!section) {
    throw new Error(`Missing markdown section: ${sectionName}`);
  }
  return section;
}

export interface TaskSpecMetadata {
  taskId: string;
  taskPhase: string;
  title: string;
  dependencies: string[];
}

export function parseTaskSpecMetadata(content: string, phaseHint: number): TaskSpecMetadata {
  const normalized = normalizeNewlines(content);
  const taskId = normalized.match(/\*\*Task:\*\*\s*(\d+)/)?.[1] ?? String(phaseHint).padStart(2, "0");
  const taskPhase = normalized.match(/\*\*Phase:\*\*\s*(.+)$/m)?.[1]?.trim() ?? String(phaseHint);
  const title = normalized.match(/^# Task \d+:\s+(.+)$/m)?.[1]?.trim() ?? taskId;
  const dependenciesBlock = normalized.match(/## Dependencies\n([\s\S]*?)(?=\n## )/)?.[1] ?? "";
  const dependencies = [...dependenciesBlock.matchAll(/\b(\d{2})\b/g)]
    .map((match) => match[1])
    .filter((dep): dep is string => Boolean(dep));
  return { taskId, taskPhase, title, dependencies };
}

/** Parses the affected artifact type from an integration-checker backward-loop request. */
export function parseAffectedArtifact(markdown: string): "design" | "structure" | "plan" {
  const raw = markdown.match(/\*\*Affected Artifact\*\*:\s*(design|structure|plan)/i)?.[1]?.toLowerCase();
  return raw === "design" ? "design" : raw === "structure" ? "structure" : "plan";
}

// ---------------------------------------------------------------------------
// Slice Manifest — machine-readable contract in design.md
// ---------------------------------------------------------------------------

export interface SliceManifestEntry {
  id: string;
  title: string;
  deps: string[];
  acceptanceCriteria: string[];
}

export type SliceManifestResult = { ok: true; slices: SliceManifestEntry[] } | { ok: false; reason: string };

/**
 * Extract and validate the `## Slice Manifest` JSON block from a design.md document.
 * Returns `{ ok: false }` when the section is absent or the JSON is malformed/invalid.
 */
export function parseSliceManifest(designMd: string): SliceManifestResult {
  // Find the ## Slice Manifest section and extract the first fenced JSON block within it.
  const topSections = normalizeNewlines(designMd).split(/^## /m);
  const manifestSection = topSections.find((s) => s.match(/^Slice Manifest\b/));
  if (!manifestSection) {
    return { ok: false, reason: "## Slice Manifest section not found in design.md" };
  }

  const jsonMatch = manifestSection.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!jsonMatch || !jsonMatch[1]) {
    return { ok: false, reason: "No ```json fenced block found in ## Slice Manifest section" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[1]);
  } catch (e) {
    return { ok: false, reason: `JSON parse error in ## Slice Manifest: ${String(e)}` };
  }

  if (!validateSliceManifest(parsed)) {
    return {
      ok: false,
      reason: "## Slice Manifest JSON does not match expected schema {slices:[{id,title,deps,acceptanceCriteria}]}",
    };
  }

  const manifest = parsed as { slices: SliceManifestEntry[] };

  for (const slice of manifest.slices) {
    if (!/^[A-Za-z0-9_-]+$/.test(slice.id)) {
      return {
        ok: false,
        reason: `Slice manifest entry has invalid id "${slice.id}" — must be alphanumeric/dash/underscore with no spaces`,
      };
    }
    if (slice.acceptanceCriteria.length === 0) {
      return { ok: false, reason: `Slice manifest entry "${slice.id}" has an empty acceptanceCriteria array` };
    }
  }

  return { ok: true, slices: manifest.slices };
}

/**
 * Extract a well-formed markdown document starting at the given anchor heading line.
 *
 * Strips:
 *   - Everything before the first line that exactly matches `anchorHeading` (removes leaked
 *     shell output, narration, and stray opening code fences that agents emit before the doc).
 *   - A trailing unbalanced ``` line that some agents append after the document body
 *     (inner ```mermaid / ```typescript / ```json blocks are left untouched).
 *
 * If the anchor heading is not found, returns the original text unchanged so callers always
 * receive something writable.
 */
export function extractMarkdownDocument(text: string, anchorHeading: string): string {
  const normalized = normalizeNewlines(text);
  const lines = normalized.split("\n");

  const anchorIdx = lines.findIndex((l) => l === anchorHeading);
  if (anchorIdx === -1) return text;

  const body = lines.slice(anchorIdx);

  // Count fence opens vs closes. Each ``` line (regardless of language tag) toggles depth.
  // An odd total means there is one unbalanced fence token.
  let fenceDepth = 0;
  for (const line of body) {
    if (line.startsWith("```")) fenceDepth ^= 1;
  }

  // If unbalanced, find the last ``` line and remove it — that is the stray token.
  if (fenceDepth !== 0) {
    for (let i = body.length - 1; i >= 0; i--) {
      if ((body[i] ?? "").startsWith("```")) {
        body.splice(i, 1);
        break;
      }
    }
  }

  return body.join("\n").trimEnd();
}

/**
 * Returns true when design.md declares any slices (i.e. contains `## Slice Manifest` or
 * `## Vertical Slices`). Used to distinguish "no slices intended" from "slices declared
 * but unparseable".
 */
export function designDeclaresSlices(designMd: string): boolean {
  return /^## Slice Manifest\b/m.test(designMd) || /^## Vertical Slices\b/m.test(designMd);
}

function validateSliceManifest(value: unknown): value is { slices: unknown[] } {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj["slices"])) return false;
  for (const item of obj["slices"]) {
    if (typeof item !== "object" || item === null) return false;
    const s = item as Record<string, unknown>;
    if (typeof s["id"] !== "string") return false;
    if (typeof s["title"] !== "string") return false;
    if (!Array.isArray(s["deps"])) return false;
    if (!Array.isArray(s["acceptanceCriteria"])) return false;
  }
  return true;
}
