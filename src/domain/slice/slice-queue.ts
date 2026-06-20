/**
 * SliceQueue aggregate — pure domain object, no I/O.
 * Owns the slice-queue.md state: parse, serialize, status mutations, and selection.
 * No node:* or pi imports.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SliceStatus = "pending" | "ready" | "building" | "done" | "blocked" | "escalated";

export interface Slice {
  id: string;
  title: string;
  /** Slice IDs that must be in "done" status before this slice can start. */
  deps: string[];
  status: SliceStatus;
  requeueCount: number;
  lastReason?: string;
  acceptanceCriteria: string[];
  /** Relative path to the phase directory for this slice's artifacts, e.g. "phases/phase-01". */
  phaseDir: string;
  /** Where this slice originated: "design" or "remediation". */
  source: "design" | "remediation";
}

// ---------------------------------------------------------------------------
// Slice Queue
// ---------------------------------------------------------------------------

export class SliceQueue {
  private _slices: Slice[];

  private constructor(slices: Slice[]) {
    this._slices = slices;
  }

  // ---------------------------------------------------------------------------
  // Factory / serialization
  // ---------------------------------------------------------------------------

  static empty(): SliceQueue {
    return new SliceQueue([]);
  }

  /**
   * Parse a slice-queue.md markdown document into a SliceQueue.
   * Format: each slice is a `## <id>: <title>` section with YAML-ish key-value lines.
   */
  static parse(md: string): SliceQueue {
    const slices: Slice[] = [];
    const sections = md.split(/^## /m).slice(1);

    for (const section of sections) {
      const lines = section.split("\n");
      const headerLine = lines[0] ?? "";
      const headerMatch = headerLine.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
      if (!headerMatch) {
        continue;
      }
      const id = (headerMatch[1] ?? "").trim();
      const title = (headerMatch[2] ?? "").trim();
      const body = lines.slice(1).join("\n");
      const lastReason = parseOptionalField(body, "last_reason");

      const slice: Slice = {
        id,
        title,
        deps: parseListField(body, "deps"),
        status: parseStringField(body, "status", "pending") as SliceStatus,
        requeueCount: parseInt(parseStringField(body, "requeue_count", "0"), 10),
        ...(lastReason !== undefined ? { lastReason } : {}),
        acceptanceCriteria: parseListField(body, "acceptance_criteria"),
        phaseDir: parseStringField(body, "phase_dir", `phases/phase-${String(slices.length + 1).padStart(2, "0")}`),
        source: parseStringField(body, "source", "design") === "remediation" ? "remediation" : "design",
      };
      slices.push(slice);
    }

    return new SliceQueue(slices);
  }

  serialize(): string {
    if (this._slices.length === 0) {
      return "# Slice Queue\n\n(empty)\n";
    }

    const sections = this._slices.map((s) => {
      const lines = [
        `## ${s.id}: ${s.title}`,
        `status: ${s.status}`,
        `deps: ${s.deps.length === 0 ? "none" : s.deps.join(", ")}`,
        `requeue_count: ${s.requeueCount}`,
        s.lastReason ? `last_reason: ${s.lastReason}` : undefined,
        `phase_dir: ${s.phaseDir}`,
        `source: ${s.source}`,
        `acceptance_criteria:`,
        ...s.acceptanceCriteria.map((ac) => `  - ${ac}`),
      ].filter((l): l is string => l !== undefined);
      return lines.join("\n");
    });

    return `# Slice Queue\n\n${sections.join("\n\n")}\n`;
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  get slices(): readonly Slice[] {
    return this._slices;
  }

  get length(): number {
    return this._slices.length;
  }

  getById(id: string): Slice | undefined {
    return this._slices.find((s) => s.id === id);
  }

  /**
   * Selects the first ready slice whose deps are all done.
   * A slice transitions from "pending" to "ready" when its deps are satisfied.
   */
  selectNextReady(): Slice | undefined {
    const doneIds = new Set(this._slices.filter((s) => s.status === "done").map((s) => s.id));

    // First promote any pending slices whose deps are now all done.
    for (const s of this._slices) {
      if (s.status === "pending" && s.deps.every((dep) => doneIds.has(dep))) {
        s.status = "ready";
      }
    }

    return this._slices.find((s) => s.status === "ready");
  }

  isExhausted(): boolean {
    return this._slices.every((s) => s.status === "done" || s.status === "blocked" || s.status === "escalated");
  }

  phaseOf(sliceId: string): string | undefined {
    return this._slices.find((s) => s.id === sliceId)?.phaseDir;
  }

  // ---------------------------------------------------------------------------
  // Status mutations (return a new SliceQueue; keep aggregate immutable at call sites)
  // ---------------------------------------------------------------------------

  markBuilding(sliceId: string): SliceQueue {
    return this.mutate(sliceId, (s) => ({ ...s, status: "building" }));
  }

  markDone(sliceId: string): SliceQueue {
    return this.mutate(sliceId, (s) => ({ ...s, status: "done", requeueCount: s.requeueCount }));
  }

  requeue(sliceId: string, reason: string): SliceQueue {
    return this.mutate(sliceId, (s) => ({
      ...s,
      status: "ready",
      requeueCount: s.requeueCount + 1,
      lastReason: reason,
    }));
  }

  escalate(sliceId: string, reason: string): SliceQueue {
    return this.mutate(sliceId, (s) => ({
      ...s,
      status: "escalated",
      lastReason: reason,
    }));
  }

  markBlocked(sliceId: string, reason: string): SliceQueue {
    return this.mutate(sliceId, (s) => ({
      ...s,
      status: "blocked",
      lastReason: reason,
    }));
  }

  /**
   * Append remediation slices from verify/accept red criteria.
   * Remediation slices get IDs in the form R-NNN, are source="remediation",
   * have no deps (they can run independently), and their phaseDir is computed
   * from the next available phase number.
   */
  addRemediationSlices(criteria: Array<{ id: string; title: string; acceptanceCriteria: string[] }>): SliceQueue {
    const existingPhaseNums = this._slices
      .map((s) => {
        const m = s.phaseDir.match(/phase-(\d+)$/);
        return m ? parseInt(m[1] ?? "0", 10) : 0;
      })
      .filter((n) => !isNaN(n));
    let nextPhase = (existingPhaseNums.length > 0 ? Math.max(...existingPhaseNums) : 0) + 1;

    const newSlices: Slice[] = criteria.map((c) => ({
      id: c.id,
      title: c.title,
      deps: [],
      status: "ready",
      requeueCount: 0,
      acceptanceCriteria: c.acceptanceCriteria,
      phaseDir: `phases/phase-${String(nextPhase++).padStart(2, "0")}`,
      source: "remediation" as const,
    }));

    return new SliceQueue([...this._slices, ...newSlices]);
  }

  /**
   * Parse a reflector "Remediation Slices" markdown block and append them.
   * Expected format per remediation slice:
   *   ### R-NNN: Title
   *   acceptance_criteria:
   *     - criterion 1
   *     - criterion 2
   */
  addRemediationSlicesFromMarkdown(block: string): SliceQueue {
    const criteria: Array<{ id: string; title: string; acceptanceCriteria: string[] }> = [];
    const sections = block.split(/^### /m).slice(1);
    for (const section of sections) {
      const lines = section.split("\n");
      const header = lines[0] ?? "";
      const headerMatch = header.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
      if (!headerMatch) continue;
      const id = (headerMatch[1] ?? "").trim();
      const title = (headerMatch[2] ?? "").trim();
      const body = lines.slice(1).join("\n");
      const acceptanceCriteria = parseListField(body, "acceptance_criteria");
      criteria.push({ id, title, acceptanceCriteria });
    }
    return this.addRemediationSlices(criteria);
  }

  /**
   * Build an initial queue from the design.md (Vertical Slices section) and
   * skeleton-results.md (slice-0 outcome).
   * Expected design.md format:
   *   ## Vertical Slices
   *   ### <id>: <title>
   *   - deps: <dep1>, <dep2> | none
   *   - acceptance_criteria: <list>
   */
  static buildInitial(designMd: string, _skeletonResultsMd?: string): SliceQueue {
    const slices = parseDesignSlices(designMd);
    return new SliceQueue(slices);
  }

  /**
   * Reconcile the queue after a Design/Goals escalation: rebuild from the new design
   * document but preserve any slices that are already "done".
   * Slices not in the new design are dropped (unless done).
   * New slices from the design are added as "pending".
   */
  reconcile(newDesignMd: string, options: { preserveDone: boolean }): SliceQueue {
    const newSlices = parseDesignSlices(newDesignMd);
    const doneSlices = options.preserveDone ? this._slices.filter((s) => s.status === "done") : [];

    const doneIds = new Set(doneSlices.map((s) => s.id));

    // Keep done slices; add new slices that are not already done.
    const merged: Slice[] = [...doneSlices, ...newSlices.filter((s) => !doneIds.has(s.id))];

    return new SliceQueue(merged);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private mutate(sliceId: string, fn: (s: Slice) => Slice): SliceQueue {
    return new SliceQueue(this._slices.map((s) => (s.id === sliceId ? fn(s) : s)));
  }
}

// ---------------------------------------------------------------------------
// Parsing helpers (private to module)
// ---------------------------------------------------------------------------

function parseListField(body: string, key: string): string[] {
  // Use `[ \t]*` not `\s*` to avoid matching across newlines.
  const lineMatch = body.match(new RegExp(`^${key}:[ \\t]*([^\\n]+)$`, "m"));
  if (!lineMatch || !lineMatch[1]) {
    // Try multiline list format:  key:\n  - item\n  - item
    const listMatch = body.match(new RegExp(`^${key}:[ \\t]*\\n((?:[ \\t]+-[^\\n]+\\n?)*)`, "m"));
    if (!listMatch || !listMatch[1]) {
      return [];
    }
    return listMatch[1]
      .split("\n")
      .map((l) => l.replace(/^[ \t]*-[ \t]*/, "").trim())
      .filter(Boolean);
  }
  const value = lineMatch[1].trim();
  if (value === "none" || value === "") {
    return [];
  }
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function parseStringField(body: string, key: string, defaultValue: string): string {
  const match = body.match(new RegExp(`^${key}:[ \\t]*([^\\n]+)$`, "m"));
  return match?.[1]?.trim() ?? defaultValue;
}

function parseOptionalField(body: string, key: string): string | undefined {
  const match = body.match(new RegExp(`^${key}:[ \\t]*([^\\n]+)$`, "m"));
  return match?.[1]?.trim();
}

/**
 * Parse the `## Vertical Slices` section of a design.md into a list of Slices.
 */
function parseDesignSlices(designMd: string): Slice[] {
  // Split by top-level `## ` headers and find the "Vertical Slices" section.
  const topLevelSections = designMd.split(/^## /m);
  const vsRaw = topLevelSections.find((s) => s.match(/^Vertical Slices/));
  if (!vsRaw) {
    return [];
  }
  // Remove the header line itself, keep the body.
  const slicesSection = vsRaw.replace(/^[^\n]+\n/, "");
  const sliceBlocks = slicesSection.split(/^###\s+/m).slice(1);
  const slices: Slice[] = [];
  let phaseNum = 1;

  for (const block of sliceBlocks) {
    const headerMatch = block.match(/^([A-Za-z0-9_-]+):\s*(.+)/);
    if (!headerMatch) {
      continue;
    }
    const id = (headerMatch[1] ?? "").trim();
    const title = (headerMatch[2] ?? "").trim();
    const body = block.slice(headerMatch[0].length);

    const deps = parseListField(body, "deps");
    const ac = parseListField(body, "acceptance_criteria");

    slices.push({
      id,
      title,
      deps,
      status: "pending",
      requeueCount: 0,
      acceptanceCriteria: ac,
      phaseDir: `phases/phase-${String(phaseNum++).padStart(2, "0")}`,
      source: "design",
    });
  }

  return slices;
}
