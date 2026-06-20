/**
 * RecordingDispatcher — wraps any Dispatcher to record all dispatches into a CassetteWriter.
 *
 * All four Dispatcher methods are reimplemented through the wrapper's own dispatch() so
 * that fan-out methods (dispatchParallel, dispatchChain, dispatchGenericCoding) never
 * bypass recording via the inner dispatcher's own fan-out logic.
 *
 * Before each dispatch a git tree-object snapshot is taken; after the dispatch the diff
 * is computed and stored as writtenFiles (for leaf dispatches) and workspacePatch (for
 * generic dispatches in semi-live replay).  This ensures that side-effect file writes
 * (e.g. MockDispatcher writing research/summary.md) are captured in the cassette.
 */

import type { DispatchRequest, DispatchResult, Dispatcher, StageOutcome } from "../../application/port/index.js";
import { createStageReturnTool, normalizeStageReturn, type StageReturnPayload } from "../pi/stage-return-tool.js";
import { type CassetteWriter, dispatchKey, trimResult, type WrittenFile } from "./cassette.js";

/**
 * Two-phase workspace capture.
 * snapshot() must be called before the inner dispatch; diff() after.
 */
export interface WorkspaceCapture {
  /**
   * Stage all current changes, create a git tree-object snapshot, then unstage.
   * Returns an opaque handle (tree SHA) or "" when capture is unavailable.
   */
  snapshot(cwd: string): Promise<string>;
  /**
   * Stage all changes written by the dispatch, diff against the pre-dispatch handle,
   * then unstage.  Returns both a file list and a unified patch string.
   */
  diff(
    cwd: string,
    handle: string,
  ): Promise<{
    files: WrittenFile[];
    patch: string;
  }>;
}

export class RecordingDispatcher implements Dispatcher {
  constructor(
    private readonly inner: Dispatcher,
    private readonly writer: CassetteWriter,
    private readonly workspaceRoot: string,
    private readonly runId: string,
    private readonly capture: WorkspaceCapture,
  ) {}

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    const key = dispatchKey(request, this.workspaceRoot, this.runId);
    const ordinal = this.writer.nextDispatchOrdinal();

    const cwd = request.cwd ?? "";
    const handle = cwd ? await this.capture.snapshot(cwd) : "";

    const result = await this.inner.dispatch(request);

    let workspacePatch: string | undefined;
    let writtenFiles: WrittenFile[] | undefined;

    if (cwd && handle) {
      const { files, patch } = await this.capture.diff(cwd, handle);
      if (files.length > 0) {
        writtenFiles = files;
      }
      if (request.target.kind === "generic" && patch.trim()) {
        workspacePatch = patch;
      }
    }

    this.writer.appendDispatch({
      key,
      ordinal,
      targetName: request.target.name,
      targetKind: request.target.kind,
      promptHead: request.prompt.slice(0, 200),
      result: trimResult(result),
      ...(workspacePatch !== undefined ? { workspacePatch } : {}),
      ...(writtenFiles !== undefined ? { writtenFiles } : {}),
    });

    return result;
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
