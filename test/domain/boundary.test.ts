/**
 * Boundary guard:
 *  - domain/ and application/ must not import from node:* or @earendil-works/*
 *  - domain/ must not import from infra/ (caught by ESLint as errors;
 *    application/ violations are tracked as eslint-disable comments — technical debt)
 *
 * Zero-dependency check. Scans TS source files for forbidden import patterns.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = new URL("../../src", import.meta.url).pathname;

// Allow:
//   import type ... from "@earendil-works/..." — type-only, erased at runtime
//   import path from "node:path"              — pure string utility, no side effects
const DOMAIN_APP_FORBIDDEN_PATTERNS = [
  // node:* except node:path (pure string manipulation)
  /from\s+["']node:(?!path["'])/,
  // @earendil-works/* except type-only imports
  /^(?!.*\bimport\s+type\b).*from\s+["']@earendil-works\//,
];

/** Domain must never import from infrastructure at all. */
const DOMAIN_ONLY_FORBIDDEN = [/from\s+["'][^"']*infra\//];

async function collectTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectTsFiles(full)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      results.push(full);
    }
  }
  return results;
}

async function findViolations(
  dir: string,
  patterns: RegExp[],
): Promise<Array<{ file: string; line: number; text: string }>> {
  const files = await collectTsFiles(dir).catch(() => [] as string[]);
  const violations: Array<{ file: string; line: number; text: string }> = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (const pattern of patterns) {
        if (pattern.test(line)) {
          violations.push({ file: path.relative(path.join(ROOT, ".."), file), line: i + 1, text: line.trim() });
        }
      }
    }
  }
  return violations;
}

test("domain layer has no node:* or @earendil-works/* imports", async () => {
  const domainDir = path.join(ROOT, "domain");
  const violations = await findViolations(domainDir, DOMAIN_APP_FORBIDDEN_PATTERNS);
  assert.deepEqual(
    violations,
    [],
    `Domain layer boundary violations:\n${violations.map((v) => `  ${v.file}:${v.line}: ${v.text}`).join("\n")}`,
  );
});

test("domain layer has no infra/ imports", async () => {
  const domainDir = path.join(ROOT, "domain");
  const violations = await findViolations(domainDir, DOMAIN_ONLY_FORBIDDEN);
  assert.deepEqual(
    violations,
    [],
    `Domain layer must not import from infra/:\n${violations.map((v) => `  ${v.file}:${v.line}: ${v.text}`).join("\n")}`,
  );
});

test("application layer has no node:* or @earendil-works/* imports", async () => {
  const appDir = path.join(ROOT, "application");
  const violations = await findViolations(appDir, DOMAIN_APP_FORBIDDEN_PATTERNS);
  assert.deepEqual(
    violations,
    [],
    `Application layer boundary violations:\n${violations.map((v) => `  ${v.file}:${v.line}: ${v.text}`).join("\n")}`,
  );
});
