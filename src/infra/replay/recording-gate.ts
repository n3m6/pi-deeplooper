/**
 * RecordingGateManager — wraps any GateManager to record direct gate calls.
 *
 * Only top-level stage calls (askText, choose, confirm) are recorded.
 * createAskHumanTool() delegates to the inner gate so in-session ask_human tool
 * invocations are NOT double-recorded — only the direct stage-level calls matter
 * for replay.
 */

import type {
  CustomTool,
  FailurePolicy,
  GateChoice,
  GateManager,
  GateOption,
  InteractionMode,
  ReviewDepth,
} from "../../application/port/index.js";
import { type CassetteWriter } from "./cassette.js";

export class RecordingGateManager implements GateManager {
  readonly interactionMode: InteractionMode;
  readonly failurePolicy: FailurePolicy;
  readonly reviewDepth?: ReviewDepth;

  constructor(
    private readonly inner: GateManager,
    private readonly writer: CassetteWriter,
  ) {
    this.interactionMode = inner.interactionMode;
    this.failurePolicy = inner.failurePolicy;
    if (inner.reviewDepth !== undefined) {
      this.reviewDepth = inner.reviewDepth;
    }
  }

  async askText(title: string, question: string, placeholder?: string): Promise<string | undefined> {
    const ordinal = this.writer.nextGateOrdinal("askText");
    const decision = await this.inner.askText(title, question, placeholder);
    this.writer.appendGate({ method: "askText", ordinal, args: [title, question, placeholder], decision });
    return decision;
  }

  async choose(title: string, options: GateOption[], message?: string): Promise<GateChoice | undefined> {
    const ordinal = this.writer.nextGateOrdinal("choose");
    const decision = await this.inner.choose(title, options, message);
    this.writer.appendGate({ method: "choose", ordinal, args: [title, options, message], decision });
    return decision;
  }

  async confirm(title: string, message: string): Promise<boolean> {
    const ordinal = this.writer.nextGateOrdinal("confirm");
    const decision = await this.inner.confirm(title, message);
    this.writer.appendGate({ method: "confirm", ordinal, args: [title, message], decision });
    return decision;
  }

  /** Delegate to inner — in-session ask_human calls route through the inner gate, not the wrapper. */
  createAskHumanTool(): CustomTool {
    return this.inner.createAskHumanTool();
  }

  createGoalsReturnTool(): CustomTool {
    return this.inner.createGoalsReturnTool();
  }

  createInterviewReturnTool(): CustomTool {
    return this.inner.createInterviewReturnTool();
  }
}
