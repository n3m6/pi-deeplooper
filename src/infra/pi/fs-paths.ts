import { access } from "node:fs/promises";

/** Filters a list of file paths, returning only those that currently exist on disk. */
export async function existingPaths(paths: string[]): Promise<string[]> {
  const existing: string[] = [];
  for (const filePath of paths) {
    try {
      await access(filePath);
      existing.push(filePath);
    } catch {
      // Ignore missing optional extensions.
    }
  }
  return existing;
}
