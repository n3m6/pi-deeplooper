import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { FileSystemArtifactRepository } from "../../src/infra/fs/artifact-repository.js";
import { getRunArtifacts, ensureRunDirectories } from "../../src/infra/fs/artifact-repository.js";
import { Run } from "../../src/domain/run/index.js";
import { runCodeReviewSubstage } from "../../src/application/stage/code-review.js";
import type {
  DispatchRequest,
  DispatchResult,
  Dispatcher,
  LeafAgentDefinition,
  PipelineServices,
  StageRuntime,
  VersionControl,
} from "../../src/application/port/index.js";

test("code-review fanout blocks on failing non-advisory reviewer", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-deeplooper-review-"));
  const artifacts = getRunArtifacts(workspace, "dl-20260601-030000");
  await ensureRunDirectories(artifacts);
  await mkdir(path.join(artifacts.phasesDir, "phase-01", "tasks"), { recursive: true });
  await writeFile(path.join(path.join(artifacts.phasesDir, "phase-01", "tasks"), "task-01.md"), "# Task 01\n", "utf8");
  const dispatcher = new RecordingDispatcher("dl-review-code-quality");
  const runtime = makeRuntime(workspace, artifacts, dispatcher);

  const outcome = await runCodeReviewSubstage(runtime, {
    taskId: "01",
    worktreeRoot: workspace,
    taskSpecId: { kind: "taskSpec", phase: 1, taskId: "01" },
  });

  assert.equal(outcome.status, "FAIL");
  assert.ok(dispatcher.agentNames.includes("dl-review-code-quality"));
  assert.ok(dispatcher.agentNames.includes("dl-review-test-coverage"));
  assert.ok(dispatcher.agentNames.includes("dl-review-goal-traceability"));
});

test("code-review fanout treats simplifier as advisory", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-deeplooper-review-"));
  const artifacts = getRunArtifacts(workspace, "dl-20260601-040000");
  await ensureRunDirectories(artifacts);
  await mkdir(path.join(artifacts.phasesDir, "phase-01", "tasks"), { recursive: true });
  await writeFile(path.join(path.join(artifacts.phasesDir, "phase-01", "tasks"), "task-01.md"), "# Task 01\n", "utf8");
  const dispatcher = new RecordingDispatcher("dl-review-code-simplifier");
  const runtime = makeRuntime(workspace, artifacts, dispatcher, [
    "src/shared-helper.ts",
    "src/a.ts",
    "src/b.ts",
    "test/example.test.ts",
  ]);

  const outcome = await runCodeReviewSubstage(runtime, {
    taskId: "01",
    worktreeRoot: workspace,
    taskSpecId: { kind: "taskSpec", phase: 1, taskId: "01" },
  });

  assert.equal(outcome.status, "PASS");
  assert.ok(dispatcher.agentNames.includes("dl-review-code-simplifier"));
});

test("code-review fanout treats medium-only failures as non-blocking", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-deeplooper-review-"));
  const artifacts = getRunArtifacts(workspace, "dl-20260601-050000");
  await ensureRunDirectories(artifacts);
  await mkdir(path.join(artifacts.phasesDir, "phase-01", "tasks"), { recursive: true });
  await writeFile(path.join(path.join(artifacts.phasesDir, "phase-01", "tasks"), "task-01.md"), "# Task 01\n", "utf8");
  const dispatcher = new RecordingDispatcher("dl-review-code-quality", "MEDIUM");
  const runtime = makeRuntime(workspace, artifacts, dispatcher);

  const outcome = await runCodeReviewSubstage(runtime, {
    taskId: "01",
    worktreeRoot: workspace,
    taskSpecId: { kind: "taskSpec", phase: 1, taskId: "01" },
  });

  assert.equal(outcome.status, "PASS");
  assert.match(outcome.telemetry?.review_status_summary as string, /non-blocking severity/);
});

class RecordingDispatcher implements Dispatcher {
  readonly agentNames: string[] = [];

  constructor(
    private readonly failingAgent: string,
    private readonly failureSeverity = "HIGH",
  ) {}

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    const name = request.target.name;
    this.agentNames.push(name);
    const status = name === this.failingAgent ? "FAIL" : "PASS";
    return {
      text: `### Status — ${status}\n\n### Findings\n${status === "FAIL" ? `| 1 | ${this.failureSeverity} | file | 1 | bug | issue | fix |` : "None."}`,
      messages: [],
      customToolCalls: [],
      endReason: "agent_end",
    };
  }

  async dispatchParallel(requests: DispatchRequest[]): Promise<DispatchResult[]> {
    return Promise.all(requests.map((request) => this.dispatch(request)));
  }

  async dispatchChain(requests: DispatchRequest[]): Promise<DispatchResult[]> {
    return this.dispatchParallel(requests);
  }

  async dispatchGenericCoding(_prompt: string) {
    return { status: "PASS" as const, filesWritten: [], summary: "" };
  }
}

function makeVersionControl(changedFiles: string[], changedLines = 250): VersionControl {
  return {
    createRunBranch: async () => {},
    checkpoint: async () => ({ ok: true, skipped: true }),
    resolveRepoRoot: async () => "/",
    prepareWorktree: async () => ({ branch: "test", worktreeRoot: "/", taskId: "01", phase: 1 }),
    squashMerge: async () => ({ ok: true }),
    rebaseWorktree: async () => ({ ok: true }),
    continueRebase: async () => ({ ok: true }),
    commitWorktreeChanges: async () => {},
    changedFiles: async (_cwd: string) => changedFiles,
    changedLineCount: async (_cwd: string) => changedLines,
    listWorkspaceFiles: async (_cwd: string) => changedFiles,
    cleanupWorktree: async () => {},
    stage7RegressionReusable: async () => ({ reusable: false, reason: "test-stub" }),
  };
}

function makeRuntime(
  workspace: string,
  artifacts: ReturnType<typeof getRunArtifacts>,
  dispatcher: Dispatcher,
  changedFiles = ["src/example.ts", "test/example.test.ts"],
): StageRuntime {
  const agentDefinitions = new Map<string, LeafAgentDefinition>();
  for (const name of [
    "dl-review-code-quality",
    "dl-review-test-coverage",
    "dl-review-goal-traceability",
    "dl-review-code-simplifier",
  ]) {
    agentDefinitions.set(name, {
      kind: "leaf",
      name,
      description: name,
      tools: ["read"],
      maxTurns: 5,
      systemPromptMode: "replace",
      extensions: [],
      filePath: `${name}.md`,
      body: "",
    });
  }
  return {
    state: Run.start({
      runId: "dl-20260601-030000",
      interactionMode: "automated",
      failurePolicy: "best-effort",
      route: "full",
    }).toSnapshot(),
    workspaceRoot: workspace,
    services: {
      pi: {
        async exec() {
          return { stdout: "", stderr: "", code: 0, killed: false };
        },
      },
      commandContext: {} as never,
      eventContext: {},
      dispatcher,
      agentDefinitions,
      gates: {} as never,
      progress: {} as never,
      versionControl: makeVersionControl(changedFiles),
      artifactRepo: FileSystemArtifactRepository.fromPaths(artifacts),
      telemetrySink: { record: async () => {}, regenerateRunLog: async () => {}, regenerateMetrics: async () => {} },
    } as unknown as PipelineServices,
  };
}
