import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { ProgressReporter } from "../../application/port/index.js";

const STATUS_KEY = "deeplooper";

export class UiProgressReporter implements ProgressReporter {
  constructor(private readonly ctx: ExtensionCommandContext) {}

  setStage(stage: string, detail?: string): void {
    const text = detail ? `${stage}: ${detail}` : stage;
    this.ctx.ui.setStatus(STATUS_KEY, text);
  }

  setWidget(lines: string[]): void {
    this.ctx.ui.setWidget(STATUS_KEY, lines);
  }

  clear(): void {
    this.ctx.ui.setStatus(STATUS_KEY, undefined);
    this.ctx.ui.setWidget(STATUS_KEY, undefined);
  }
}
