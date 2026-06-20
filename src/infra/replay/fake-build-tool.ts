/**
 * FakeBuildTool — in-memory stub for pure-mode replay.
 *
 * availableScripts returns a configurable list; runScript always succeeds.
 * Placed in src/infra/replay/ (not test/support) so the replay CLI can use it too.
 */

import type { BuildToolPort, ExecOutcome } from "../../application/port/index.js";

export class FakeBuildTool implements BuildToolPort {
  // Default list mirrors the fixture workspace package.json (writeFixtureWorkspace in test/support/harness.ts).
  // test:e2e must be present so e2e-regression-results.md content matches the recording.
  constructor(private readonly scripts: string[] = ["build", "test", "typecheck", "test:e2e"]) {}

  availableScripts(_cwd: string): Promise<string[]> {
    return Promise.resolve(this.scripts);
  }

  runScript(_name: string, _cwd: string): Promise<ExecOutcome> {
    return Promise.resolve({ stdout: "", stderr: "", code: 0 });
  }
}
