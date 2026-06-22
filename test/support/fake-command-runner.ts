import type { CommandRunnerPort, ExecOutcome } from "../../src/application/port/index.js";

/**
 * FakeCommandRunner — scripted implementation of CommandRunnerPort for tests.
 *
 * By default every command exits 0 with empty stdout/stderr. Tests can push
 * scripted outcomes via `pushOutcome()` (consumed in FIFO order) or replace
 * the default with `setDefault()`.
 */
export class FakeCommandRunner implements CommandRunnerPort {
  private readonly outcomes: Array<[string, ExecOutcome]> = [];
  private defaultOutcome: ExecOutcome = { stdout: "", stderr: "", code: 0 };

  /** Record all (command, args) calls for assertion. */
  readonly calls: Array<{ command: string; args: string[]; cwd: string }> = [];

  /** Queue a scripted outcome for the next invocation whose command string matches. */
  pushOutcome(commandContains: string, outcome: ExecOutcome): void {
    this.outcomes.push([commandContains, outcome]);
  }

  /** Override the default (applies when no queued outcome matches). */
  setDefault(outcome: ExecOutcome): void {
    this.defaultOutcome = outcome;
  }

  async run(command: string, args: string[], cwd: string): Promise<ExecOutcome> {
    this.calls.push({ command, args, cwd });
    const full = [command, ...args].join(" ");
    const idx = this.outcomes.findIndex(([pattern]) => full.includes(pattern));
    if (idx !== -1) {
      const [, outcome] = this.outcomes.splice(idx, 1)[0]!;
      return outcome;
    }
    return this.defaultOutcome;
  }
}
