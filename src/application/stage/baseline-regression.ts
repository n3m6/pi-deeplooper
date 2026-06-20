import type { ArtifactId, BuildToolPort, StageOutcome, StageRuntime } from "../port/index.js";
import { artifactRelPath, writeArtifact } from "./utils.js";

const BASELINE_SCRIPTS = [
  { label: "Build", script: "build" },
  { label: "Lint", script: "lint" },
  { label: "Typecheck", script: "typecheck" },
  { label: "Tests", script: "test" },
] as const;

export async function runBaselineRegressionSubstage(runtime: StageRuntime, phase: number): Promise<StageOutcome> {
  const buildTool = requireBuildTool(runtime);
  const cwd = runtime.workspaceRoot;
  const available = new Set(await buildTool.availableScripts(cwd));
  const commands = BASELINE_SCRIPTS.filter((cmd) => available.has(cmd.script));

  const rows: string[] = [];
  let overall: StageOutcome["status"] = "PASS";

  for (const command of commands) {
    const result = await buildTool.runScript(command.script, cwd);
    const status = result.code === 0 ? "PASS" : "FAIL";
    if (status === "FAIL") {
      overall = "FAIL";
    }
    rows.push(`| ${command.label} | ${status} | \`npm run ${command.script}\` |`);
  }

  if (rows.length === 0) {
    rows.push("| Checks | NOT CONFIGURED | None. |");
  }

  const id: ArtifactId = { kind: "phaseFile", phase, name: "regression-results.md" };
  const markdown = [
    `### Status — ${overall}`,
    "",
    "| Check | Status | Command |",
    "| ----- | ------ | ------- |",
    ...rows,
  ].join("\n");
  await writeArtifact(runtime, id, markdown);

  return {
    status: overall,
    filesWritten: [artifactRelPath(runtime, id)],
    summary: `Baseline regression check ${overall.toLowerCase()}.`,
  };
}

function requireBuildTool(runtime: StageRuntime): BuildToolPort {
  if (!runtime.services.buildTool) {
    throw new Error("BuildToolPort is not wired; ensure the composition root initialises it.");
  }
  return runtime.services.buildTool;
}
