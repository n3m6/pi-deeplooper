// FileSystemRunStateRepository — load/save the Run aggregate from state.json.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Run } from "../../domain/run/index.js";
import type { RunState, RunStateRepository } from "../../application/port/index.js";

export class FileSystemRunStateRepository implements RunStateRepository {
  constructor(private readonly stateFilePath: string) {}

  async load(_runId: string): Promise<Run | undefined> {
    const state = await loadState(this.stateFilePath);
    if (!state) {
      return undefined;
    }
    return Run.rehydrate(state);
  }

  async save(run: Run): Promise<void> {
    await saveState(this.stateFilePath, run.toSnapshot());
  }
}

export async function loadState(stateFile: string): Promise<RunState | undefined> {
  try {
    const raw = await readFile(stateFile, "utf8");
    const parsed = JSON.parse(raw) as RunState;
    return {
      ...parsed,
      currentSlice: parsed.currentSlice ?? null,
      slicesDone: parsed.slicesDone ?? [],
      slicesBlocked: parsed.slicesBlocked ?? [],
      requeueCounts: parsed.requeueCounts ?? {},
      pendingReconcile: parsed.pendingReconcile ?? false,
    };
  } catch {
    return undefined;
  }
}

export async function saveState(stateFile: string, state: RunState): Promise<void> {
  const nextState: RunState = {
    ...state,
    updatedAt: new Date().toISOString(),
  };
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
}
