/**
 * InMemoryArtifactRepository — in-process test double for ArtifactRepository.
 *
 * Satisfies the ArtifactRepository port without touching the file system.
 */

import type { ArtifactId, ArtifactRepository } from "../../src/application/port/index.js";

export class InMemoryArtifactRepository implements ArtifactRepository {
  private readonly store = new Map<string, string>();
  private readonly workspaceFiles = new Map<string, string>();

  private key(id: ArtifactId): string {
    switch (id.kind) {
      case "taskSpec":
        return `taskSpec:${id.phase}:${id.taskId}`;
      case "phaseFile":
        return `phaseFile:${id.phase}:${id.name}`;
      case "reviewFile":
        return `reviewFile:${id.name}`;
      case "feedbackFile":
        return `feedbackFile:${id.name}`;
      case "researchFile":
        return `researchFile:${id.name}`;
      case "runFile":
        return `runFile:${id.name}`;
      default:
        return id.kind;
    }
  }

  seed(id: ArtifactId, content: string): this {
    this.store.set(this.key(id), content);
    return this;
  }

  async read(id: ArtifactId): Promise<string | undefined> {
    return this.store.get(this.key(id));
  }

  async write(id: ArtifactId, content: string): Promise<void> {
    this.store.set(this.key(id), content);
  }

  async exists(id: ArtifactId): Promise<boolean> {
    return this.store.has(this.key(id));
  }

  resolvePath(id: ArtifactId): string {
    return `/memory/${this.key(id)}`;
  }

  relPath(id: ArtifactId): string {
    return this.key(id);
  }

  async listTaskSpecs(phase?: number): Promise<ArtifactId[]> {
    const results: ArtifactId[] = [];
    for (const key of this.store.keys()) {
      const match = /^taskSpec:(\d+):(.+)$/.exec(key);
      if (match) {
        const p = Number(match[1]);
        if (phase === undefined || p === phase) {
          results.push({ kind: "taskSpec", phase: p, taskId: match[2]! });
        }
      }
    }
    return results;
  }

  async listPhases(): Promise<number[]> {
    const phases = new Set<number>();
    for (const key of this.store.keys()) {
      const match = /^phaseFile:(\d+):/.exec(key);
      if (match) {
        phases.add(Number(match[1]));
      }
    }
    return [...phases].sort((a, b) => a - b);
  }

  async hasPhaseTaskSpecs(phase: number): Promise<boolean> {
    for (const key of this.store.keys()) {
      if (key.startsWith(`taskSpec:${phase}:`)) {
        return true;
      }
    }
    return false;
  }

  async ensureDirectories(): Promise<void> {
    // no-op for in-memory store
  }

  async readWorkspaceFile(relativePath: string): Promise<string | undefined> {
    return this.workspaceFiles.get(relativePath);
  }

  async writeWorkspaceFile(relativePath: string, content: string): Promise<void> {
    this.workspaceFiles.set(relativePath, content);
  }

  seedWorkspaceFile(relativePath: string, content: string): this {
    this.workspaceFiles.set(relativePath, content);
    return this;
  }
}
