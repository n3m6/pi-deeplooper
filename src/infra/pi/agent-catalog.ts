import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

import type {
  AgentCatalog,
  GenericCodingTarget,
  LeafAgentDefinition,
  ThinkingLevelName,
} from "../../application/port/index.js";
import { matchEnum, THINKING_LEVELS } from "./union-guard.js";

type RawFrontmatter = Record<string, unknown> & {
  name?: string;
  description?: string;
  tools?: string;
  model?: string;
  thinking?: string;
  max_turns?: number;
  systemPromptMode?: "replace" | "append";
  extensions?: string | string[];
};

const AGENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "agents");

/** Default max-turn budget when no `max_turns` frontmatter field is present. */
const DEFAULT_MAX_TURNS = 40;

export async function loadAgentDefinitions(): Promise<Map<string, LeafAgentDefinition>> {
  const files = (await readdir(AGENTS_DIR)).filter((entry) => entry.endsWith(".md") && entry.startsWith("dl-"));
  const definitions = new Map<string, LeafAgentDefinition>();

  for (const fileName of files.sort()) {
    const filePath = path.join(AGENTS_DIR, fileName);
    const content = await readFile(filePath, "utf8");
    const parsed = parseFrontmatter<RawFrontmatter>(content);
    const name = parsed.frontmatter.name ?? fileName.replace(/\.md$/, "");
    const thinkingLevel = toThinkingLevel(parsed.frontmatter.thinking);
    const optionalFields: Partial<LeafAgentDefinition> = {};
    if (parsed.frontmatter.model) {
      optionalFields.modelName = parsed.frontmatter.model;
    }
    if (thinkingLevel) {
      optionalFields.thinkingLevel = thinkingLevel;
    }
    const definition: LeafAgentDefinition = {
      kind: "leaf",
      name,
      description: parsed.frontmatter.description ?? "",
      tools: parseCsv(parsed.frontmatter.tools ?? ""),
      maxTurns: parsed.frontmatter.max_turns ?? DEFAULT_MAX_TURNS,
      systemPromptMode: parsed.frontmatter.systemPromptMode ?? "replace",
      extensions: normalizeExtensions(parsed.frontmatter.extensions),
      filePath,
      body: parsed.body.trim(),
      ...optionalFields,
    };
    definitions.set(name, definition);
  }

  return definitions;
}

export function createGenericCodingTarget(tools: string[]): GenericCodingTarget {
  return {
    kind: "generic",
    name: "generic-coding",
    tools,
    thinkingLevel: "high",
  };
}

export function isOrchestrator(definition: LeafAgentDefinition): boolean {
  return definition.tools.includes("subagent");
}

export class MarkdownAgentCatalog implements AgentCatalog {
  private definitions: Map<string, LeafAgentDefinition>;

  private constructor(definitions: Map<string, LeafAgentDefinition>) {
    this.definitions = definitions;
  }

  static async load(): Promise<MarkdownAgentCatalog> {
    const definitions = await loadAgentDefinitions();
    return new MarkdownAgentCatalog(definitions);
  }

  get(name: string): LeafAgentDefinition | undefined {
    return this.definitions.get(name);
  }

  all(): Map<string, LeafAgentDefinition> {
    return new Map(this.definitions);
  }
}

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeExtensions(value: RawFrontmatter["extensions"]): string[] {
  if (!value) {
    return [];
  }
  const values = Array.isArray(value) ? value : [value];
  return values
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => (entry.startsWith("~/") ? path.join(os.homedir(), entry.slice(2)) : entry));
}

function toThinkingLevel(value: string | undefined): ThinkingLevelName | undefined {
  return value ? matchEnum(value.trim().toLowerCase(), THINKING_LEVELS) : undefined;
}
