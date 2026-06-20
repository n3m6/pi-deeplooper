import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
import { RecordingDispatcher, type WorkspaceCapture } from "./infra/replay/recording-dispatcher.js";
import { RecordingGateManager } from "./infra/replay/recording-gate.js";
import { JsonlTelemetrySink } from "./infra/telemetry/jsonl-telemetry-sink.js";
import { TimestampIdGenerator } from "./infra/system/id-generator.js";
import { SystemClock } from "./infra/system/clock.js";
import { Run } from "./domain/run/index.js";
import { runPipeline } from "./application/pipeline/run-pipeline.js";
import type { Dispatcher, GateManager, PipelineServices } from "./application/port/index.js";

export default function (pi: ExtensionAPI): void {
  // Register the transcript breadcrumb renderer once at extension load time.
  pi.registerMessageRenderer(DEEPLOOPER_PROGRESS_CUSTOM_TYPE, DEEPLOOPER_PROGRESS_RENDERER);

  pi.registerCommand("deeplooper", {
    description: "Run the deterministic DEEPLOOPER vertical-slice pipeline.",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const interaction = determineInteractionMode(ctx, args);
      const clock = new SystemClock();
      const runId = interaction.explicit.resumeRunId ?? new TimestampIdGenerator().runId();
      const userTask = interaction.explicit.resumeRunId ? undefined : stripCommandFlags(args).trim();

      const agentCatalog = await MarkdownAgentCatalog.load();
      const agentDefinitions = agentCatalog.all();

      // Construct the presenter once; shared by the sink and dispatcher.
      const presenter = ctx.hasUI ? new LiveActivityPresenter(ctx) : undefined;

      const modelConfig = await loadModelConfig(ctx.cwd, (msg) => ctx.ui.notify(msg, "warning"));
      const activeProfileName = interaction.explicit.modelProfile ?? modelConfig.profile;
      const activeProfile = resolveProfile(modelConfig, activeProfileName);
      const modelPolicy = new ConfiguredModelPolicy(activeProfile);

      let dispatcher: Dispatcher = new PiSessionDispatcher(
        ctx.modelRegistry,
        ctx.model,
        undefined,
        presenter,
        modelPolicy,
      );
      let gates: GateManager = new DefaultGateManager(ctx, {
        interactionMode: interaction.interactionMode,
        failurePolicy: interaction.failurePolicy,
        reviewDepth: interaction.reviewDepth,
      });
      const progress = new UiProgressReporter(ctx);

      const resumedState = await resumeOrInferState({
        workspaceRoot: ctx.cwd,
        runId,
        interactionMode: interaction.interactionMode,
        failurePolicy: interaction.failurePolicy,
      });
      const artifacts = getRunArtifacts(ctx.cwd, runId);
      await ensureRunDirectories(artifacts);

      // Env-gated recording: set DEEPLOOPER_RECORD=<dir> or DEEPLOOPER_RECORD=1 (→ <runDir>/cassette/)
      const recordEnv = process.env["DEEPLOOPER_RECORD"];
      let cassetteWriter: CassetteWriter | undefined;
      if (recordEnv) {
        cassetteWriter = new CassetteWriter();
        const capture: WorkspaceCapture = {
          async snapshot(cwd: string): Promise<string> {
            await pi.exec("git", ["-C", cwd, "add", "-A"], { cwd, timeout: 30_000 });
            const result = await pi.exec("git", ["-C", cwd, "write-tree"], { cwd, timeout: 30_000 });
            await pi.exec("git", ["-C", cwd, "reset"], { cwd, timeout: 30_000 });
            return result.stdout.trim();
          },
          async diff(
            cwd: string,
            handle: string,
          ): Promise<{ files: Array<{ path: string; content: string }>; patch: string }> {
            if (!handle) return { files: [], patch: "" };
            const { readFile } = await import("node:fs/promises");
            await pi.exec("git", ["-C", cwd, "add", "-A"], { cwd, timeout: 30_000 });
            const nameResult = await pi.exec(
              "git",
              ["-C", cwd, "diff", "--cached", handle, "--name-only", "--diff-filter=AM"],
              { cwd, timeout: 30_000 },
            );
            const patchResult = await pi.exec("git", ["-C", cwd, "diff", "--cached", handle], { cwd, timeout: 30_000 });
            await pi.exec("git", ["-C", cwd, "reset"], { cwd, timeout: 30_000 });
            const relPaths = nameResult.stdout
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean);
            const files: Array<{ path: string; content: string }> = [];
            for (const relPath of relPaths) {
              try {
                const content = await readFile(`${cwd}/${relPath}`, "utf8");
                files.push({ path: relPath, content });
              } catch {
                /* unreadable — skip */
              }
            }
            return { files, patch: patchResult.stdout };
          },
        };
        dispatcher = new RecordingDispatcher(dispatcher, cassetteWriter, ctx.cwd, runId, capture);
        gates = new RecordingGateManager(gates, cassetteWriter);
      }

      const initialRun = resumedState
        ? Run.rehydrate(resumedState)
        : Run.start({
            runId,
            interactionMode: interaction.interactionMode,
            failurePolicy: interaction.failurePolicy,
            ...(userTask ? { userTask } : {}),
          });

      const artifactRepo = FileSystemArtifactRepository.fromPaths(artifacts);
      const versionControl = new GitVersionControl(pi, ctx.cwd, runId);
      const buildTool = new NpmBuildTool(pi);
      const jsonlSink = JsonlTelemetrySink.create(artifacts, runId, clock);
      const telemetrySink = new LiveUiTelemetrySink(jsonlSink, pi, ctx, presenter);
      const stateRepo = new FileSystemRunStateRepository(artifacts.stateFile);

      const services: PipelineServices = {
        commandContext: { signal: ctx.signal },
        eventContext: { signal: ctx.signal },
        dispatcher,
        agentDefinitions,
        gates,
        progress,
        clock,
        artifactRepo,
        versionControl,
        buildTool,
        telemetrySink,
        stateRepo,
      };

      await telemetrySink.initialize();
      presenter?.start();

      let finalState: Awaited<ReturnType<typeof runPipeline>> | undefined;
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
        if (cassetteWriter) {
          const cassetteDir = recordEnv === "1" ? path.join(artifacts.runDir, "cassette") : (recordEnv ?? "cassette");
          const meta: CassetteMeta = {
            schemaVersion: CASSETTE_SCHEMA_VERSION,
            runId,
            route: finalState?.route ?? "full",
            interactionMode: interaction.interactionMode,
            failurePolicy: interaction.failurePolicy,
            userTask: userTask ?? "",
            reviewDepth: interaction.reviewDepth,
            ...(interaction.explicit.modelProfile !== undefined
              ? { modelProfile: interaction.explicit.modelProfile }
              : {}),
          };
          await cassetteWriter.flush(cassetteDir, meta);
        }
      }
    },
  });
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
