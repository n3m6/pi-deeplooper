// Wave planner — groups independent tasks into parallel waves.
// No node:* or pi imports.

export interface TaskSpec {
  taskId: string;
  dependencies: string[];
}

export function buildWaves<T extends TaskSpec>(tasks: T[]): T[][] {
  const remaining = new Map(tasks.map((t) => [t.taskId, t]));
  const completed = new Set<string>();
  const waves: T[][] = [];

  while (remaining.size > 0) {
    const wave = [...remaining.values()].filter((t) => t.dependencies.every((dep) => completed.has(dep)));
    if (wave.length === 0) {
      // Circular or unresolvable deps — dump remaining in one wave, sorted for determinism
      waves.push([...remaining.values()].sort((a, b) => a.taskId.localeCompare(b.taskId)));
      break;
    }
    wave.sort((a, b) => a.taskId.localeCompare(b.taskId));
    waves.push(wave);
    for (const t of wave) {
      completed.add(t.taskId);
      remaining.delete(t.taskId);
    }
  }

  return waves;
}
