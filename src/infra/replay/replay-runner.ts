/**
 * Replay runner — orchestrates a replay run from a cassette directory.
 *
 * runReplay({ cassetteDir, mode }) supports two modes:
 *   pure      — FakeVersionControl + FakeBuildTool, no real git/npm I/O
 *   semi-live — real GitVersionControl + FakeBuildTool in a fresh temp workspace;
 *               workspace patches are re-applied so squash/merge acts on real content
 *
 * normalizeEvents(events) strips volatile fields for golden comparison in tests.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { runPipeline } from "../../application/pipeline/run-pipeline.js";
import type {
  DispatchRequest,
  DispatchResult,
  Dispatcher,
  PipelineServices,
  ProgressReporter,
  StageOutcome,
  TelemetryEvent,
} from "../../application/port/index.js";
import { Run } from "../../domain/run/index.js";
import { FileSystemArtifactRepository, ensureRunDirectories, getRunArtifacts } from "../fs/artifact-repository.js";
import { FileSystemRunStateRepository } from "../fs/state-repository.js";
import { GitVersionControl } from "../git/version-control.js";
import { loadAgentDefinitions } from "../pi/agent-catalog.js";
import { JsonlTelemetrySink } from "../telemetry/jsonl-telemetry-sink.js";
import { SystemClock } from "../system/clock.js";
import { CassetteReader } from "./cassette.js";
import { FakeBuildTool } from "./fake-build-tool.js";
import { FakeVersionControl } from "./fake-version-control.js";
import { ReplayDispatcher, type ReplayMode } from "./replay-dispatcher.js";
import { ReplayGateManager } from "./replay-gate.js";
import { StubChangesVersionControl } from "./stub-version-control.js";

export type { ReplayMode };

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Exec adapter — maps node:child_process execFile to the ExtensionAPI.exec shape
// ---------------------------------------------------------------------------

function createExecAdapter(defaultCwd: string): Pick<ExtensionAPI, "exec"> {
  return {
    async exec(command, args, options) {
      try {
        const result = await execFileAsync(command, args ?? [], {
          cwd: options?.cwd ?? defaultCwd,
          timeout: options?.timeout,
          ...(options?.signal ? { signal: options.signal } : {}),
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "dl-replay",
            GIT_AUTHOR_EMAIL: "dl-replay@example.invalid",
            GIT_COMMITTER_NAME: "dl-replay",
            GIT_COMMITTER_EMAIL: "dl-replay@example.invalid",
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

// ---------------------------------------------------------------------------
// Semi-live workspace setup — git-initialized fixture workspace
// ---------------------------------------------------------------------------

async function createSemiLiveWorkspace(runId: string): Promise<string> {
  const workspaceRoot = await makeTempDir("pi-deeplooper-replay-semilive-");
  const pi = createExecAdapter(workspaceRoot);

  await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await mkdir(path.join(workspaceRoot, "test"), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, "package.json"),
    JSON.stringify(
      {
        name: "replay-fixture",
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
  await writeFile(path.join(workspaceRoot, "README.md"), "# Replay fixture\n", "utf8");
  await writeFile(path.join(workspaceRoot, "src", "example.ts"), "export const example = 1;\n", "utf8");

  await pi.exec("git", ["init", "-b", "main"], { cwd: workspaceRoot, timeout: 60_000 });
  await pi.exec("git", ["add", "."], { cwd: workspaceRoot, timeout: 60_000 });
  await pi.exec("git", ["commit", "-m", "initial"], { cwd: workspaceRoot, timeout: 60_000 });
  // Pre-create the run branch so createRunBranch is effectively a no-op; check out main
  await pi.exec("git", ["checkout", "-b", `deeplooper/${runId}`], { cwd: workspaceRoot, timeout: 60_000 });
  await pi.exec("git", ["checkout", "main"], { cwd: workspaceRoot, timeout: 60_000 });

  return workspaceRoot;
}

async function createPureWorkspace(): Promise<string> {
  return makeTempDir("pi-deeplooper-replay-pure-");
}

function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// applyPatch — used in semi-live mode to re-apply recorded workspace patches
// ---------------------------------------------------------------------------

async function applyPatch(cwd: string, patch: string): Promise<void> {
  const pi = createExecAdapter(cwd);
  // Write patch to a temp file to avoid shell quoting issues
  const patchFile = path.join(os.tmpdir(), `replay-patch-${Date.now()}.patch`);
  await writeFile(patchFile, patch, "utf8");
  try {
    // createExecAdapter swallows child-process errors and returns them as { code: N }
    // rather than throwing, so the exit code must be checked explicitly. A failed
    // `git apply` (conflicting content, malformed patch) would otherwise leave the
    // worktree with stale content that a later squashMerge would silently act upon.
    const result = await pi.exec("git", ["apply", "--whitespace=nowarn", patchFile], { cwd, timeout: 30_000 });
    if (result.code !== 0) {
      throw new Error(`git apply failed (exit ${result.code}) in ${cwd}: ${result.stderr.trim() || "no stderr"}`);
    }
  } finally {
    await rm(patchFile, { force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Noop progress reporter
// ---------------------------------------------------------------------------

class NoopProgressReporter implements ProgressReporter {
  setStage(): void {}
  setWidget(): void {}
  clear(): void {}
}

// ---------------------------------------------------------------------------
// PostCassetteAgentFallback — canonical PASS mock for agents added after recording
// ---------------------------------------------------------------------------

/**
 * Canonical mock responses for leaf agents added after existing cassettes were recorded.
 * Keys are agent names; values are the text response to return.
 */
const POST_CASSETTE_AGENT_RESPONSES: Record<string, string> = {
  "dl-skeleton-reviewer":
    "### Status — PASS\nClassification: SCAFFOLD_OK\n\n### Fix Guidance\nNone.\n\n### Summary\nScaffold is correct.",
  // dl-verifier prompts changed (added STAGE7 REGRESSION REUSE + CONFIGURED SCRIPTS directives
  // in Issue 3a) — the new prompt no longer matches old cassette keys.
  "dl-verifier": "### Overall Status — PASS\n\n### Stage Summary\nVerification PASS. All configured checks pass.",
  // dl-goals-reviewer prompts changed (added PRIOR REVIEW FINDINGS block in Issue 2).
  "dl-goals-reviewer": "### Status — PASS\n\n### Summary\nGoals review passed.",
  // dl-coverage-planner may run post-cassette when verify produces a different outcome
  // (due to new PASS fallback from verifier above).
  "dl-coverage-planner":
    "| # | Criterion | Test file | Action | Notes |\n|---|-----------|-----------|--------|-------|\n| 1 | Example | tests/example.test.ts | write | |\n\n### Summary\nCoverage planned.",
  // dl-reporter runs after accept when the pipeline reaches the report stage post-cassette.
  "dl-reporter": "## DEEPLOOPER Pipeline Complete\n\n### Overall Status — PASS\n\nAll stages passed.\n",
};

/**
 * Dispatcher that handles agents introduced after an existing cassette was recorded.
 * Used as a live-fallthrough so new dispatches appear in the event stream and goldens
 * are regenerated without cassette re-recording.
 */
class PostCassetteAgentFallback implements Dispatcher {
  dispatch(request: DispatchRequest): Promise<DispatchResult> {
    const name = request.target.kind === "leaf" ? request.target.name : undefined;
    const response = name ? POST_CASSETTE_AGENT_RESPONSES[name] : undefined;
    if (response !== undefined) {
      return Promise.resolve({ text: response, messages: [], customToolCalls: [], endReason: "agent_end" });
    }
    return Promise.reject(
      new Error(
        `PostCassetteAgentFallback: no response for agent="${name ?? request.target.kind}" — add it to POST_CASSETTE_AGENT_RESPONSES or re-record the cassette.`,
      ),
    );
  }

  async dispatchParallel(requests: DispatchRequest[]): Promise<DispatchResult[]> {
    return Promise.all(requests.map((r) => this.dispatch(r)));
  }

  async dispatchChain(requests: DispatchRequest[]): Promise<DispatchResult[]> {
    const results: DispatchResult[] = [];
    for (const r of requests) results.push(await this.dispatch(r));
    return results;
  }

  dispatchGenericCoding(_prompt: string): Promise<StageOutcome> {
    // Generic coding sessions added post-cassette (e.g. from accept stage running after a
    // post-cassette verifier PASS) are completed with a minimal PASS so the replay can finish.
    return Promise.resolve({
      status: "PASS" as const,
      filesWritten: [],
      summary: "Post-cassette generic coding: minimal PASS.",
    });
  }
}

// ---------------------------------------------------------------------------
// runReplay — main entry point
// ---------------------------------------------------------------------------

export interface ReplayResult {
  finalState: Awaited<ReturnType<typeof runPipeline>>;
  events: TelemetryEvent[];
  workspaceRoot: string;
}

export async function runReplay(options: { cassetteDir: string; mode: ReplayMode }): Promise<ReplayResult> {
  const { cassetteDir, mode } = options;

  const { meta, reader } = await CassetteReader.load(cassetteDir);
  const agentDefinitions = await loadAgentDefinitions();

  // Pre-clean worktree dirs left by a previous run (e.g. pure mode creates dirs via
  // applyWrittenFiles that would make git worktree add fail in a subsequent semi-live run).
  const worktreesBase = path.join(os.tmpdir(), ".deeplooper-worktrees", meta.runId);
  await rm(worktreesBase, { recursive: true, force: true }).catch(() => undefined);

  const workspaceRoot = mode === "semi-live" ? await createSemiLiveWorkspace(meta.runId) : await createPureWorkspace();

  const artifacts = getRunArtifacts(workspaceRoot, meta.runId);
  await ensureRunDirectories(artifacts);

  const clock = new SystemClock();
  const pi = createExecAdapter(workspaceRoot);

  const replayGate = new ReplayGateManager(reader, meta.interactionMode, meta.failurePolicy, meta.reviewDepth);

  // Provide a fallback for leaf agents added after existing cassettes were recorded.
  // These agents were not present during recording so there are no cassette entries for them.
  // The fallback returns canonical PASS responses so the pipeline proceeds identically to the
  // original run, with the new dispatch events appearing in the event stream (causing goldens
  // to be regenerated once on the next run).
  const postCassetteAgentFallback = new PostCassetteAgentFallback();
  const replayDispatcher = new ReplayDispatcher(
    reader,
    mode,
    workspaceRoot,
    meta.runId,
    applyPatch,
    "live-fallthrough",
    postCassetteAgentFallback,
  );

  // Wrap GitVersionControl with StubChangesVersionControl so that changedFiles/changedLineCount
  // always return [] / 0, matching what FakeVersionControl returns in pure mode and what was
  // recorded in the cassette.  This keeps the code-review dispatch key stable across all modes.
  const versionControl =
    mode === "semi-live"
      ? new StubChangesVersionControl(new GitVersionControl(pi, workspaceRoot, meta.runId))
      : new FakeVersionControl(workspaceRoot, meta.runId);

  // Always use FakeBuildTool in both replay modes so that build-script output
  // (npm version headers, stdout) is deterministic and matches the cassette
  // recordings (which also use FakeBuildTool).  The "live" in semi-live refers
  // to real git I/O, not npm script execution.
  const buildTool = new FakeBuildTool();
  const commandRunner: import("../../application/port/index.js").CommandRunnerPort = {
    run(_cmd, _args, _cwd): Promise<import("../../application/port/index.js").ExecOutcome> {
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    },
  };

  const artifactRepo = FileSystemArtifactRepository.fromPaths(artifacts);
  const stateRepo = new FileSystemRunStateRepository(artifacts.stateFile);
  const telemetrySink = JsonlTelemetrySink.create(artifacts, meta.runId, clock);
  await telemetrySink.initialize();

  const services: PipelineServices = {
    commandContext: { signal: undefined },
    eventContext: { signal: undefined },
    dispatcher: replayDispatcher,
    agentDefinitions,
    gates: replayGate,
    progress: new NoopProgressReporter(),
    clock,
    versionControl,
    buildTool,
    commandRunner,
    artifactRepo,
    stateRepo,
    telemetrySink,
  };

  const initialRun = Run.start({
    runId: meta.runId,
    userTask: meta.userTask,
    interactionMode: meta.interactionMode,
    failurePolicy: meta.failurePolicy,
    route: meta.route,
  });

  try {
    const finalState = await runPipeline({
      services,
      state: initialRun.toSnapshot(),
      workspaceRoot,
      isResumed: false,
    });

    const events = await telemetrySink.readEvents();
    return { finalState, events, workspaceRoot };
  } finally {
    // Clean up worktree dirs created during this run (pure: applyWrittenFiles dirs; semi-live:
    // any dirs left over after git worktree cleanup).
    await rm(worktreesBase, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// normalizeEvents — strip volatile fields for golden comparison
// ---------------------------------------------------------------------------

export type NormalizedEvent = Omit<TelemetryEvent, "ts" | "event_id" | "sequence" | "timing">;

export function normalizeEvents(events: TelemetryEvent[]): NormalizedEvent[] {
  return events.map(({ ts: _ts, event_id: _eid, sequence: _seq, timing: _timing, ...rest }) => rest);
}
