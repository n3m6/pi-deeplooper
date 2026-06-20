// NpmBuildTool — implements BuildToolPort by running npm scripts via pi exec.

import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { BuildToolPort, ExecOutcome } from "../../application/port/index.js";

export class NpmBuildTool implements BuildToolPort {
  constructor(private readonly pi: Pick<ExtensionAPI, "exec">) {}

  async availableScripts(cwd: string): Promise<string[]> {
    try {
      const raw = await readFile(path.join(cwd, "package.json"), "utf8");
      const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
      return Object.keys(pkg.scripts ?? {});
    } catch {
      return [];
    }
  }

  async runScript(name: string, cwd: string): Promise<ExecOutcome> {
    const result = await this.pi.exec("npm", ["run", name], { cwd, timeout: 120_000 });
    return { stdout: result.stdout, stderr: result.stderr, code: result.code };
  }
}
