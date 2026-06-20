/**
 * SessionActivity — typed surface over the nested AgentSession event stream.
 *
 * mapAgentSessionEvent() is a pure function for unit testing.
 * ActivityReporter subscribes to a session and forwards mapped activities
 * to an ActivityPresenter.
 *
 * The ActivityPresenter interface is defined here to avoid circular imports
 * between session-activity.ts and live-activity-presenter.ts.
 */

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import type { RunState } from "../../application/port/index.js";
import type { DomainEvent } from "../../domain/event/index.js";

// ---------------------------------------------------------------------------
// SessionActivity union
// ---------------------------------------------------------------------------

export type SessionActivity =
  | { kind: "turn_start"; turnCount: number }
  | { kind: "tool_start"; toolName: string; command: string | undefined }
  | { kind: "tool_output_chunk"; toolName: string; tail: string[] }
  | { kind: "tool_end"; toolName: string }
  | { kind: "assistant_delta"; text: string };

// ---------------------------------------------------------------------------
// ActivityPresenter interface (implemented by LiveActivityPresenter / NoopActivityPresenter)
// ---------------------------------------------------------------------------

export interface ActivityPresenter {
  /** Called for every domain event recorded by the telemetry sink. */
  onDomainEvent(event: DomainEvent): void;
  /** Called when regenerateRunLog produces a fresh RunState. */
  onRunStateRefresh(state: RunState): void;
  /** Called when a nested agent session starts. */
  onSessionStart(correlationId: string, label: string): void;
  /** Called for each mapped activity from a nested session. */
  onSessionActivity(correlationId: string, activity: SessionActivity): void;
  /** Called when a nested agent session ends. */
  onSessionEnd(correlationId: string): void;
  /** Starts the heartbeat ticker; call once before runPipeline. */
  start(): void;
  /** Stops the heartbeat ticker and clears all widgets; call in finally. */
  stop(): void;
}

// ---------------------------------------------------------------------------
// NoopActivityPresenter — used in headless / test contexts
// ---------------------------------------------------------------------------

export class NoopActivityPresenter implements ActivityPresenter {
  onDomainEvent(_event: DomainEvent): void {}
  onRunStateRefresh(_state: RunState): void {}
  onSessionStart(_correlationId: string, _label: string): void {}
  onSessionActivity(_correlationId: string, _activity: SessionActivity): void {}
  onSessionEnd(_correlationId: string): void {}
  start(): void {}
  stop(): void {}
}

// ---------------------------------------------------------------------------
// mapAgentSessionEvent — pure, testable mapping function
// ---------------------------------------------------------------------------

/**
 * Maps an AgentSessionEvent to a SessionActivity, or returns undefined for
 * events that carry no useful UI information (e.g. compaction or turn_start
 * events, which are handled directly by ActivityReporter with a per-session counter).
 *
 * All string content is capped to avoid flooding the ring buffer.
 */
export function mapAgentSessionEvent(event: AgentSessionEvent): SessionActivity | undefined {
  switch (event.type) {
    case "tool_execution_start": {
      const toolName = event.toolName;
      // Extract bash command if present
      const args = event.args as Record<string, unknown> | undefined;
      const command =
        toolName === "bash" && args && typeof args["command"] === "string"
          ? String(args["command"]).slice(0, 200)
          : undefined;
      return { kind: "tool_start", toolName, command };
    }

    case "tool_execution_update": {
      const toolName = event.toolName;
      // Extract partial text content from partialResult
      const partial = event.partialResult as { content?: Array<{ type?: string; text?: string }> } | undefined;
      const text = extractPartialText(partial);
      if (!text) return undefined;
      // Split into lines and keep the last 6
      const tail = text
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .slice(-6);
      return { kind: "tool_output_chunk", toolName, tail };
    }

    case "tool_execution_end": {
      return { kind: "tool_end", toolName: event.toolName };
    }

    case "message_update": {
      const msg = event.message as { content?: unknown };
      if (!msg.content) return undefined;
      const text = extractMessageText(msg.content);
      if (!text) return undefined;
      return { kind: "assistant_delta", text: text.slice(0, 200) };
    }

    default:
      return undefined;
  }
}

function extractPartialText(partial: { content?: Array<{ type?: string; text?: string }> } | undefined): string {
  if (!partial?.content) return "";
  return partial.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text ?? "")
    .join("");
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text ?? "")
      .join("");
  }
  return "";
}

// ---------------------------------------------------------------------------
// ActivityReporter — subscribes to a session and forwards mapped activities
// ---------------------------------------------------------------------------

/** Minimal interface for an agent session — allows testing without the full SDK. */
export interface SubscribableSession {
  subscribe(handler: (event: AgentSessionEvent) => void): () => void;
}

export class ActivityReporter {
  private unsubscribe: (() => void) | undefined;
  private localTurnIndex = 0;

  constructor(
    private readonly correlationId: string,
    private readonly presenter: ActivityPresenter,
  ) {}

  attach(session: SubscribableSession): void {
    this.localTurnIndex = 0;
    this.unsubscribe = session.subscribe((event) => {
      // Use a local turn counter so each session starts at 1
      if (event.type === "turn_start") {
        this.localTurnIndex += 1;
        this.presenter.onSessionActivity(this.correlationId, {
          kind: "turn_start",
          turnCount: this.localTurnIndex,
        });
        return;
      }

      const activity = mapAgentSessionEvent(event);
      if (activity) {
        // Override turn count with local count for turn_start (already handled above)
        this.presenter.onSessionActivity(this.correlationId, activity);
      }
    });
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}
