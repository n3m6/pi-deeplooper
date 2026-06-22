/**
 * Cassette — schema, I/O, and key computation for the record/replay harness.
 *
 * A cassette is a directory with three files:
 *   meta.json        — run metadata (seed for RunState reconstruction)
 *   dispatch.jsonl   — one DispatchCassetteEntry per line
 *   gates.jsonl      — one GateCassetteEntry per line
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  DispatchCustomToolCall,
  DispatchRequest,
  DispatchResult,
  FailurePolicy,
  InteractionMode,
  ReviewDepth,
  Route,
} from "../../application/port/index.js";

export const CASSETTE_SCHEMA_VERSION = "1";

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

export interface CassetteMeta {
  schemaVersion: string;
  runId: string;
  route: Route;
  interactionMode: InteractionMode;
  failurePolicy: FailurePolicy;
  /** The original user task description, required to seed the Run for replay. */
  userTask: string;
  reviewDepth?: ReviewDepth;
  modelProfile?: string;
  /** The last stage that successfully completed — used by golden tests to assert replay fidelity. */
  lastCompletedStage?: string;
  /**
   * The terminal nextStage value at the end of the run — defaults to "done" for successful runs,
   * but may be a stage name (e.g. "verify") when the pipeline exits early (e.g. verify cap hit).
   */
  expectedNextStage?: string;
}

// ---------------------------------------------------------------------------
// Trimmed DispatchResult — messages[] is dropped (SDK-internal, never read by stages)
// ---------------------------------------------------------------------------

export interface TrimmedDispatchResult {
  text: string;
  customToolCalls: DispatchCustomToolCall[];
  endReason?: DispatchResult["endReason"];
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Entry types
// ---------------------------------------------------------------------------

export interface WrittenFile {
  /** Path relative to the dispatch's cwd (workspaceRoot for leaf, worktreeRoot for generic). */
  path: string;
  content: string;
}

export interface DispatchCassetteEntry {
  key: string;
  /** Recording-order index — used as tiebreak within the same key bucket for parallel waves. */
  ordinal: number;
  targetName: string;
  targetKind: "leaf" | "generic";
  /** First 200 chars of the prompt — informational only, not used for keying. */
  promptHead: string;
  result: TrimmedDispatchResult;
  /**
   * Unified diff captured after a generic dispatch — applied via `git apply` in semi-live mode
   * so that squash/merge sees real file content.
   */
  workspacePatch?: string;
  /**
   * Files written as a side-effect of this dispatch.
   * Applied directly (no git needed) in pure mode for leaf dispatches and as a fallback
   * when workspacePatch is absent.
   */
  writtenFiles?: WrittenFile[];
}

export type GateMethod = "askText" | "choose" | "confirm";

export interface GateCassetteEntry {
  method: GateMethod;
  /** Per-method ordinal — consumption index within each method's queue. */
  ordinal: number;
  args: unknown[];
  decision: unknown;
}

// ---------------------------------------------------------------------------
// Path normalisation for dispatch key stability
// ---------------------------------------------------------------------------

/**
 * Replaces volatile absolute paths and wall-clock dates in a prompt string with
 * stable placeholders so that the sha256 key matches across machines, across
 * record/replay mkdtemp dirs, and across calendar days.
 *
 * Volatile segments normalised:
 *  1. workspaceRoot (the git repo root, a fresh mkdtemp dir each run)
 *  2. The worktree base: path.dirname(workspaceRoot)/.dl-worktrees/<runId>
 *     (per worktreeRootPath in src/infra/git/version-control.ts — worktrees are
 *      siblings of the repo root, NOT children)
 *  3. ISO date stamps of the form YYYY-MM-DD (e.g. `created: 2026-06-14` in
 *     config.md front-matter) are replaced with <DATE> so cassette keys remain
 *     stable when replayed on a different calendar day than the recording.
 *
 * Longer/more-specific paths are replaced first to avoid partial substitutions.
 */
export function normalizePaths(text: string, workspaceRoot: string, runId: string): string {
  const worktreeBase = path.join(path.dirname(workspaceRoot), ".deeplooper-worktrees", runId);
  // Replace longer path first
  let result = text.split(worktreeBase).join("<WORKTREES>");
  result = result.split(workspaceRoot).join("<WORKSPACE>");
  // Replace ISO dates (YYYY-MM-DD) so keys are stable across calendar days
  result = result.replace(/\d{4}-\d{2}-\d{2}/g, "<DATE>");
  return result;
}

// ---------------------------------------------------------------------------
// Key computation
// ---------------------------------------------------------------------------

/**
 * Deterministic sha256 key for a DispatchRequest.
 *
 * Hashes: target.kind + target.name + sorted custom-tool names + path-normalised prompt.
 * The key is stable across machines and across record/replay temp dirs when:
 *  - workspaceRoot is the repo root used during this run
 *  - runId matches the cassette's recorded runId
 */
export function dispatchKey(request: DispatchRequest, workspaceRoot: string, runId: string): string {
  const target = request.target;
  const customToolNames = (request.customTools ?? [])
    .map((t) => t.name)
    .sort()
    .join(",");
  const normalizedPrompt = normalizePaths(request.prompt, workspaceRoot, runId);
  const content = `${target.kind}:${target.name}:${customToolNames}:${normalizedPrompt}`;
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

/** Strip messages[] (SDK-internal; only extractAssistantText in session-dispatcher reads it). */
export function trimResult(result: DispatchResult): TrimmedDispatchResult {
  const trimmed: TrimmedDispatchResult = {
    text: result.text,
    customToolCalls: result.customToolCalls,
  };
  if (result.endReason !== undefined) {
    trimmed.endReason = result.endReason;
  }
  if (result.errorMessage !== undefined) {
    trimmed.errorMessage = result.errorMessage;
  }
  return trimmed;
}

/** Restore a TrimmedDispatchResult to a full DispatchResult with empty messages[]. */
export function restoreResult(trimmed: TrimmedDispatchResult): DispatchResult {
  const restored: DispatchResult = {
    text: trimmed.text,
    messages: [],
    customToolCalls: trimmed.customToolCalls,
  };
  if (trimmed.endReason !== undefined) {
    restored.endReason = trimmed.endReason;
  }
  if (trimmed.errorMessage !== undefined) {
    restored.errorMessage = trimmed.errorMessage;
  }
  return restored;
}

// ---------------------------------------------------------------------------
// CassetteWriter
// ---------------------------------------------------------------------------

export class CassetteWriter {
  private readonly dispatchEntries: DispatchCassetteEntry[] = [];
  private readonly gateEntries: GateCassetteEntry[] = [];
  private dispatchCounter = 0;
  private readonly gateCounters = new Map<GateMethod, number>();

  nextDispatchOrdinal(): number {
    return this.dispatchCounter++;
  }

  nextGateOrdinal(method: GateMethod): number {
    const current = this.gateCounters.get(method) ?? 0;
    this.gateCounters.set(method, current + 1);
    return current;
  }

  appendDispatch(entry: DispatchCassetteEntry): void {
    this.dispatchEntries.push(entry);
  }

  appendGate(entry: GateCassetteEntry): void {
    this.gateEntries.push(entry);
  }

  async flush(dir: string, meta: CassetteMeta): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");
    const dispatchLines = this.dispatchEntries.map((e) => JSON.stringify(e)).join("\n");
    await writeFile(path.join(dir, "dispatch.jsonl"), dispatchLines ? dispatchLines + "\n" : "", "utf8");
    const gateLines = this.gateEntries.map((e) => JSON.stringify(e)).join("\n");
    await writeFile(path.join(dir, "gates.jsonl"), gateLines ? gateLines + "\n" : "", "utf8");
  }
}

// ---------------------------------------------------------------------------
// CassetteReader
// ---------------------------------------------------------------------------

export class CassetteReader {
  private readonly dispatchBuckets = new Map<string, DispatchCassetteEntry[]>();
  private readonly gateQueues = new Map<GateMethod, GateCassetteEntry[]>();

  private constructor() {}

  static async load(dir: string): Promise<{ meta: CassetteMeta; reader: CassetteReader }> {
    const metaText = await readFile(path.join(dir, "meta.json"), "utf8");
    const meta = JSON.parse(metaText) as CassetteMeta;

    const reader = new CassetteReader();

    const dispatchText = await readFile(path.join(dir, "dispatch.jsonl"), "utf8");
    for (const line of dispatchText.split("\n").filter((l) => l.trim())) {
      const entry = JSON.parse(line) as DispatchCassetteEntry;
      const bucket = reader.dispatchBuckets.get(entry.key) ?? [];
      bucket.push(entry);
      reader.dispatchBuckets.set(entry.key, bucket);
    }
    // Sort each bucket by ordinal so parallel-wave dispatches are consumed in record order
    for (const [k, bucket] of reader.dispatchBuckets) {
      bucket.sort((a, b) => a.ordinal - b.ordinal);
      reader.dispatchBuckets.set(k, bucket);
    }

    const gateText = await readFile(path.join(dir, "gates.jsonl"), "utf8");
    for (const line of gateText.split("\n").filter((l) => l.trim())) {
      const entry = JSON.parse(line) as GateCassetteEntry;
      const queue = reader.gateQueues.get(entry.method) ?? [];
      queue.push(entry);
      reader.gateQueues.set(entry.method, queue);
    }
    for (const [m, queue] of reader.gateQueues) {
      queue.sort((a, b) => a.ordinal - b.ordinal);
      reader.gateQueues.set(m, queue);
    }

    return { meta, reader };
  }

  nextDispatch(key: string): DispatchCassetteEntry | undefined {
    const bucket = this.dispatchBuckets.get(key);
    if (!bucket || bucket.length === 0) return undefined;
    return bucket.shift();
  }

  /** Returns true when a cassette entry exists for the given key without consuming it. */
  peekDispatch(key: string): boolean {
    const bucket = this.dispatchBuckets.get(key);
    return bucket !== undefined && bucket.length > 0;
  }

  nextGate(method: GateMethod): GateCassetteEntry | undefined {
    const queue = this.gateQueues.get(method);
    if (!queue || queue.length === 0) return undefined;
    return queue.shift();
  }
}
