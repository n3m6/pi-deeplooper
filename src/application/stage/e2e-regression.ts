import type { ArtifactId, BuildToolPort, StageOutcome, StageRuntime } from "../port/index.js";
import { artifactRelPath, writeArtifact } from "./utils.js";

export interface RegressionCheckResult {
  outcome: StageOutcome;
  markdown: string;
}

export async function runE2ERegressionSubstage(runtime: StageRuntime, phase: number): Promise<RegressionCheckResult> {
  const buildTool = requireBuildTool(runtime);
  const cwd = runtime.workspaceRoot;
  const available = new Set(await buildTool.availableScripts(cwd));
  const scriptName = available.has("test:e2e") ? "test:e2e" : available.has("e2e") ? "e2e" : undefined;

  const id: ArtifactId = { kind: "phaseFile", phase, name: "e2e-regression-results.md" };

  if (!scriptName) {
    const markdown = [
      "### Status — PASS",
      "### E2E — NOT CONFIGURED",
      "No e2e script is defined in package.json.",
    ].join("\n");
    await writeArtifact(runtime, id, markdown);
    return {
      markdown,
      outcome: {
        status: "PASS",
        filesWritten: [artifactRelPath(runtime, id)],
        summary: "No e2e regression script is configured.",
      },
    };
  }

  const result = await buildTool.runScript(scriptName, cwd);
  const status = result.code === 0 ? "PASS" : "FAIL";
  const markdown = [
    `### Status — ${status}`,
    `### E2E — ${status}`,
    "```text",
    [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
    "```",
  ].join("\n");
  await writeArtifact(runtime, id, markdown);

  return {
    markdown,
    outcome: {
      status,
      filesWritten: [artifactRelPath(runtime, id)],
      summary: `E2E regression check ${status.toLowerCase()}.`,
    },
  };
}

function requireBuildTool(runtime: StageRuntime): BuildToolPort {
  if (!runtime.services.buildTool) {
    throw new Error("BuildToolPort is not wired; ensure the composition root initialises it.");
  }
  return runtime.services.buildTool;
}
