import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createAskHumanTool } from "../../src/infra/pi/human-gate.js";
import { createGoalsReturnTool, createInterviewReturnTool } from "../../src/infra/pi/stage-return-tool.js";
import {
  createStageReturnTool,
  normalizeStageReturn,
  type StageReturnPayload,
} from "../../src/infra/pi/stage-return-tool.js";

import { loadAgentDefinitions } from "../../src/infra/pi/agent-catalog.js";
import { ensureRunDirectories, getRunArtifacts, type RunArtifacts } from "../../src/infra/fs/artifact-repository.js";
import { createRunId } from "../../src/infra/system/id-generator.js";
import { Run } from "../../src/domain/run/index.js";
import { SystemClock } from "../../src/infra/system/clock.js";
import { FileSystemArtifactRepository } from "../../src/infra/fs/artifact-repository.js";
import { FileSystemRunStateRepository } from "../../src/infra/fs/state-repository.js";
import { GitVersionControl } from "../../src/infra/git/version-control.js";
import { NpmBuildTool } from "../../src/infra/npm/build-tool.js";
import { JsonlTelemetrySink } from "../../src/infra/telemetry/jsonl-telemetry-sink.js";
import type {
  DispatchRequest,
  CustomToolResult,
  DispatchResult,
  Dispatcher,
  FailurePolicy,
  GateChoice,
  GateManager,
  InteractionMode,
  PipelineServices,
  ProgressReporter,
  ReviewDepth,
  RunState,
  StageOutcome,
  StageRuntime,
  StageName,
  TelemetrySink,
} from "../../src/application/port/index.js";

const execFileAsync = promisify(execFile);
let harnessRunCounter = 0;

export interface HarnessOptions {
  route?: "full";
  verificationStatus?: "PASS" | "PARTIAL" | "FAIL";
  acceptanceStatus?: "PASS" | "FAIL";
  backwardLoopRecommendation?: "NO_LOOP" | "LOCAL_SLICE" | "LOOP_DESIGN" | "LOOP_GOALS";
  interactionMode?: InteractionMode;
  failurePolicy?: FailurePolicy;
  reviewDepth?: ReviewDepth;
  /** When true the dl-slice-planner mock returns PASS but writes no task specs (reproduces the production bug). */
  slicePlannerWritesNoTasks?: boolean;
}

export class TestHarness {
  readonly workspaceRoot: string;
  readonly artifacts: RunArtifacts;
  readonly dispatcher: Dispatcher;
  readonly gates: GateManager;
  readonly progress: ProgressReporter;
  readonly services: PipelineServices;
  state: RunState;

  private constructor(workspaceRoot: string, artifacts: RunArtifacts, state: RunState, services: PipelineServices) {
    this.workspaceRoot = workspaceRoot;
    this.artifacts = artifacts;
    this.state = state;
    this.dispatcher = services.dispatcher;
    this.gates = services.gates;
    this.progress = services.progress;
    this.services = services;
  }

  get telemetrySink(): TelemetrySink {
    return this.services.telemetrySink;
  }

  static async create(options: HarnessOptions = {}): Promise<TestHarness> {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "pi-deeplooper-test-"));
    const runId = createRunId(new Date(2026, 5, 1, 0, 0, harnessRunCounter++));
    await writeFixtureWorkspace(workspaceRoot, runId);
    await execFileAsync("git", ["checkout", `deeplooper/${runId}`], { cwd: workspaceRoot });
    const artifacts = getRunArtifacts(workspaceRoot, runId);
    await ensureRunDirectories(artifacts);

    const state = Run.start({
      runId,
      userTask: "Implement a deterministic deeplooper pipeline.",
      interactionMode: options.interactionMode ?? "automated",
      failurePolicy: options.failurePolicy ?? "best-effort",
      route: options.route ?? "full",
    }).toSnapshot();

    const agentDefinitions = await loadAgentDefinitions();
    const pi = createExecOnlyPi(workspaceRoot);
    const gates = new StaticGateManager(
      options.interactionMode ?? "automated",
      options.failurePolicy ?? "best-effort",
      options.reviewDepth ?? "thorough",
    );
    const dispatcher = new MockDispatcher(artifacts, {
      route: "full",
      verificationStatus: options.verificationStatus ?? "PASS",
      acceptanceStatus: options.acceptanceStatus ?? "PASS",
      backwardLoopRecommendation: options.backwardLoopRecommendation ?? "NO_LOOP",
      slicePlannerWritesNoTasks: options.slicePlannerWritesNoTasks ?? false,
    });
    const ctx = createFakeCommandContext(workspaceRoot, pi);
    const progress = new NoopProgressReporter();
    const versionControl = new GitVersionControl(pi, workspaceRoot, runId);
    const buildTool = new NpmBuildTool(pi);
    const artifactRepo = FileSystemArtifactRepository.fromPaths(artifacts);
    const stateRepo = new FileSystemRunStateRepository(artifacts.stateFile);
    const clock = new SystemClock();
    const telemetrySink = JsonlTelemetrySink.create(artifacts, runId, clock);
    await telemetrySink.initialize();

    const services: PipelineServices = {
      commandContext: { signal: ctx.signal },
      eventContext: { signal: ctx.signal },
      dispatcher,
      agentDefinitions,
      gates,
      progress,
      clock,
      versionControl,
      buildTool,
      artifactRepo,
      stateRepo,
      telemetrySink,
    };

    await writeFile(
      artifacts.configFile,
      `created: 2026-06-01\nroute: ${options.route ?? "full"}\nrun_id: ${runId}\n`,
      "utf8",
    );

    return new TestHarness(workspaceRoot, artifacts, state, services);
  }

  runtime(overrides?: Partial<RunState>, currentStage?: StageName): StageRuntime {
    return {
      state: { ...this.state, ...overrides },
      workspaceRoot: this.workspaceRoot,
      services: this.services,
      ...(currentStage !== undefined ? { currentStage } : {}),
    };
  }

  completeStage(...args: Parameters<Run["completeStage"]>): void {
    const run = Run.rehydrate(this.state);
    run.completeStage(...args);
    this.state = run.toSnapshot();
  }

  async dispose(): Promise<void> {
    // Remove any worktrees created under /tmp/.dl-worktrees/{runId}/ to prevent
    // stale directories from breaking subsequent tests that reuse the same runId.
    const worktreesRoot = path.join(os.tmpdir(), ".deeplooper-worktrees", this.state.runId);
    await rm(worktreesRoot, { recursive: true, force: true });
    await rm(this.workspaceRoot, { recursive: true, force: true });
  }
}

export class MockDispatcher implements Dispatcher {
  constructor(
    private readonly artifacts: RunArtifacts,
    private readonly options: Required<
      Pick<
        HarnessOptions,
        "route" | "verificationStatus" | "acceptanceStatus" | "backwardLoopRecommendation" | "slicePlannerWritesNoTasks"
      >
    >,
  ) {}

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    if (request.target.kind === "generic") {
      return this.handleGeneric(request);
    }
    return this.handleLeaf(request);
  }

  async dispatchParallel(requests: DispatchRequest[]): Promise<DispatchResult[]> {
    return Promise.all(requests.map((request) => this.dispatch(request)));
  }

  async dispatchChain(requests: DispatchRequest[]): Promise<DispatchResult[]> {
    const results: DispatchResult[] = [];
    for (const request of requests) {
      results.push(await this.dispatch(request));
    }
    return results;
  }

  async dispatchGenericCoding(
    prompt: string,
    options?: { cwd?: string; tools?: string[]; signal?: AbortSignal },
  ): Promise<StageOutcome> {
    const stageReturns: StageReturnPayload[] = [];
    const result = await this.dispatch({
      target: {
        kind: "generic",
        name: "generic-coding",
        tools: options?.tools ?? ["read", "bash", "edit", "write", "grep", "find", "ls"],
        thinkingLevel: "high",
      },
      prompt,
      cwd: options?.cwd ?? this.artifacts.workspaceRoot,
      ...(options?.signal ? { signal: options.signal } : {}),
      customTools: [createStageReturnTool(stageReturns)],
    });
    return normalizeStageReturn(result);
  }

  private async handleLeaf(request: DispatchRequest): Promise<DispatchResult> {
    switch (request.target.name) {
      case "dl-goals-interviewer":
        return withInterviewReturn(request);
      case "dl-goals-synthesizer":
        return withGoalsReturn(request, "full");
      case "dl-goals-reviewer":
      case "dl-question-leakage-reviewer":
      case "dl-question-quality-reviewer":
      case "dl-research-reviewer":
      case "dl-design-reviewer":
      case "dl-structure-reviewer":
        return textResult("### Status — PASS\n\n### Summary\nPass.");
      case "dl-question-generator":
        return textResult(
          [
            "# Research Questions",
            "",
            "### Q1: What code paths currently implement the relevant behavior?",
            "**Tag**: codebase",
            "**Covers**: FR-1 [behavior]",
            "**Answer shape**: Identify the current files and call chain. Stop when the owning path is clear.",
            "**Decision unblocked**: Which existing subsystem owns the change surface.",
          ].join("\n"),
        );
      case "dl-codebase-researcher":
        return textResult(
          [
            "## Findings for Q1",
            "",
            "### Summary",
            "A current code path exists.",
            "",
            "### References",
            "- `src/example.ts:1` — placeholder reference.",
          ].join("\n"),
        );
      case "dl-web-researcher":
        return textResult(
          ["## Findings for Q1", "", "### Summary", "No relevant external sources found for this question."].join("\n"),
        );
      case "dl-research-synthesizer": {
        await writeFile(
          this.artifacts.researchSummaryFile,
          "# Research Summary\n\n## Overview\nCurrent system facts were synthesized.\n",
          "utf8",
        );
        return textResult(
          "### Status — PASS\n### Files Written — research/summary.md\n### Summary — Synthesized findings.",
        );
      }
      case "dl-design-synthesizer":
        return textResult("# Design\n\n## Approach\nUse the existing repository layout.\n");
      case "dl-structure-mapper":
        return textResult(
          "# Structure\n\n## File Map\n\n### Slice 1: Core\n| File | Action | Purpose |\n|------|--------|---------|\n| `src/example.ts` | MODIFY | Example work |\n",
        );
      case "dl-slice-planner": {
        if (!this.options.slicePlannerWritesNoTasks) {
          const phaseDir = request.prompt.match(/=== PHASE DIR ===\n(.+)/)?.[1]?.trim() ?? "phases/phase-01";
          const phaseSegment = phaseDir.split("/").at(-1) ?? "phase-01";
          const sliceId = request.prompt.match(/=== SLICE ID ===\n(.+)/)?.[1]?.trim() ?? "S1";
          const tasksDir = path.join(this.artifacts.phasesDir, phaseSegment, "tasks");
          await mkdir(tasksDir, { recursive: true });
          await writeFile(path.join(tasksDir, "task-01.md"), renderSliceTaskSpec("01", sliceId, "1"), "utf8");
        }
        return textResult("### Status — PASS\n\n### Summary\nSlice planned.");
      }
      case "dl-baseline-checker":
        return textResult(
          "### Baseline Status — CLEAN\n\n### Check Results\n| Check | Status | Command | Details |\n|-------|--------|---------|---------|\n| Build | PASS | `npm run build` | ok |\n| Tests | PASS | `npm run test` | ok |\n\n### Failure Inventory\nNone.\n\n### Stage Summary\nBaseline CLEAN.",
        );
      case "dl-coverage-planner":
        return textResult(
          "### Coverage Plan\n- Criterion 1: Example\n  - Action: new\n  - Test Type: integration\n  - Trigger: run command\n  - Expected Outcome: observable success\n  - Relevant Files/Components: src/example.ts\n  - Planned Test File: test/example.test.ts\n  - Notes: None.\n\n### Summary\nPlanned coverage.",
        );
      case "dl-backward-loop-detector":
        return textResult(renderBackwardLoop(this.options.backwardLoopRecommendation));
      case "dl-verifier":
        return textResult(renderVerification(this.options.verificationStatus));
      case "dl-reporter":
        return textResult("## DEEPLOOPER Pipeline Complete\n\n### Overall Status: PASS\n");
      default:
        return textResult("### Status — PASS\n\n### Summary\nMock leaf response.");
    }
  }

  private async handleGeneric(request: DispatchRequest): Promise<DispatchResult> {
    if (request.prompt.includes("Stage 7 acceptance testing")) {
      const acceptanceStatus = this.options.acceptanceStatus;
      const phase = request.prompt.match(/Phase:\s*(\d+)/)?.[1] ?? "1";
      const phaseDir = path.join(this.artifacts.phasesDir, `phase-${phase.padStart(2, "0")}`);
      await writeFile(
        path.join(phaseDir, "acceptance-results.md"),
        `# Acceptance Results\n\n| # | Criterion | Status | Failure Reason |\n| - | --------- | ------ | -------------- |\n| 1 | Example | ${acceptanceStatus === "PASS" ? "✅" : "❌"} | ${acceptanceStatus === "PASS" ? "none" : "executed_failed"} |\n`,
        "utf8",
      );
      await writeFile(
        path.join(phaseDir, "stage8-summary.md"),
        `# Stage 8 Summary\n\nAcceptance ${acceptanceStatus === "PASS" ? "passed" : "failed"}.\n`,
        "utf8",
      );
      return withStageReturn(request, {
        status: acceptanceStatus,
        filesWritten: ["test/example.test.ts"],
        summary: acceptanceStatus === "PASS" ? "Acceptance tests passed." : "Acceptance tests failed.",
        telemetry: {
          evidence_quality: {
            deterministic: 1,
            flaky: 0,
            harnessNoisy: 0,
            ambiguous: 0,
            redundant: 0,
            noTestTasks: 0,
            noTestAuditOverrides: 0,
          },
        },
      });
    }

    if (request.prompt.includes("Review the current task worktree")) {
      return withStageReturn(request, {
        status: "PASS",
        filesWritten: [],
        summary: "Code review clean.",
      });
    }

    if (request.prompt.includes("Run targeted verification")) {
      return withStageReturn(request, {
        status: "PASS",
        filesWritten: [],
        summary: "Targeted verification passed.",
      });
    }

    if (request.prompt.includes("Write or update only the tests needed")) {
      await touchFile(path.join(request.cwd, "test", "example.test.ts"), "export {};\n");
      return withStageReturn(request, {
        status: "PASS",
        filesWritten: ["test/example.test.ts"],
        summary: "Task tests updated.",
        telemetry: {
          evidence_quality: {
            deterministic: 1,
            flaky: 0,
            harnessNoisy: 0,
            ambiguous: 0,
            redundant: 0,
            noTestTasks: 0,
            noTestAuditOverrides: 0,
          },
        },
      });
    }

    if (request.prompt.includes("Implement the production-code portion")) {
      await touchFile(
        path.join(request.cwd, "src", "example.ts"),
        `export const task = "${path.basename(request.cwd)}";\n`,
      );
      return withStageReturn(request, {
        status: "PASS",
        filesWritten: ["src/example.ts"],
        summary: "Task implementation updated.",
      });
    }

    return withStageReturn(request, {
      status: "PASS",
      filesWritten: [],
      summary: "Generic coding session passed.",
    });
  }
}

class StaticGateManager implements GateManager {
  constructor(
    readonly interactionMode: InteractionMode,
    readonly failurePolicy: FailurePolicy,
    readonly reviewDepth: ReviewDepth = "thorough",
  ) {}

  async askText(): Promise<string | undefined> {
    return this.interactionMode === "interactive" ? "mock answer" : undefined;
  }

  async choose(_title: string, options: Array<{ value: string }>): Promise<GateChoice | undefined> {
    if (this.interactionMode !== "interactive") {
      return undefined;
    }
    return { value: options[0]?.value ?? "approve" };
  }

  async confirm(): Promise<boolean> {
    return this.interactionMode === "interactive";
  }

  createAskHumanTool() {
    return createAskHumanTool(this);
  }

  createGoalsReturnTool() {
    return createGoalsReturnTool();
  }

  createInterviewReturnTool() {
    return createInterviewReturnTool();
  }
}

class NoopProgressReporter implements ProgressReporter {
  setStage(): void {}
  setWidget(): void {}
  clear(): void {}
}

function createExecOnlyPi(workspaceRoot: string): Pick<ExtensionAPI, "exec"> {
  return {
    async exec(command, args, options) {
      try {
        const result = await execFileAsync(command, args, {
          cwd: options?.cwd ?? workspaceRoot,
          timeout: options?.timeout,
          signal: options?.signal,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Cursor Test",
            GIT_AUTHOR_EMAIL: "cursor-test@example.com",
            GIT_COMMITTER_NAME: "Cursor Test",
            GIT_COMMITTER_EMAIL: "cursor-test@example.com",
          },
        });
        return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: 0, killed: false };
      } catch (error) {
        const anyError = error as { stdout?: string; stderr?: string; code?: number; killed?: boolean };
        return {
          stdout: anyError.stdout ?? "",
          stderr: anyError.stderr ?? String(error),
          code: anyError.code ?? 1,
          killed: anyError.killed ?? false,
        };
      }
    },
  };
}

function createFakeCommandContext(workspaceRoot: string, _pi: Pick<ExtensionAPI, "exec">): ExtensionCommandContext {
  return {
    cwd: workspaceRoot,
    hasUI: false,
    ui: {
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      notify: () => undefined,
      onTerminalInput: () => () => undefined,
      setStatus: () => undefined,
      setWorkingMessage: () => undefined,
      setWorkingVisible: () => undefined,
      setWorkingIndicator: () => undefined,
      setHiddenThinkingLabel: () => undefined,
      setWidget: () => undefined,
      setFooter: () => undefined,
      setHeader: () => undefined,
      setTitle: () => undefined,
      custom: async () => undefined as never,
      pasteToEditor: () => undefined,
      setEditorText: () => undefined,
      getEditorText: () => "",
      editor: async () => undefined,
      addAutocompleteProvider: () => undefined,
      setEditorComponent: () => undefined,
      getEditorComponent: () => undefined,
      theme: {} as never,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: true }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => undefined,
    },
    sessionManager: {
      getCwd: () => workspaceRoot,
      getSessionDir: () => workspaceRoot,
      getSessionId: () => "test",
      getSessionFile: () => undefined,
      getLeafId: () => null,
      getLeafEntry: () => undefined,
      getEntry: () => undefined,
      getLabel: () => undefined,
      getBranch: () => [],
      getHeader: () => null,
      getEntries: () => [],
      getTree: () => [],
      getSessionName: () => undefined,
    },
    modelRegistry: {} as never,
    model: undefined,
    isIdle: () => true,
    signal: undefined,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    getContextUsage: () => undefined,
    compact: () => undefined,
    getSystemPrompt: () => "",
    waitForIdle: async () => undefined,
    newSession: async () => ({ cancelled: false }),
    fork: async () => ({ cancelled: false }),
    navigateTree: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
    reload: async () => undefined,
  };
}

export async function writeFixtureWorkspace(workspaceRoot: string, runId: string): Promise<void> {
  await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await mkdir(path.join(workspaceRoot, "test"), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, "package.json"),
    JSON.stringify(
      {
        name: "fixture",
        type: "module",
        scripts: {
          build: 'node -e "process.exit(0)"',
          typecheck: 'node -e "process.exit(0)"',
          test: 'node -e "process.exit(0)"',
          "test:e2e": 'node -e "process.exit(0)"',
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(path.join(workspaceRoot, "README.md"), "# Fixture\n", "utf8");
  await writeFile(path.join(workspaceRoot, "src", "example.ts"), "export const example = 1;\n", "utf8");

  const pi = createExecOnlyPi(workspaceRoot);
  await pi.exec("git", ["init", "-b", "main"], { cwd: workspaceRoot, timeout: 60_000 });
  await pi.exec("git", ["add", "."], { cwd: workspaceRoot, timeout: 60_000 });
  await pi.exec("git", ["commit", "-m", "initial"], { cwd: workspaceRoot, timeout: 60_000 });
  await pi.exec("git", ["checkout", "-b", `deeplooper/${runId}`], {
    cwd: workspaceRoot,
    timeout: 60_000,
  });
  await pi.exec("git", ["checkout", "main"], { cwd: workspaceRoot, timeout: 60_000 });
}

async function withGoalsReturn(request: DispatchRequest, route: "full"): Promise<DispatchResult> {
  const calls: Array<{ name: string; result: CustomToolResult }> = [];
  const tool = request.customTools?.find((candidate) => candidate.name === "goals_return");
  if (tool) {
    const callTool = tool as unknown as { execute(...args: unknown[]): Promise<CustomToolResult> };
    const result = await callTool.execute(
      "tool-1",
      { goalsMarkdown: renderGoalsMarkdown(), route },
      undefined,
      undefined,
      {},
    );
    calls.push({ name: "goals_return", result });
  }
  return { text: "", messages: [], customToolCalls: calls };
}

async function withInterviewReturn(request: DispatchRequest): Promise<DispatchResult> {
  const calls: Array<{ name: string; result: CustomToolResult }> = [];
  const tool = request.customTools?.find((candidate) => candidate.name === "interview_return");
  if (tool) {
    const callTool = tool as unknown as { execute(...args: unknown[]): Promise<CustomToolResult> };
    const result = await callTool.execute(
      "tool-1",
      {
        entries: [
          { branch: "constraints", source: "user-answer", content: "No external dependencies." },
          { branch: "non-goals", source: "user-answer", content: "Database integration is out of scope." },
          { branch: "acceptance-criteria", source: "user-answer", content: "The endpoint returns 200 OK." },
          { branch: "testing-expectations", source: "user-answer", content: "Add a unit test for the endpoint." },
        ],
      },
      undefined,
      undefined,
      {},
    );
    calls.push({ name: "interview_return", result });
  }
  return { text: "", messages: [], customToolCalls: calls };
}

function renderGoalsMarkdown(): string {
  return [
    "# Goals",
    "",
    "## Intent",
    "Implement a deterministic deeplooper pipeline.",
    "",
    "## Functional Requirements",
    "- Produce deterministic pipeline artifacts.",
    "",
    "## Non-Functional Requirements",
    "- Keep the runtime testable.",
    "",
    "## Technical Specification",
    "- Use TypeScript.",
    "",
    "## Constraints",
    "- No prompt-only orchestration.",
    "",
    "## Non-Goals",
    "- No unrelated refactors.",
    "",
    "## Acceptance Criteria",
    "1. The pipeline can run end-to-end.",
    "",
  ].join("\n");
}

function renderBackwardLoop(recommendation: Required<HarnessOptions>["backwardLoopRecommendation"]): string {
  return [
    "### Severity Analysis",
    "| # | Criterion | Failure Reason | Failure | Local Code Only | File Boundary Change | Interface Change | Architecture Change | Scope Change | Safe To Defer | Classification | Loop-back Target | Rationale |",
    "| - | --------- | -------------- | ------- | --------------- | -------------------- | ---------------- | ------------------- | ------------ | ------------- | -------------- | ---------------- | --------- |",
    `| 1 | Example | executed_failed | Example | no | no | no | no | no | no | ${recommendation} | plan | Example rationale |`,
    "",
    "### Overall Recommendation",
    recommendation,
    "",
    "### Rationale",
    "Mock rationale.",
    "",
    recommendation !== "NO_LOOP"
      ? [
          "### Backward Loop Request",
          "**Criteria**: AC-1",
          "**Issue**: Mock issue",
          "**Affected Artifact**: design",
          "**Recommendation**: Revisit design.",
        ].join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function renderVerification(status: "PASS" | "PARTIAL" | "FAIL"): string {
  return [
    "### Check Results",
    "| Check | Status | Likely Owner | Details |",
    "| ----- | ------ | ------------ | ------- |",
    `| Build | ${status === "FAIL" ? "FAIL" : "PASS"} | unknown | mock |`,
    "",
    "### Baseline Comparison",
    "| Check | Baseline Status | Current Status | Regression Status | Phase Introduced | Last Modified Phase |",
    "| ----- | --------------- | -------------- | ----------------- | ---------------- | ------------------- |",
    `| Build | PASS | ${status === "FAIL" ? "FAIL" : "PASS"} | ${status === "FAIL" ? "New regression" : "Improved"} | 1 | 1 |`,
    "",
    "### Requirement Checks",
    "| Requirement | Evidence | Status | Notes |",
    "| ----------- | -------- | ------ | ----- |",
    `| AC-1 | mock | ${status === "FAIL" ? "FAILED" : "SATISFIED"} | mock |`,
    "",
    "### Acceptance Criteria Status",
    "| Phase | # | Criterion | Status | Failure Reason |",
    "| ----- | - | --------- | ------ | -------------- |",
    `| 1 | 1 | Example | ${status === "FAIL" ? "❌" : "✅"} | ${status === "FAIL" ? "mock failure" : "none"} |`,
    "",
    "### Code Health Summary",
    "| Phase | Tasks | Deterministic | Flaky | Harness Noisy | Ambiguous | Redundant | No-Test Tasks | No-Test Audit Overrides | Outstanding Concerns |",
    "| ----- | ----- | ------------- | ----- | ------------- | --------- | --------- | ------------- | ----------------------- | -------------------- |",
    "| 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |",
    "",
    "### Verification Iterations",
    "1/1 — Mock verification.",
    "",
    `### Overall Status — ${status}`,
    "",
    `### Stage Summary`,
    `Verification ${status}.`,
  ].join("\n");
}

function textResult(text: string): DispatchResult {
  return { text, messages: [], customToolCalls: [] };
}

async function withStageReturn(request: DispatchRequest, payload: Record<string, unknown>): Promise<DispatchResult> {
  const calls = [];
  const tool = request.customTools?.find((candidate) => candidate.name === "stage_return");
  if (tool) {
    const callTool = tool as unknown as { execute(...args: unknown[]): Promise<CustomToolResult> };
    const result = await callTool.execute("tool-1", payload, undefined, undefined, {});
    calls.push({ name: "stage_return", result });
  }
  return {
    text: "",
    messages: [],
    customToolCalls: calls,
  };
}

async function touchFile(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

export async function readFileText(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}

function renderSliceTaskSpec(taskId: string, sliceId: string, phase: string): string {
  return [
    `# Task ${taskId}: Health Check Endpoint`,
    "",
    "## Metadata",
    `- **Task:** ${taskId}`,
    `- **Slice:** ${sliceId}`,
    `- **Phase:** ${phase}`,
    "- **Route:** full",
    "- **Mode:** slice",
    "",
    "## Dependencies",
    "- None.",
    "",
    "## Description",
    "Implement the endpoint described in design.",
    "",
    "## Files",
    "| Path | Action | Purpose |",
    "| --- | --- | --- |",
    "| `src/health.ts` | CREATE | Health check handler |",
    "",
    "## Feasibility Checklist",
    "- path-exists: src/",
    "",
    "## Done Checklist",
    "- file-exists: src/health.ts",
    "",
    "## Test Expectations",
    "- Endpoint returns 200 OK.",
    "",
    "## Slice Review Status",
    "- **Planner State:** clean",
    "- **Requeue Count:** 0",
    "- **Previous Failure Addressed:** None.",
    "- **Outstanding Concerns:** None.",
  ].join("\n");
}
