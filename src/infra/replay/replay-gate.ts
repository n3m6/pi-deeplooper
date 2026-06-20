/**
 * ReplayGateManager — serves recorded gate decisions from a CassetteReader.
 *
 * Tool factories (createAskHumanTool, createGoalsReturnTool, createInterviewReturnTool)
 * return real implementations so the tool names are correct for dispatch key computation.
 * The tools are attached to replay dispatch requests but are never actually executed since
 * no LLM session runs during replay.
 *
 * interactionMode / failurePolicy / reviewDepth come from the cassette meta so stage
 * code sees the same values as during recording.
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
import { createAskHumanTool } from "../pi/human-gate.js";
import { createGoalsReturnTool, createInterviewReturnTool } from "../pi/stage-return-tool.js";
import { type CassetteReader } from "./cassette.js";

export class ReplayGateManager implements GateManager {
  readonly interactionMode: InteractionMode;
  readonly failurePolicy: FailurePolicy;
  readonly reviewDepth?: ReviewDepth;

  constructor(
    private readonly reader: CassetteReader,
    interactionMode: InteractionMode,
    failurePolicy: FailurePolicy,
    reviewDepth?: ReviewDepth,
  ) {
    this.interactionMode = interactionMode;
    this.failurePolicy = failurePolicy;
    if (reviewDepth !== undefined) {
      this.reviewDepth = reviewDepth;
    }
  }

  askText(_title: string, _question: string, _placeholder?: string): Promise<string | undefined> {
    const entry = this.reader.nextGate("askText");
    return Promise.resolve(entry ? (entry.decision as string | undefined) : undefined);
  }

  choose(_title: string, _options: GateOption[], _message?: string): Promise<GateChoice | undefined> {
    const entry = this.reader.nextGate("choose");
    return Promise.resolve(entry ? (entry.decision as GateChoice | undefined) : undefined);
  }

  confirm(_title: string, _message: string): Promise<boolean> {
    const entry = this.reader.nextGate("confirm");
    return Promise.resolve(entry ? (entry.decision as boolean) : false);
  }

  createAskHumanTool(): CustomTool {
    return createAskHumanTool(this);
  }

  createGoalsReturnTool(): CustomTool {
    return createGoalsReturnTool();
  }

  createInterviewReturnTool(): CustomTool {
    return createInterviewReturnTool();
  }
}
