import type {
  FailurePolicy,
  GateChoice,
  GateManager,
  GateOption,
  InteractionMode,
  ReviewDepth,
} from "../../src/application/port/index.js";
import { createAskHumanTool } from "../../src/infra/pi/human-gate.js";
import { createGoalsReturnTool, createInterviewReturnTool } from "../../src/infra/pi/stage-return-tool.js";

export type ScriptedGateAnswer =
  | { method: "choose"; value: GateChoice | undefined }
  | { method: "askText"; value: string | undefined }
  | { method: "confirm"; value: boolean };

export interface ScriptedGateCall {
  method: "choose" | "askText" | "confirm";
  title: string;
  arg?: string | GateOption[];
}

export class ScriptedGateManager implements GateManager {
  readonly interactionMode: InteractionMode;
  readonly failurePolicy: FailurePolicy;
  readonly reviewDepth: ReviewDepth;
  readonly calls: ScriptedGateCall[] = [];
  private queue: ScriptedGateAnswer[];

  constructor(
    options: {
      interactionMode?: InteractionMode;
      failurePolicy?: FailurePolicy;
      reviewDepth?: ReviewDepth;
    },
    answers: ScriptedGateAnswer[],
  ) {
    this.interactionMode = options.interactionMode ?? "interactive";
    this.failurePolicy = options.failurePolicy ?? "best-effort";
    this.reviewDepth = options.reviewDepth ?? "thorough";
    this.queue = [...answers];
  }

  async askText(title: string, _question: string): Promise<string | undefined> {
    this.calls.push({ method: "askText", title });
    const answer = this.queue.find((a) => a.method === "askText");
    if (answer) {
      this.queue.splice(this.queue.indexOf(answer), 1);
      return answer.value;
    }
    return undefined;
  }

  async choose(title: string, options: GateOption[]): Promise<GateChoice | undefined> {
    this.calls.push({ method: "choose", title, arg: options });
    const answer = this.queue.find((a) => a.method === "choose");
    if (answer) {
      this.queue.splice(this.queue.indexOf(answer), 1);
      return answer.value;
    }
    return undefined;
  }

  async confirm(title: string): Promise<boolean> {
    this.calls.push({ method: "confirm", title });
    const answer = this.queue.find((a) => a.method === "confirm");
    if (answer) {
      this.queue.splice(this.queue.indexOf(answer), 1);
      return answer.value;
    }
    return false;
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

// Canonical alias: ScriptedHumanGate = ScriptedGateManager
export { ScriptedGateManager as ScriptedHumanGate };
