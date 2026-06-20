import type { StageRuntime } from "../port/index.js";

/**
 * In DEEPLOOPER there is no per-phase acceptance retry counter.
 * The reflector handles remediation via the backward loop protocol.
 * This function always returns an empty string.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- kept for API compatibility
export async function renderAcceptanceRepairContext(_runtime: StageRuntime): Promise<string> {
  return "";
}
