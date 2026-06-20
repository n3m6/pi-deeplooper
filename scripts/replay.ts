#!/usr/bin/env tsx
/**
 * Replay CLI — replays a cassette and prints the final state + event summary.
 *
 * Usage:
 *   tsx scripts/replay.ts <cassetteDir> [--mode pure|semi-live]
 *
 * Exits non-zero when the pipeline does not end at lastCompletedStage === "report".
 */

import path from "node:path";
import { runReplay, normalizeEvents } from "../src/infra/replay/replay-runner.js";
import type { ReplayMode } from "../src/infra/replay/replay-runner.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log("Usage: tsx scripts/replay.ts <cassetteDir> [--mode pure|semi-live]");
    process.exit(0);
  }

  const cassetteDir = path.resolve(args[0] ?? "");
  let mode: ReplayMode = "pure";
  const modeIdx = args.indexOf("--mode");
  if (modeIdx !== -1) {
    const modeArg = args[modeIdx + 1];
    if (modeArg === "pure" || modeArg === "semi-live") {
      mode = modeArg;
    } else {
      console.error(`Unknown mode: ${modeArg ?? "(missing)"}. Use pure or semi-live.`);
      process.exit(1);
    }
  }

  console.log(`Replaying cassette: ${cassetteDir}`);
  console.log(`Mode: ${mode}`);

  const { finalState, events } = await runReplay({ cassetteDir, mode });
  const normalized = normalizeEvents(events);

  console.log(`\nFinal state:`);
  console.log(`  lastCompletedStage : ${finalState.lastCompletedStage}`);
  console.log(`  nextStage          : ${finalState.nextStage}`);
  console.log(`  route              : ${finalState.route}`);

  console.log(`\nEvent sequence (${normalized.length} events):`);
  for (const event of normalized) {
    console.log(`  [${event.status.padEnd(7)}] ${event.event_type}`);
  }

  if (finalState.lastCompletedStage !== "report") {
    console.error(`\nReplay did not complete (lastCompletedStage=${finalState.lastCompletedStage})`);
    process.exit(1);
  }

  console.log("\nReplay completed successfully.");
}

main().catch((error) => {
  console.error("Replay failed:", error);
  process.exit(1);
});
