// PiCommandRunner — implements CommandRunnerPort by executing arbitrary shell
// commands through pi.exec. Follows the same pattern as NpmBuildTool.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { CommandRunnerPort, ExecOutcome } from "../../application/port/index.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export class PiCommandRunner implements CommandRunnerPort {
  constructor(private readonly pi: Pick<ExtensionAPI, "exec">) {}

  async run(command: string, args: string[], cwd: string, opts?: { timeoutMs?: number }): Promise<ExecOutcome> {
    const result = await this.pi.exec(command, args, {
      cwd,
      timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    return { stdout: result.stdout, stderr: result.stderr, code: result.code };
  }
}
