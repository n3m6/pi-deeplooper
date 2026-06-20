/**
 * ReplayDispatcher — serves DispatchResults from a CassetteReader instead of running LLM sessions.
 *
 * Modes:
 *   pure      — returns the cassette result immediately; applies writtenFiles for leaf dispatches
 *               so that stage code can read files written as a side-effect of the original dispatch
 *   semi-live — for generic dispatches: applies the recorded workspacePatch (git apply) so that
 *               real git worktree operations act on actual file content; for leaf dispatches:
 *               applies writtenFiles directly (same as pure, since .pipeline/ is gitignored)
 *
 * Miss policies:
 *   strict          — throws CassetteMiss on an unmatched key (safe default for tests)
 *   live-fallthrough — calls an optional inner Dispatcher and appends the result (for dev use)
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { DispatchRequest, DispatchResult, Dispatcher, StageOutcome } from "../../application/port/index.js";
import { createStageReturnTool, normalizeStageReturn, type StageReturnPayload } from "../pi/stage-return-tool.js";
import { type CassetteReader, dispatchKey, restoreResult, type WrittenFile } from "./cassette.js";

export type ReplayMode = "pure" | "semi-live";
export type MissPolicy = "strict" | "live-fallthrough";

export class ReplayDispatcher implements Dispatcher {
  constructor(
    private readonly reader: CassetteReader,
    private readonly mode: ReplayMode,
    private readonly workspaceRoot: string,
    private readonly runId: string,
    /** Applies a unified patch string to a directory (e.g. via `git apply`). */
    private readonly applyPatch: (cwd: string, patch: string) => Promise<void>,
    private readonly missPolicy: MissPolicy = "strict",
    /** Only used when missPolicy === "live-fallthrough". */
    private readonly fallthrough?: Dispatcher,
  ) {}

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    const key = dispatchKey(request, this.workspaceRoot, this.runId);
    const entry = this.reader.nextDispatch(key);

    if (!entry) {
      if (this.missPolicy === "live-fallthrough" && this.fallthrough) {
        return this.fallthrough.dispatch(request);
      }
      throw new Error(
        `CassetteMiss: no recorded entry for target="${request.target.name}" key=${key} prompt="${request.prompt.slice(0, 100)}"`,
      );
    }

    const isGeneric = entry.targetKind === "generic";
    // Fall back to workspaceRoot when no per-dispatch cwd is supplied. dispatchGenericCoding
    // defaults cwd to "" when a caller omits it, and dispatchKey does not include cwd — so a
    // dispatch recorded with a real cwd (capturing writtenFiles) can be replayed with cwd="".
    // Without this fallback the truthy `&& cwd` guards below would silently drop writtenFiles,
    // leaving stage code unable to read the files it expects. workspaceRoot is the correct base
    // for leaf writtenFiles; generic dispatches always pass a real worktree cwd, so this is a no-op
    // for them in practice.
    const cwd = request.cwd || this.workspaceRoot;

    const genericSemiLive = isGeneric && this.mode === "semi-live";

    if (genericSemiLive && entry.workspacePatch && cwd) {
      // Apply git patch to worktree for semi-live fidelity (squash/merge sees real content)
      await this.applyPatch(cwd, entry.workspacePatch);
    } else if (!genericSemiLive && entry.writtenFiles && entry.writtenFiles.length > 0 && cwd) {
      // For leaf dispatches in both modes, and generic in pure mode:
      // write files directly so stage code can read them after the dispatch returns.
      // For generic semi-live the git patch is authoritative, so writtenFiles are never
      // applied here — even when the patch is absent — to preserve that invariant.
      await applyWrittenFiles(cwd, entry.writtenFiles);
    }

    return restoreResult(entry.result);
  }

  async dispatchParallel(requests: DispatchRequest[]): Promise<DispatchResult[]> {
    return Promise.all(requests.map((r) => this.dispatch(r)));
  }

  async dispatchChain(requests: DispatchRequest[]): Promise<DispatchResult[]> {
    const results: DispatchResult[] = [];
    for (const request of requests) {
      const previous = results.at(-1)?.text ?? "";
      const prompt = request.prompt.replaceAll("{previous}", previous);
      results.push(await this.dispatch({ ...request, prompt }));
    }
    return results;
  }

  async dispatchGenericCoding(
    prompt: string,
    options?: {
      cwd?: string;
      tools?: string[];
      signal?: AbortSignal;
      correlationId?: string;
      activityLabel?: string;
    },
  ): Promise<StageOutcome> {
    const stageReturns: StageReturnPayload[] = [];
    const result = await this.dispatch({
      target: {
        kind: "generic",
        name: "generic-coding",
        tools: options?.tools ?? ["read", "bash", "edit", "write", "grep", "find", "ls"],
        thinkingLevel: "high",
      },
      prompt,
      cwd: options?.cwd ?? "",
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.correlationId ? { correlationId: options.correlationId } : {}),
      ...(options?.activityLabel ? { activityLabel: options.activityLabel } : {}),
      customTools: [createStageReturnTool(stageReturns)],
    });
    return normalizeStageReturn(result);
  }
}

async function applyWrittenFiles(cwd: string, files: WrittenFile[]): Promise<void> {
  for (const file of files) {
    const absPath = path.join(cwd, file.path);
    await mkdir(path.dirname(absPath), { recursive: true });
    await writeFile(absPath, file.content, "utf8");
  }
}
