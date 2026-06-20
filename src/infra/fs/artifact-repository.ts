import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ArtifactId, ArtifactRepository } from "../../application/port/index.js";

// ---------------------------------------------------------------------------
// RunArtifacts — infrastructure-internal path bag (not part of the application port).
// ---------------------------------------------------------------------------

export interface RunArtifacts {
  workspaceRoot: string;
  runDir: string;
  telemetryDir: string;
  reviewsDir: string;
  feedbackDir: string;
  phasesDir: string;
  researchDir: string;
  stateFile: string;
  requirementsFile: string;
  goalsFile: string;
  configFile: string;
  researchSummaryFile: string;
  researchQuestionsFile: string;
  researchOpenQuestionsFile: string;
  designFile: string;
  structureFile: string;
  sliceQueueFile: string;
  lessonsFile: string;
  specHistoryFile: string;
  skeletonTaskFile: string;
  skeletonResultsFile: string;
  globalAcceptanceResultsFile: string;
  baselineResultsFile: string;
  stage9SummaryFile: string;
  stage10SummaryFile: string;
  eventsFile: string;
  runLogFile: string;
  metricsFile: string;
}

// ---------------------------------------------------------------------------
// Path layout — builds the RunArtifacts bag for a given run.
// ---------------------------------------------------------------------------

export function getRunArtifacts(workspaceRoot: string, runId: string): RunArtifacts {
  const runDir = path.join(workspaceRoot, ".pipeline", runId);
  const telemetryDir = path.join(runDir, "telemetry");
  const reviewsDir = path.join(runDir, "reviews");
  const feedbackDir = path.join(runDir, "feedback");
  const phasesDir = path.join(runDir, "phases");
  const researchDir = path.join(runDir, "research");

  return {
    workspaceRoot,
    runDir,
    telemetryDir,
    reviewsDir,
    feedbackDir,
    phasesDir,
    researchDir,
    stateFile: path.join(runDir, "state.json"),
    requirementsFile: path.join(runDir, "requirements.md"),
    goalsFile: path.join(runDir, "goals.md"),
    configFile: path.join(runDir, "config.md"),
    researchSummaryFile: path.join(researchDir, "summary.md"),
    researchQuestionsFile: path.join(runDir, "questions.md"),
    researchOpenQuestionsFile: path.join(researchDir, "open-questions.md"),
    designFile: path.join(runDir, "design.md"),
    structureFile: path.join(runDir, "structure.md"),
    sliceQueueFile: path.join(runDir, "slice-queue.md"),
    lessonsFile: path.join(runDir, "lessons.md"),
    specHistoryFile: path.join(runDir, "spec-history.md"),
    skeletonTaskFile: path.join(runDir, "skeleton-task.md"),
    skeletonResultsFile: path.join(runDir, "skeleton-results.md"),
    globalAcceptanceResultsFile: path.join(runDir, "global-acceptance-results.md"),
    baselineResultsFile: path.join(runDir, "baseline-results.md"),
    stage9SummaryFile: path.join(runDir, "stage9-summary.md"),
    stage10SummaryFile: path.join(runDir, "stage10-summary.md"),
    eventsFile: path.join(telemetryDir, "events.jsonl"),
    runLogFile: path.join(telemetryDir, "run-log.md"),
    metricsFile: path.join(telemetryDir, "metrics-summary.md"),
  };
}

export async function ensureRunDirectories(artifacts: RunArtifacts): Promise<void> {
  await Promise.all([
    mkdir(artifacts.runDir, { recursive: true }),
    mkdir(artifacts.telemetryDir, { recursive: true }),
    mkdir(artifacts.reviewsDir, { recursive: true }),
    mkdir(artifacts.feedbackDir, { recursive: true }),
    mkdir(artifacts.phasesDir, { recursive: true }),
    mkdir(path.join(artifacts.researchDir, "iterations"), { recursive: true }),
  ]);
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// FileSystemArtifactRepository — implements ArtifactRepository using the FS.
// ---------------------------------------------------------------------------

export class FileSystemArtifactRepository implements ArtifactRepository {
  private readonly _paths: RunArtifacts;

  private constructor(paths: RunArtifacts) {
    this._paths = paths;
  }

  static create(workspaceRoot: string, runId: string): FileSystemArtifactRepository {
    return new FileSystemArtifactRepository(getRunArtifacts(workspaceRoot, runId));
  }

  static fromPaths(paths: RunArtifacts): FileSystemArtifactRepository {
    return new FileSystemArtifactRepository(paths);
  }

  resolvePath(id: ArtifactId): string {
    const p = this._paths;
    switch (id.kind) {
      case "requirements":
        return p.requirementsFile;
      case "goals":
        return p.goalsFile;
      case "config":
        return p.configFile;
      case "questions":
        return p.researchQuestionsFile;
      case "researchSummary":
        return p.researchSummaryFile;
      case "researchOpenQuestions":
        return p.researchOpenQuestionsFile;
      case "design":
        return p.designFile;
      case "structure":
        return p.structureFile;
      case "sliceQueue":
        return p.sliceQueueFile;
      case "lessons":
        return p.lessonsFile;
      case "specHistory":
        return p.specHistoryFile;
      case "skeletonTask":
        return p.skeletonTaskFile;
      case "skeletonResults":
        return p.skeletonResultsFile;
      case "baselineResults":
        return p.baselineResultsFile;
      case "globalAcceptanceResults":
        return p.globalAcceptanceResultsFile;
      case "stage9Summary":
        return p.stage9SummaryFile;
      case "stage10Summary":
        return p.stage10SummaryFile;
      case "taskSpec":
        return path.join(p.phasesDir, `phase-${String(id.phase).padStart(2, "0")}`, "tasks", `task-${id.taskId}.md`);
      case "phaseFile":
        return path.join(p.phasesDir, `phase-${String(id.phase).padStart(2, "0")}`, id.name);
      case "reviewFile":
        return path.join(p.reviewsDir, id.name);
      case "feedbackFile":
        return path.join(p.feedbackDir, id.name);
      case "researchFile":
        return path.join(p.researchDir, id.name);
      case "runFile":
        return path.join(p.runDir, id.name);
    }
  }

  relPath(id: ArtifactId): string {
    return path.relative(this._paths.runDir, this.resolvePath(id));
  }

  async read(id: ArtifactId): Promise<string | undefined> {
    try {
      return await readFile(this.resolvePath(id), "utf8");
    } catch {
      return undefined;
    }
  }

  async write(id: ArtifactId, content: string): Promise<void> {
    const filePath = this.resolvePath(id);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${content.trimEnd()}\n`, "utf8");
  }

  async exists(id: ArtifactId): Promise<boolean> {
    return fileExists(this.resolvePath(id));
  }

  async listTaskSpecs(phase: number): Promise<ArtifactId[]> {
    const dir = path.join(this._paths.phasesDir, `phase-${String(phase).padStart(2, "0")}`, "tasks");
    const files = await listMdFiles(dir);
    return files.flatMap((file) => {
      const match = path.basename(file).match(/^task-(\d+)\.md$/i);
      if (!match || !match[1]) {
        return [];
      }
      return [{ kind: "taskSpec" as const, phase, taskId: match[1] }];
    });
  }

  async listPhases(): Promise<number[]> {
    try {
      const entries = await readdir(this._paths.phasesDir);
      return entries
        .filter((entry) => /^phase-\d+$/i.test(entry))
        .map((entry) => parseInt(entry.replace(/^phase-0*/, ""), 10))
        .filter((n) => !isNaN(n))
        .sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  async ensureDirectories(): Promise<void> {
    const dirs = [
      this._paths.runDir,
      this._paths.telemetryDir,
      this._paths.reviewsDir,
      this._paths.feedbackDir,
      this._paths.phasesDir,
      this._paths.researchDir,
    ];
    for (const dir of dirs) {
      await mkdir(dir, { recursive: true });
    }
  }

  async readWorkspaceFile(relativePath: string): Promise<string | undefined> {
    try {
      return await readFile(path.join(this._paths.workspaceRoot, relativePath), "utf8");
    } catch {
      return undefined;
    }
  }

  async writeWorkspaceFile(relativePath: string, content: string): Promise<void> {
    const targetPath = path.join(this._paths.workspaceRoot, relativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, "utf8");
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

async function listMdFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((entry) => entry.endsWith(".md")).map((entry) => path.join(dir, entry));
  } catch {
    return [];
  }
}
