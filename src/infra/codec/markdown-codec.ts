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
