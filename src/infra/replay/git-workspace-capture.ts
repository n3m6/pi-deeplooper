/**
 * Git-backed WorkspaceCapture for the record/replay harness.
 *
 * The RecordingDispatcher needs to know which files a dispatch wrote so it can store them
 * in the cassette. This adapter implements that two-phase capture with git plumbing:
 * snapshot the working tree before the dispatch, then diff against it afterwards.
 *
 * It deliberately lives outside the composition root (src/index.ts): index.ts only decides
 * *whether* to record, while the "how" — the git mechanics — is isolated here.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { WrittenFile } from "./cassette.js";
import type { WorkspaceCapture } from "./recording-dispatcher.js";

/** Upper bound on every git subprocess so a wedged repo can never stall a recording run. */
const GIT_EXEC_TIMEOUT_MS = 30_000;

/**
 * Builds a WorkspaceCapture that snapshots and diffs the working tree using git tree objects.
 * Each capture call stages, inspects, then unstages so the caller's index is left untouched.
 */
export function createGitWorkspaceCapture(pi: ExtensionAPI): WorkspaceCapture {
  // Run a git subcommand inside `cwd` under the shared timeout.
  const git = (cwd: string, args: string[]) =>
    pi.exec("git", ["-C", cwd, ...args], { cwd, timeout: GIT_EXEC_TIMEOUT_MS });

  return {
    async snapshot(cwd) {
      // Stage everything, materialise a tree object as the opaque handle, then unstage so the
      // dispatch runs against a clean index.
      await git(cwd, ["add", "-A"]);
      const result = await git(cwd, ["write-tree"]);
      await git(cwd, ["reset"]);
      return result.stdout.trim();
    },

    async diff(cwd, handle) {
      if (!handle) return { files: [], patch: "" };
      const { readFile } = await import("node:fs/promises");

      // Re-stage the dispatch's changes, compare them to the pre-dispatch tree, then unstage.
      await git(cwd, ["add", "-A"]);
      const nameResult = await git(cwd, ["diff", "--cached", handle, "--name-only", "--diff-filter=AM"]);
      const patchResult = await git(cwd, ["diff", "--cached", handle]);
      await git(cwd, ["reset"]);

      // --diff-filter=AM limits the list to Added/Modified paths; read each one's content.
      const relPaths = nameResult.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const files: WrittenFile[] = [];
      for (const relPath of relPaths) {
        try {
          const content = await readFile(`${cwd}/${relPath}`, "utf8");
          files.push({ path: relPath, content });
        } catch {
          // Unreadable (e.g. removed between diff and read) — skip rather than fail the run.
        }
      }
      return { files, patch: patchResult.stdout };
    },
  };
}
