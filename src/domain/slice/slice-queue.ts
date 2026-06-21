/**
 * SliceQueue aggregate — pure domain object, no I/O.
 * Owns the slice-queue.md state: parse, serialize, status mutations, and selection.
 * No node:* or pi imports.
 *
 * Design → queue contract:
 *   1. Prefer the validated ## Slice Manifest JSON block from design.md (parseSliceManifest).
 *   2. Fall back to the tolerant heading parser (parseDesignSlices) which accepts prose headings.
 *   3. Callers (slice-loop.ts) must detect zero-result parses on non-empty designs and FAIL loudly.
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
   * Reopen a done or escalated slice (sets status back to "ready") when a downstream
   * stage proves its criterion still fails. Preserves all other fields including history.
   */
  reopen(sliceId: string, reason: string): SliceQueue {
    return this.mutate(sliceId, (s) => ({
      ...s,
      status: "ready",
      lastReason: reason,
    }));
  }

  /**
   * Find an existing done or escalated slice that "owns" a given acceptance criterion
   * (i.e., the criterion appears verbatim in the slice's acceptanceCriteria array).
   * Returns undefined when no existing slice owns the criterion.
   */
  findSliceOwningCriterion(criterion: string): Slice | undefined {
    return this._slices.find(
      (s) =>
        (s.status === "done" || s.status === "escalated") &&
        s.acceptanceCriteria.some((ac) => ac.trim() === criterion.trim()),
    );
  }

  /**
   * Process proposed remediation entries from dl-reflector: for each entry, if an
   * existing done/escalated slice owns all of its acceptance criteria, reopen that slice
   * instead of appending a new R-NNN. Only append genuinely new R-NNN slices.
   *
   * Returns `{ queue, reopened, added }` so callers can record telemetry.
   */
  applyRemediationWithReopen(proposedEntries: Array<{ id: string; title: string; acceptanceCriteria: string[] }>): {
    queue: SliceQueue;
    reopened: string[];
    added: string[];
  } {
    return applyRemediationWithReopenHelper(this, proposedEntries);
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
    return this.addRemediationSlices(parseRemediationEntriesFromMarkdown(block));
  }

  /**
   * Like `addRemediationSlicesFromMarkdown` but first attempts to reopen existing
   * done/escalated slices that already own the failing criteria, appending fresh
   * R-NNN entries only for genuinely uncovered criteria.
   */
  applyRemediationFromMarkdown(block: string): { queue: SliceQueue; reopened: string[]; added: string[] } {
    const entries = parseRemediationEntriesFromMarkdown(block);
    return this.applyRemediationWithReopen(entries);
  }

  /**
   * Build an initial queue from the design.md.
   *
   * Priority order:
   *   1. ## Slice Manifest JSON block — machine-readable, typebox-validated.
   *   2. ## Vertical Slices prose headings — tolerant fallback parser that derives synthetic
   *      ids (S1, S2…) from document order when headings contain spaces.
   *
   * Returns an empty queue only when the design genuinely has no slices section.
   * Callers (slice-loop.ts) are responsible for detecting the "section exists but empty"
   * case and failing loudly with a pipeline.anomaly event.
   */
  static buildInitial(designMd: string, _skeletonResultsMd?: string): SliceQueue {
    const slices = parseDesignSlicesFromManifestOrHeadings(designMd);
    return new SliceQueue(slices);
  }

  /**
   * Reconcile the queue after a Design/Goals escalation: rebuild from the new design
   * document but preserve any slices that are already "done" — unless their criterion
   * is in the provided `failingCriteria` set (meaning a downstream stage proved the
   * slice is not actually done).
   *
   * Slices not in the new design are dropped (unless done and not failing).
   * New slices from the design are added as "pending".
   */
  reconcile(newDesignMd: string, options: { preserveDone: boolean; failingCriteria?: Set<string> }): SliceQueue {
    const newSlices = parseDesignSlicesFromManifestOrHeadings(newDesignMd);

    const doneSlices = options.preserveDone
      ? this._slices.filter((s) => {
          if (s.status !== "done") return false;
          // Do not preserve if any of the slice's criteria are in the failing set.
          if (options.failingCriteria && options.failingCriteria.size > 0) {
            const ownsFailingCriterion = s.acceptanceCriteria.some((ac) =>
              (options.failingCriteria as Set<string>).has(ac.trim()),
            );
            if (ownsFailingCriterion) return false;
          }
          return true;
        })
      : [];

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

// ---------------------------------------------------------------------------
// applyRemediationWithReopen — implemented as a free function to avoid `this` aliasing
// ---------------------------------------------------------------------------

function applyRemediationWithReopenHelper(
  queue: SliceQueue,
  proposedEntries: Array<{ id: string; title: string; acceptanceCriteria: string[] }>,
): { queue: SliceQueue; reopened: string[]; added: string[] } {
  let current = queue;
  const reopened: string[] = [];
  const toAdd: Array<{ id: string; title: string; acceptanceCriteria: string[] }> = [];

  for (const entry of proposedEntries) {
    // Find an existing slice that owns every criterion in this entry.
    const ownedBy = entry.acceptanceCriteria.every((ac) => current.findSliceOwningCriterion(ac) !== undefined)
      ? current.findSliceOwningCriterion(entry.acceptanceCriteria[0] ?? "")
      : undefined;

    if (ownedBy) {
      current = current.reopen(
        ownedBy.id,
        `Reopened: downstream stage proved criterion still fails. Proposed remediation: ${entry.title}`,
      );
      reopened.push(ownedBy.id);
    } else {
      toAdd.push(entry);
    }
  }

  if (toAdd.length > 0) {
    current = current.addRemediationSlices(toAdd);
  }

  const added = toAdd.map((e) => e.id);
  return { queue: current, reopened, added };
}

// ---------------------------------------------------------------------------
// Remediation markdown parser (shared by addRemediationSlicesFromMarkdown + applyRemediationFromMarkdown)
// ---------------------------------------------------------------------------

function parseRemediationEntriesFromMarkdown(
  block: string,
): Array<{ id: string; title: string; acceptanceCriteria: string[] }> {
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
  return criteria;
}

/**
 * Manifest-first strategy: try the ## Slice Manifest JSON block, fall back to the
 * tolerant prose heading parser. Returns [] only when both sources yield nothing.
 */
function parseDesignSlicesFromManifestOrHeadings(designMd: string): Slice[] {
  // --- Try manifest first ---
  const manifestResult = tryParseSliceManifest(designMd);
  if (manifestResult !== null) {
    return manifestResult;
  }

  // --- Fall back to tolerant prose heading parse ---
  return parseDesignSlicesTolerant(designMd);
}

/**
 * Attempt to parse the ## Slice Manifest JSON block.
 * Returns null when the section is absent (no error — just no manifest).
 * Returns [] when the section is present but JSON is malformed (signals an anomaly to callers).
 * Returns the slice array on success.
 */
function tryParseSliceManifest(designMd: string): Slice[] | null {
  const topSections = designMd.split(/^## /m);
  const manifestSection = topSections.find((s) => s.match(/^Slice Manifest\b/));
  if (!manifestSection) {
    return null;
  }

  const jsonMatch = manifestSection.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!jsonMatch?.[1]) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[1]);
  } catch {
    return [];
  }

  if (!isSliceManifestShape(parsed)) {
    return [];
  }

  const manifest = parsed as { slices: Array<Record<string, unknown>> };
  const slices: Slice[] = [];
  let phaseNum = 1;

  for (const entry of manifest.slices) {
    const id = typeof entry["id"] === "string" ? entry["id"].trim() : "";
    const title = typeof entry["title"] === "string" ? entry["title"].trim() : id;
    if (!id) continue;

    const deps = Array.isArray(entry["deps"])
      ? (entry["deps"] as unknown[]).filter((d): d is string => typeof d === "string")
      : [];
    const ac = Array.isArray(entry["acceptanceCriteria"])
      ? (entry["acceptanceCriteria"] as unknown[]).filter((c): c is string => typeof c === "string")
      : [];

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

function isSliceManifestShape(value: unknown): value is { slices: unknown[] } {
  if (typeof value !== "object" || value === null) return false;
  return Array.isArray((value as Record<string, unknown>)["slices"]);
}

/**
 * Tolerant prose heading parser — accepts any `### <anything>: <title>` heading.
 * When the id token contains spaces (e.g. `### Slice 1: Name`), derives a synthetic
 * id `S<N>` from document order and uses the full heading text as the title.
 */
function parseDesignSlicesTolerant(designMd: string): Slice[] {
  const topLevelSections = designMd.split(/^## /m);
  const vsRaw = topLevelSections.find((s) => s.match(/^Vertical Slices/));
  if (!vsRaw) {
    return [];
  }
  const slicesSection = vsRaw.replace(/^[^\n]+\n/, "");
  const sliceBlocks = slicesSection.split(/^###\s+/m).slice(1);
  const slices: Slice[] = [];
  let phaseNum = 1;

  for (const block of sliceBlocks) {
    const headerLine = (block.split("\n")[0] ?? "").trim();
    if (!headerLine) continue;

    let id: string;
    let title: string;

    // Try strict no-space id first (original grammar).
    const strictMatch = headerLine.match(/^([A-Za-z0-9_-]+):\s*(.+)/);
    if (strictMatch) {
      id = (strictMatch[1] ?? "").trim();
      title = (strictMatch[2] ?? "").trim();
    } else {
      // Tolerant: use synthetic id from position, full heading as title.
      id = `S${phaseNum}`;
      // Keep everything before the first colon as part of the title if a colon exists.
      const colonIdx = headerLine.indexOf(":");
      title = colonIdx > 0 ? headerLine.slice(colonIdx + 1).trim() || headerLine : headerLine;
    }

    const body = block.slice(block.indexOf("\n") + 1);
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
