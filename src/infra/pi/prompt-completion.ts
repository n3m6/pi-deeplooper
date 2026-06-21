import type { DispatchResult } from "../../application/port/index.js";
import type { AgentSession } from "./session-factory.js";

type DispatchEndReason = NonNullable<DispatchResult["endReason"]>;

/**
 * Drives `session.prompt()` and races it against four interruption signals:
 *
 *   - `agent_end` session event  — the agent finished normally
 *   - `stageReturn` promise      — a stage/goals/interview_return tool was called
 *   - `signal` AbortSignal       — an external cancellation request
 *   - `timeoutMs`                — a hard wall-clock deadline
 *
 * Whichever fires first determines the returned `DispatchEndReason`.
 * Cleanup (unsubscribe, clearTimeout, removeEventListener) is always performed
 * in the `finally` block regardless of which path wins.
 */
export async function waitForPromptCompletion(
  session: AgentSession,
  prompt: string,
  stageReturn: Promise<void>,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<DispatchEndReason> {
  if (signal?.aborted) {
    void session.abort().catch(() => undefined);
    return "aborted";
  }

  let resolveDone!: (reason: DispatchEndReason) => void;
  const done = new Promise<DispatchEndReason>((resolve) => {
    resolveDone = resolve;
  });

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "agent_end") {
      resolveDone("agent_end");
    }
  });

  const abortListener = () => {
    void session.abort().catch(() => undefined);
    resolveDone("aborted");
  };
  signal?.addEventListener("abort", abortListener, { once: true });

  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<DispatchEndReason>((resolve) => {
    if (!timeoutMs || timeoutMs <= 0) {
      return;
    }
    timeout = setTimeout(() => {
      void session.abort().catch(() => undefined);
      resolve("timeout");
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      session.prompt(prompt, { source: "extension" }).then(() => "agent_end" as const),
      done,
      stageReturn.then(() => {
        void session.abort().catch(() => undefined);
        return "stage_return" as const;
      }),
      timeoutPromise,
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    signal?.removeEventListener("abort", abortListener);
    unsubscribe();
  }
}
