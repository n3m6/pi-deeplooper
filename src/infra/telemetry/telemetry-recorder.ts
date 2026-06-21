import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { DomainEvent } from "../../domain/event/index.js";
import type { Clock, TelemetrySink } from "../../application/port/index.js";
import type { RunState, TelemetryEvent } from "../../application/port/index.js";
import type { RunArtifacts } from "../fs/artifact-repository.js";
import { domainEventToTelemetryEvent } from "./domain-event-mapping.js";
import { renderMetricsSummary, renderRunLog } from "./telemetry-render.js";

const SCHEMA_VERSION = "1.0";

// ---------------------------------------------------------------------------
// TelemetryRecorder — appends raw TelemetryEvents to the JSONL file.
// ---------------------------------------------------------------------------

export class TelemetryRecorder {
  private sequence = 1;
  /** Serializes concurrent append() calls so parallel wave/dispatch emissions don't interleave the file. */
  private appendQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly artifacts: RunArtifacts,
    private readonly runId: string,
    private readonly clock?: Clock,
  ) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.artifacts.eventsFile), { recursive: true });
    const events = await this.readEvents();
    this.sequence = events.length + 1;
    if (events.length === 0) {
      await writeFile(this.artifacts.eventsFile, "", "utf8");
    }
  }

  async readEvents(): Promise<TelemetryEvent[]> {
    try {
      const raw = await readFile(this.artifacts.eventsFile, "utf8");
      return raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as TelemetryEvent);
    } catch {
      return [];
    }
  }

  append(
    event: Omit<
      TelemetryEvent,
      "schema_version" | "event_id" | "sequence" | "ts" | "run_id" | "writer_agent" | "writer_scope"
    >,
  ): Promise<TelemetryEvent> {
    let resolveOuter!: (value: TelemetryEvent) => void;
    let rejectOuter!: (reason: unknown) => void;
    const outer = new Promise<TelemetryEvent>((resolve, reject) => {
      resolveOuter = resolve;
      rejectOuter = reject;
    });

    this.appendQueue = this.appendQueue.then(async () => {
      try {
        const fullEvent: TelemetryEvent = {
          schema_version: SCHEMA_VERSION,
          event_id: `${this.runId}-${this.sequence}`,
          sequence: this.sequence,
          ts: (this.clock?.now() ?? new Date()).toISOString(),
          run_id: this.runId,
          writer_agent: "deeplooper",
          writer_scope: "orchestrator",
          ...event,
        };
        this.sequence += 1;
        const line = JSON.stringify(fullEvent);
        const existing = await readSafe(this.artifacts.eventsFile);
        const next = existing ? `${existing.trimEnd()}\n${line}\n` : `${line}\n`;
        await writeFile(this.artifacts.eventsFile, next, "utf8");
        resolveOuter(fullEvent);
      } catch (err) {
        rejectOuter(err);
      }
    });

    return outer;
  }

  async regenerateRunLog(state: RunState): Promise<void> {
    const events = await this.readEvents();
    const markdown = renderRunLog(this.runId, state, events);
    await writeFile(this.artifacts.runLogFile, markdown, "utf8");
  }

  async regenerateMetrics(state: RunState): Promise<void> {
    const events = await this.readEvents();
    const markdown = renderMetricsSummary(this.runId, state, events);
    await writeFile(this.artifacts.metricsFile, markdown, "utf8");
  }
}

// ---------------------------------------------------------------------------
// JsonlTelemetrySink — implements the TelemetrySink port with domain-event mapping.
// ---------------------------------------------------------------------------

export class JsonlTelemetrySink implements TelemetrySink {
  constructor(private readonly recorder: TelemetryRecorder) {}

  static create(artifacts: RunArtifacts, runId: string, clock?: Clock): JsonlTelemetrySink {
    return new JsonlTelemetrySink(new TelemetryRecorder(artifacts, runId, clock));
  }

  async initialize(): Promise<void> {
    await this.recorder.initialize();
  }

  async record(event: DomainEvent): Promise<void> {
    const mapped = domainEventToTelemetryEvent(event);
    if (mapped) {
      await this.recorder.append(mapped);
    }
  }

  async regenerateRunLog(state: RunState): Promise<void> {
    await this.recorder.regenerateRunLog(state);
  }

  async regenerateMetrics(state: RunState): Promise<void> {
    await this.recorder.regenerateMetrics(state);
  }

  async readEvents(): Promise<TelemetryEvent[]> {
    return this.recorder.readEvents();
  }
}

async function readSafe(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}
