/**
 * Golden replay tests — for each committed cassette, replay in pure and semi-live
 * modes and assert structural properties + event_type sequence correctness.
 *
 * Cassettes live in test/cassettes/<name>/.
 *
 * Golden files (event_type sequences) are stored as test/cassettes/<name>/golden.json.
 * On first run (no golden file present) the golden is written from the pure-mode replay
 * and the test passes.  On subsequent runs the recorded golden is compared.
 *
 * Semi-live mode uses the same golden when no git conflicts arise (all MockDispatcher
 * scenarios produce PASS, so event sequences are identical between modes).
 */

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import type { CassetteMeta } from "../../src/infra/replay/cassette.js";
import { normalizeEvents, runReplay } from "../../src/infra/replay/replay-runner.js";

const CASSETTES_DIR = path.resolve(import.meta.dirname, "..", "cassettes");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function directoryExists(dir: string): Promise<boolean> {
  try {
    const s = await stat(dir);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function findCassetteDirs(): Promise<Array<{ dir: string; meta: CassetteMeta }>> {
  if (!(await directoryExists(CASSETTES_DIR))) {
    return [];
  }
  const entries = await readdir(CASSETTES_DIR, { withFileTypes: true });
  const result: Array<{ dir: string; meta: CassetteMeta }> = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const cassetteDir = path.join(CASSETTES_DIR, entry.name);
      try {
        const raw = await readFile(path.join(cassetteDir, "meta.json"), "utf8");
        result.push({ dir: cassetteDir, meta: JSON.parse(raw) as CassetteMeta });
      } catch {
        // skip dirs without valid meta.json
      }
    }
  }
  return result.sort((a, b) => a.dir.localeCompare(b.dir));
}

function eventTypes(events: ReturnType<typeof normalizeEvents>): string[] {
  // checkpoint.created is emitted only when a real git commit happens (semi-live mode).
  // Pure mode's FakeVersionControl reports skipped, so it never emits one. Exclude it here
  // so the golden stays a mode-independent orchestration contract; the mapping that writes
  // these events to events.jsonl is covered directly in test/infra/telemetry.test.ts.
  return events.map((e) => e.event_type).filter((type) => type !== "checkpoint.created");
}

// ---------------------------------------------------------------------------
// Test factory — registers one suite per cassette
// ---------------------------------------------------------------------------

async function registerCassetteTests(): Promise<void> {
  const cassettes = await findCassetteDirs();

  if (cassettes.length === 0) {
    test("replay cassettes (no cassettes found — run tsx scripts/record-cassette.ts first)", async () => {
      // Soft pass: cassettes haven't been generated yet
    });
    return;
  }

  for (const { dir: cassetteDir, meta } of cassettes) {
    const name = path.basename(cassetteDir);
    // Expected terminal stage from cassette meta; fall back to "report" for legacy cassettes.
    const expectedLastStage = meta.lastCompletedStage ?? "report";
    // expectedNextStage is "done" for normal completions; may be a stage name when the pipeline
    // exits early (e.g. "verify" when the verify-fix cap is hit).
    const expectedNextStage = meta.expectedNextStage ?? "done";

    test(`replay pure mode — ${name}`, async () => {
      const { finalState, events } = await runReplay({ cassetteDir, mode: "pure" });
      const normalized = normalizeEvents(events);

      assert.equal(
        finalState.nextStage,
        expectedNextStage,
        `expected nextStage=${expectedNextStage}, got ${finalState.nextStage}`,
      );
      assert.equal(
        finalState.lastCompletedStage,
        expectedLastStage,
        `expected lastCompletedStage=${expectedLastStage}, got ${finalState.lastCompletedStage}`,
      );

      const goldenPath = path.join(cassetteDir, "golden.json");
      let golden: string[];
      try {
        const raw = await readFile(goldenPath, "utf8");
        golden = JSON.parse(raw) as string[];
      } catch {
        // First run: write the golden and pass
        golden = eventTypes(normalized);
        await writeFile(goldenPath, JSON.stringify(golden, null, 2) + "\n", "utf8");
        return;
      }

      assert.deepEqual(eventTypes(normalized), golden, `event_type sequence mismatch for ${name} (pure)`);
    });

    test(`replay semi-live mode — ${name}`, async () => {
      const { finalState, events } = await runReplay({ cassetteDir, mode: "semi-live" });
      const normalized = normalizeEvents(events);

      assert.equal(
        finalState.nextStage,
        expectedNextStage,
        `expected nextStage=${expectedNextStage}, got ${finalState.nextStage}`,
      );
      assert.equal(
        finalState.lastCompletedStage,
        expectedLastStage,
        `expected lastCompletedStage=${expectedLastStage}, got ${finalState.lastCompletedStage}`,
      );

      // Semi-live uses the same golden as pure for conflict-free scenarios
      // (all MockDispatcher scenarios are conflict-free: disjoint files, sequential phases)
      const goldenPath = path.join(cassetteDir, "golden.json");
      let golden: string[];
      try {
        const raw = await readFile(goldenPath, "utf8");
        golden = JSON.parse(raw) as string[];
      } catch {
        // Golden not yet generated — structural assertions above are sufficient
        return;
      }

      assert.deepEqual(eventTypes(normalized), golden, `event_type sequence mismatch for ${name} (semi-live)`);
    });
  }
}

// Register tests immediately (top-level await in ESM test files is supported)
await registerCassetteTests();
