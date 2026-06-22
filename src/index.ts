import path from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { FileSystemArtifactRepository, ensureRunDirectories, getRunArtifacts } from "./infra/fs/artifact-repository.js";
import { FileSystemRunStateRepository } from "./infra/fs/state-repository.js";
import { resumeOrInferState } from "./infra/fs/state-reconstruction.js";
import { GitVersionControl } from "./infra/git/version-control.js";
import { NpmBuildTool } from "./infra/npm/build-tool.js";
import { MarkdownAgentCatalog } from "./infra/pi/agent-catalog.js";
import { DefaultGateManager, determineInteractionMode } from "./infra/pi/human-gate.js";
import { UiProgressReporter } from "./infra/pi/progress-reporter.js";
import { PiSessionDispatcher } from "./infra/pi/session-dispatcher.js";
import {
  DEEPLOOPER_PROGRESS_CUSTOM_TYPE,
  DEEPLOOPER_PROGRESS_RENDERER,
  LiveUiTelemetrySink,
} from "./infra/pi/live-ui-telemetry-sink.js";
import { LiveActivityPresenter } from "./infra/pi/live-activity-presenter.js";
import { ConfiguredModelPolicy } from "./infra/pi/model-policy.js";
import { loadModelConfig, resolveProfile } from "./infra/config/model-config.js";
import { CassetteWriter, CASSETTE_SCHEMA_VERSION, type CassetteMeta } from "./infra/replay/cassette.js";
import { createGitWorkspaceCapture } from "./infra/replay/git-workspace-capture.js";
import { RecordingDispatcher } from "./infra/replay/recording-dispatcher.js";
import { RecordingGateManager } from "./infra/replay/recording-gate.js";
import { JsonlTelemetrySink } from "./infra/telemetry/jsonl-telemetry-sink.js";
import { TimestampIdGenerator } from "./infra/system/id-generator.js";
import { SystemClock } from "./infra/system/clock.js";
import { PiCommandRunner } from "./infra/system/command-runner.js";
import { Run } from "./domain/run/index.js";
import { runPipeline } from "./application/pipeline/run-pipeline.js";
import type { Dispatcher, GateManager, ModelPolicy, PipelineServices, RunState } from "./application/port/index.js";

/** Resolved interaction settings for a run (mode, failure policy, review depth, explicit flags). */
type InteractionResolution = ReturnType<typeof determineInteractionMode>;

/**
 * Extension entry point. Registers the transcript breadcrumb renderer and the `/deeplooper`
 * command; the command handler is the composition root that wires every port and runs the
 * pipeline. Keeping the handler a thin sequence of named phases is intentional — the heavy
 * lifting lives in the helpers below and in the infra adapters.
 */
export default function (pi: ExtensionAPI): void {
  // Register the transcript breadcrumb renderer once at extension load time.
  pi.registerMessageRenderer(DEEPLOOPER_PROGRESS_CUSTOM_TYPE, DEEPLOOPER_PROGRESS_RENDERER);

  pi.registerCommand("deeplooper", {
    description: "Run the deterministic DEEPLOOPER vertical-slice pipeline.",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      // ── Phase 1: resolve run identity and interaction settings from the command args ──
      const { interaction, clock, runId, userTask } = resolveRunInputs(ctx, args);

      // ── Phase 2: load leaf-agent catalog, UI presenter, and per-tier model routing ──
      const agentDefinitions = (await MarkdownAgentCatalog.load()).all();
      // The presenter is constructed once and shared by both the dispatcher and the telemetry sink.
      const presenter = ctx.hasUI ? new LiveActivityPresenter(ctx) : undefined;
      const modelPolicy = await buildModelPolicy(ctx, interaction);

      // ── Phase 3: construct the base ports the pipeline drives ──
      const baseDispatcher: Dispatcher = new PiSessionDispatcher(
        ctx.modelRegistry,
        ctx.model,
        undefined,
        presenter,
        modelPolicy,
      );
      const baseGates: GateManager = new DefaultGateManager(ctx, {
        interactionMode: interaction.interactionMode,
        failurePolicy: interaction.failurePolicy,
        reviewDepth: interaction.reviewDepth,
      });
      const progress = new UiProgressReporter(ctx);

      // ── Phase 4: recover prior state (resume) or seed a fresh run, and ensure artifact dirs ──
      const resumedState = await resumeOrInferState({
        workspaceRoot: ctx.cwd,
        runId,
        interactionMode: interaction.interactionMode,
        failurePolicy: interaction.failurePolicy,
      });
      const artifacts = getRunArtifacts(ctx.cwd, runId);
      await ensureRunDirectories(artifacts);

      // ── Phase 5: optionally wrap dispatcher/gates for record/replay (gated by DEEPLOOPER_RECORD) ──
      const recording = setupRecording({
        pi,
        dispatcher: baseDispatcher,
        gates: baseGates,
        cwd: ctx.cwd,
        runId,
        runDir: artifacts.runDir,
        interaction,
        userTask,
      });

      const initialRun = resumedState
        ? Run.rehydrate(resumedState)
        : Run.start({
            runId,
            interactionMode: interaction.interactionMode,
            failurePolicy: interaction.failurePolicy,
            ...(userTask ? { userTask } : {}),
          });

      // ── Phase 6: wire the remaining infrastructure adapters into the services bundle ──
      // The live sink mirrors JSONL telemetry to the UI; held as a concrete ref so we can initialize it.
      const jsonlSink = JsonlTelemetrySink.create(artifacts, runId, clock);
      const telemetrySink = new LiveUiTelemetrySink(jsonlSink, pi, ctx, presenter);
      const services: PipelineServices = {
        commandContext: { signal: ctx.signal },
        eventContext: { signal: ctx.signal },
        dispatcher: recording.dispatcher,
        agentDefinitions,
        gates: recording.gates,
        progress,
        clock,
        artifactRepo: FileSystemArtifactRepository.fromPaths(artifacts),
        versionControl: new GitVersionControl(pi, ctx.cwd, runId),
        buildTool: new NpmBuildTool(pi),
        commandRunner: new PiCommandRunner(pi),
        telemetrySink,
        stateRepo: new FileSystemRunStateRepository(artifacts.stateFile),
      };

      await telemetrySink.initialize();
      presenter?.start();

      // ── Phase 7: run the pipeline, always stopping the presenter and flushing the cassette ──
      let finalState: RunState | undefined;
      try {
        finalState = await runPipeline({
          services,
          state: initialRun.toSnapshot(),
          workspaceRoot: ctx.cwd,
          isResumed: !!resumedState,
        });
        ctx.ui.notify(`Deeplooper run ${runId} finished at stage ${finalState.lastCompletedStage}.`, "info");
      } finally {
        presenter?.stop();
        await recording.flush(finalState);
      }
    },
  });
}

interface RunInputs {
  interaction: InteractionResolution;
  clock: SystemClock;
  runId: string;
  userTask: string | undefined;
}

/**
 * Derives the run identity from the command invocation. On resume the run-id comes from the
 * `run-id:` flag and there is no fresh user task; otherwise a timestamped id is minted and the
 * task text is the args with all control flags stripped out.
 */
function resolveRunInputs(ctx: ExtensionCommandContext, args: string): RunInputs {
  const interaction = determineInteractionMode(ctx, args);
  const clock = new SystemClock();
  const runId = interaction.explicit.resumeRunId ?? new TimestampIdGenerator().runId();
  const userTask = interaction.explicit.resumeRunId ? undefined : stripCommandFlags(args).trim();
  return { interaction, clock, runId, userTask };
}

/**
 * Resolves the active model profile (explicit `models:` flag wins over the config default) and
 * returns a policy that maps each model tier to a concrete model + thinking level.
 */
async function buildModelPolicy(
  ctx: ExtensionCommandContext,
  interaction: InteractionResolution,
): Promise<ModelPolicy> {
  const modelConfig = await loadModelConfig(ctx.cwd, (msg) => ctx.ui.notify(msg, "warning"));
  const activeProfileName = interaction.explicit.modelProfile ?? modelConfig.profile;
  const activeProfile = resolveProfile(modelConfig, activeProfileName);
  return new ConfiguredModelPolicy(activeProfile);
}

interface RecordingSetup {
  dispatcher: Dispatcher;
  gates: GateManager;
  /** Persists the cassette once the run finishes. A no-op when recording is disabled. */
  flush(finalState: RunState | undefined): Promise<void>;
}

/**
 * Env-gated record/replay wiring. When DEEPLOOPER_RECORD is set, the dispatcher and gate
 * manager are wrapped so every dispatch and gate decision is captured into a cassette, and the
 * returned `flush` writes that cassette on completion. When unset, the inputs are returned
 * untouched alongside a no-op flush so the caller stays branch-free.
 *
 *   DEEPLOOPER_RECORD=1      → cassette written to <runDir>/cassette/
 *   DEEPLOOPER_RECORD=<dir>  → cassette written to <dir>
 */
function setupRecording(params: {
  pi: ExtensionAPI;
  dispatcher: Dispatcher;
  gates: GateManager;
  cwd: string;
  runId: string;
  runDir: string;
  interaction: InteractionResolution;
  userTask: string | undefined;
}): RecordingSetup {
  const { pi, dispatcher, gates, cwd, runId, runDir, interaction, userTask } = params;

  const recordEnv = process.env["DEEPLOOPER_RECORD"];
  if (!recordEnv) {
    return { dispatcher, gates, flush: async () => {} };
  }

  const writer = new CassetteWriter();
  return {
    dispatcher: new RecordingDispatcher(dispatcher, writer, cwd, runId, createGitWorkspaceCapture(pi)),
    gates: new RecordingGateManager(gates, writer),
    async flush(finalState) {
      const cassetteDir = recordEnv === "1" ? path.join(runDir, "cassette") : recordEnv;
      const meta: CassetteMeta = {
        schemaVersion: CASSETTE_SCHEMA_VERSION,
        runId,
        route: finalState?.route ?? "full",
        interactionMode: interaction.interactionMode,
        failurePolicy: interaction.failurePolicy,
        userTask: userTask ?? "",
        reviewDepth: interaction.reviewDepth,
        ...(interaction.explicit.modelProfile !== undefined ? { modelProfile: interaction.explicit.modelProfile } : {}),
      };
      await writer.flush(cassetteDir, meta);
    },
  };
}

export function stripCommandFlags(args: string): string {
  return args
    .replace(/\bmode:(interactive|automated)\b/gi, "")
    .replace(/\bfailure(?:_policy)?:((?:fail-closed)|(?:best-effort))\b/gi, "")
    .replace(/\brun-id:(deeplooper-[0-9]{8}-[0-9]{6})\b/gi, "")
    .replace(/\bresume\b/gi, "")
    .replace(/\breview:(thorough|fast)\b/gi, "")
    .replace(/\bmodels:[a-z0-9-]+\b/gi, "")
    .trim();
}
