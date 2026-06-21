/**
 * SliceLoop stage — the monolithic slice execution engine.
 *
 * Inner loop per slice:
 *   1. dl-slice-planner → writes task specs in phaseDir/tasks/
 *   2. dl-feasibility-checker (read-only) → controller writes feasibility-results.md
 *   3. runSliceImplementation (worktree/fast-impl/squash)
 *   4. dl-done-checker
 *   5. dl-reflector (slice-success: appends lessons.md + spec-history.md, may amend goals.md)
 *
 * On FAIL at any sub-step:
 *   - requeue_count <= MAX_REQUEUE → requeue (LOCAL_SLICE requeue via Run.requeueSlice)
 *   - requeue_count > MAX_REQUEUE → escalate (return backwardLoop=LOOP_DESIGN/LOOP_GOALS)
 *
 * Escalation from integration checker or backward-loop-detector:
 *   - LOOP_DESIGN/LOOP_GOALS → returned as backwardLoop to the pipeline loop.
 *
 * On queue exhausted → return PASS (pipeline loop routes to verify).
 * When pendingReconcile is set → reconcile the queue from the new design.md first.
 */

import { SliceQueue } from "../../domain/slice/slice-queue.js";
import { Run, MAX_REQUEUE } from "../../domain/run/index.js";
import { designDeclaresSlices, parseMarkdownSections, parseReviewStatus } from "../../infra/codec/markdown-codec.js";
import type { BackwardLoopRequest, StageModule, StageOutcome, StageRuntime } from "../port/index.js";
import { runSliceImplementation } from "./implement.js";
import { appendReflectorSection, dispatchLeaf, recordAnomaly, safeReadArtifact, writeArtifact } from "./utils.js";

const REQUEUE_CAP = MAX_REQUEUE;

// Mutable context threaded through slice-step helpers.
interface SliceLoopCtx {
  runtime: StageRuntime;
  queue: SliceQueue;
  run: Run;
  filesWritten: string[];
}

export const sliceLoopStage: StageModule = {
  stage: "slice-loop",
  async run(runtime: StageRuntime): Promise<StageOutcome> {
    const repo = runtime.services.artifactRepo;
    const sink = runtime.services.telemetrySink;
    const signal = runtime.services.eventContext.signal;
    const state = runtime.state;

    // -----------------------------------------------------------------------
    // Load or build the slice queue
    // -----------------------------------------------------------------------
    let queue: SliceQueue;
    const existingQueueMd = await repo.read({ kind: "sliceQueue" });

    if (existingQueueMd) {
      queue = SliceQueue.parse(existingQueueMd);

      // Reconcile if returning from a Design/Goals escalation.
      if (state.pendingReconcile) {
        const newDesignMd = await safeReadArtifact(runtime, { kind: "design" });
        queue = queue.reconcile(newDesignMd, { preserveDone: true });
        // Persist reconciled queue.
        await writeArtifact(runtime, { kind: "sliceQueue" }, queue.serialize());

        // Clear the pending-reconcile flag in the run aggregate.
        const reconcileRun = Run.rehydrate(state);
        reconcileRun.setPendingReconcile(false);
        await runtime.services.stateRepo.save(reconcileRun);
      }
    } else {
      // First entry: build the queue from design.md + skeleton-results.md.
      const designMd = await safeReadArtifact(runtime, { kind: "design" });
      const skeletonResultsMd = await safeReadArtifact(runtime, { kind: "skeletonResults" });
      queue = SliceQueue.buildInitial(designMd, skeletonResultsMd);
      await writeArtifact(runtime, { kind: "sliceQueue" }, queue.serialize());

      // Loud-fail: design declares slices but none could be parsed.
      if (queue.length === 0 && designDeclaresSlices(designMd)) {
        await recordAnomaly(
          runtime,
          "design-slices-unparsed",
          "error",
          "design.md declares a ## Slice Manifest or ## Vertical Slices section but no slices could be parsed — check the manifest JSON and slice heading format.",
          { designLength: designMd.length },
        );
        return {
          status: "FAIL",
          filesWritten: ["slice-queue.md"],
          summary:
            "design-slices-unparsed: design declares slices but none could be parsed from ## Slice Manifest or ## Vertical Slices.",
          backwardLoop: {
            classification: "LOOP_DESIGN",
            summary: "Design slice manifest could not be parsed; design needs revision.",
          },
        };
      }
    }

    const filesWritten: string[] = ["slice-queue.md"];
    const ctx: SliceLoopCtx = { runtime, queue, run: Run.rehydrate(state), filesWritten };

    // -----------------------------------------------------------------------
    // Main slice execution loop
    // -----------------------------------------------------------------------
    while (true) {
      const slice = ctx.queue.selectNextReady();
      if (!slice) {
        break;
      }

      // Mark building in both queue and run state.
      ctx.queue = ctx.queue.markBuilding(slice.id);
      ctx.run.markSliceBuilding(slice.id);
      await writeArtifact(runtime, { kind: "sliceQueue" }, ctx.queue.serialize());
      await runtime.services.stateRepo.save(ctx.run);

      await sink.record({
        type: "slice.started",
        route: state.route,
        sliceId: slice.id,
        sliceTitle: slice.title,
      });

      // Parse phase number from phaseDir (e.g. "phases/phase-01" → 1).
      const phaseMatch = slice.phaseDir.match(/phase-(\d+)$/);
      const phase = phaseMatch ? parseInt(phaseMatch[1] ?? "1", 10) : 1;

      // 1. dl-slice-planner — writes task specs.
      // (artifact-repository.write auto-creates parent directories on first write)
      const sliceOutcome = await runSlicePlan(
        runtime,
        phase,
        slice.id,
        slice.title,
        slice.acceptanceCriteria,
        slice.phaseDir,
        runtime.state.requeueCounts[slice.id] ?? 0,
        slice.lastReason,
      );
      if (sliceOutcome.type === "escalate") {
        return escalateSlice(ctx, slice.id, sliceOutcome.reason, {
          classification: sliceOutcome.classification ?? "LOOP_DESIGN",
          summary: sliceOutcome.reason,
        });
      }
      if (sliceOutcome.type === "requeue") {
        const outcome = await requeueOrEscalate(ctx, slice.id, sliceOutcome.reason, {
          buildExhaustedSummary: (count) =>
            `Slice ${slice.id} escalated after ${count} requeue attempts: ${sliceOutcome.reason}`,
          requeueEvent: "decided",
        });
        if (outcome) return outcome;
        continue;
      }

      // 2. dl-feasibility-checker — read-only; controller writes feasibility-results.md.
      const feasibilityOutcome = await runFeasibilityCheck(runtime, phase, slice.id, slice.acceptanceCriteria);
      if (feasibilityOutcome.type === "requeue") {
        const outcome = await requeueOrEscalate(ctx, slice.id, feasibilityOutcome.reason, {
          buildExhaustedSummary: (count) =>
            `Slice ${slice.id} feasibility failed ${count} times: ${feasibilityOutcome.reason}`,
          requeueEvent: "requested",
        });
        if (outcome) return outcome;
        continue;
      }
      filesWritten.push(`${slice.phaseDir}/feasibility-results.md`);

      // 3. Run slice implementation (worktree + fast-impl + squash).
      const implOutcome = await runSliceImplementation(runtime, { phase, phaseDir: slice.phaseDir, sliceId: slice.id });
      filesWritten.push(...implOutcome.filesWritten);

      if (implOutcome.status === "FAIL") {
        // Check if implementation requested a backward loop.
        if (implOutcome.backwardLoop) {
          const classification = implOutcome.backwardLoop.classification;
          if (classification === "LOOP_DESIGN" || classification === "LOOP_GOALS") {
            // Escalate to pipeline level.
            return escalateSlice(ctx, slice.id, implOutcome.summary, implOutcome.backwardLoop);
          }
        }
        // LOCAL_SLICE or plain FAIL — requeue.
        const outcome = await requeueOrEscalate(ctx, slice.id, implOutcome.summary, {
          buildExhaustedSummary: (count) => `Slice ${slice.id} escalated after ${count} requeue attempts.`,
          requeueEvent: "requested",
        });
        if (outcome) return outcome;
        continue;
      }

      // 4. dl-done-checker.
      const doneCheck = await runDoneCheck(runtime, phase, slice.id, slice.acceptanceCriteria);
      filesWritten.push(`${slice.phaseDir}/done-check-results.md`);
      if (doneCheck.status === "FAIL") {
        const outcome = await requeueOrEscalate(ctx, slice.id, doneCheck.reason, {
          buildExhaustedSummary: (count) => `Slice ${slice.id} done-check failed ${count} times: ${doneCheck.reason}`,
          requeueEvent: "requested",
        });
        if (outcome) return outcome;
        continue;
      }

      // 4b. Controller-side evidence gate — must come before markDone.
      // Catches vacuous done-checks (0 tasks implemented) and red build/test scripts.
      const evidenceCheck = await assertSliceProducedEvidence(runtime, phase, slice.id);
      if (evidenceCheck.status === "FAIL") {
        const outcome = await requeueOrEscalate(ctx, slice.id, evidenceCheck.reason, {
          buildExhaustedSummary: (count) =>
            `Slice ${slice.id} evidence gate failed ${count} times: ${evidenceCheck.reason}`,
          requeueEvent: "requested",
        });
        if (outcome) return outcome;
        continue;
      }

      // 5. dl-reflector (slice-success) — append lessons.md, spec-history.md; may amend goals.md.
      await runSliceReflect(runtime, slice.id, slice.title, implOutcome.summary);
      filesWritten.push("lessons.md", "spec-history.md");

      // Mark done.
      ctx.queue = ctx.queue.markDone(slice.id);
      ctx.run.markSliceDone(slice.id);
      await writeArtifact(runtime, { kind: "sliceQueue" }, ctx.queue.serialize());
      await runtime.services.stateRepo.save(ctx.run);

      await sink.record({
        type: "slice.completed",
        route: state.route,
        sliceId: slice.id,
        sliceTitle: slice.title,
        status: "done",
      });

      // Checkpoint after each slice.
      await runtime.services.versionControl.checkpoint("slice-loop", "complete", signal);
    }

    // Queue exhausted — proceed to verify.
    return {
      status: "PASS",
      filesWritten,
      summary: `Slice queue exhausted. ${ctx.queue.slices.filter((s) => s.status === "done").length} slices completed.`,
    };
  },
};

// ---------------------------------------------------------------------------
// Slice lifecycle helpers
// ---------------------------------------------------------------------------

/**
 * Immediately escalates a slice (no cap check): persists queue + run state and returns the
 * FAIL outcome. Used when a sub-step signals LOOP_DESIGN or LOOP_GOALS directly.
 */
async function escalateSlice(
  ctx: SliceLoopCtx,
  sliceId: string,
  summary: string,
  backwardLoop: BackwardLoopRequest,
): Promise<StageOutcome> {
  ctx.queue = ctx.queue.escalate(sliceId, summary);
  ctx.run.escalateSlice(sliceId);
  await writeArtifact(ctx.runtime, { kind: "sliceQueue" }, ctx.queue.serialize());
  await ctx.runtime.services.stateRepo.save(ctx.run);

  // Consult dl-backward-loop-detector to set a precise classification on design/goals loops.
  let resolvedLoop = backwardLoop;
  if (backwardLoop.classification === "LOOP_DESIGN" || backwardLoop.classification === "LOOP_GOALS") {
    const detected = await classifyEscalationWithDetector(
      ctx.runtime,
      sliceId,
      backwardLoop.summary,
      ctx.run.state.requeueCounts[sliceId] ?? 0,
    );
    if (detected !== "NO_LOOP") {
      resolvedLoop = { ...backwardLoop, classification: detected };
    }
  }

  return { status: "FAIL", filesWritten: ctx.filesWritten, summary, backwardLoop: resolvedLoop };
}

/**
 * Checks the requeue cap. If exceeded, escalates to LOOP_DESIGN and returns the FAIL outcome.
 * Otherwise requeues and returns undefined — the caller must `continue` the slice loop.
 */
async function requeueOrEscalate(
  ctx: SliceLoopCtx,
  sliceId: string,
  reason: string,
  options: {
    buildExhaustedSummary: (requeueCount: number) => string;
    /** "decided" for plan-level requeues (no reason field); "requested" for step failures. */
    requeueEvent: "requested" | "decided";
  },
): Promise<StageOutcome | undefined> {
  const { runtime, run } = ctx;
  const sink = runtime.services.telemetrySink;
  const route = runtime.state.route;
  const requeueCount = (run.state.requeueCounts[sliceId] ?? 0) + 1;

  if (requeueCount > REQUEUE_CAP) {
    ctx.queue = ctx.queue.escalate(sliceId, reason);
    ctx.run.escalateSlice(sliceId);
    await writeArtifact(runtime, { kind: "sliceQueue" }, ctx.queue.serialize());
    await runtime.services.stateRepo.save(ctx.run);
    await sink.record({ type: "requeue.exhausted", route, sliceId, requeueCount });

    // Consult dl-backward-loop-detector to set a precise classification.
    const detectedClassification = await classifyEscalationWithDetector(runtime, sliceId, reason, requeueCount);
    const classification: "LOOP_DESIGN" | "LOOP_GOALS" =
      detectedClassification === "NO_LOOP" ? "LOOP_DESIGN" : detectedClassification;

    return {
      status: "FAIL",
      filesWritten: ctx.filesWritten,
      summary: options.buildExhaustedSummary(requeueCount),
      backwardLoop: { classification, summary: reason },
    };
  }

  ctx.queue = ctx.queue.requeue(sliceId, reason);
  run.requeueSlice(sliceId);
  await writeArtifact(runtime, { kind: "sliceQueue" }, ctx.queue.serialize());
  await runtime.services.stateRepo.save(run);

  if (options.requeueEvent === "decided") {
    await sink.record({ type: "requeue.decided", route, sliceId, requeueCount });
  } else {
    await sink.record({ type: "requeue.requested", route, sliceId, reason, requeueCount });
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Sub-step runners
// ---------------------------------------------------------------------------

type RequeueResult = { type: "requeue"; reason: string } | { type: "continue" };
type EscalateResult =
  | { type: "escalate"; reason: string; classification?: "LOOP_DESIGN" | "LOOP_GOALS" }
  | { type: "continue" };

async function runSlicePlan(
  runtime: StageRuntime,
  phase: number,
  sliceId: string,
  sliceTitle: string,
  acceptanceCriteria: string[],
  phaseDir: string,
  requeueCount: number,
  lastReason: string | undefined,
): Promise<RequeueResult | EscalateResult> {
  const goals = await safeReadArtifact(runtime, { kind: "goals" });
  const design = await safeReadArtifact(runtime, { kind: "design" });
  const structure = await safeReadArtifact(runtime, { kind: "structure" });

  // Build the cwd-relative path the agent should write to. The agent runs with
  // cwd = workspaceRoot, so prefix the run dir so writes land in the run's phases
  // tree — exactly where listTaskSpecs scans.
  const runRelativePhaseDir = `.pipeline/${runtime.state.runId}/${phaseDir}`;

  const result = await dispatchLeaf(
    runtime,
    "dl-slice-planner",
    [
      `=== RUN ID ===\n${runtime.state.runId}`,
      `=== SLICE ID ===\n${sliceId}`,
      `=== SLICE TITLE ===\n${sliceTitle}`,
      `=== PHASE DIR ===\n${runRelativePhaseDir}`,
      `=== ACCEPTANCE CRITERIA ===\n${acceptanceCriteria.join("\n")}`,
      `=== REQUEUE COUNT ===\n${requeueCount}`,
      `=== REQUEUE REASON ===\n${lastReason ?? "None."}`,
      `=== GOALS ===\n${goals}`,
      `=== DESIGN ===\n${design}`,
      `=== STRUCTURE ===\n${structure}`,
    ].join("\n\n"),
    { tools: ["read", "bash", "grep", "find", "ls", "write", "edit"] },
  );

  if (result.endReason === "aborted" || result.errorMessage) {
    return { type: "requeue", reason: `Slice planner failed: ${result.errorMessage ?? result.endReason}` };
  }

  // Check if planner output any FAIL signal.
  if (parseReviewStatus(result.text) === "FAIL") {
    const sections = parseMarkdownSections(result.text);
    const classification = classifyEscalation(sections["Escalation Target"] ?? "");
    return {
      type: "escalate",
      reason: sections["Summary"] ?? "Slice planner could not plan this slice.",
      classification,
    };
  }

  // Guard: verify planner actually wrote task specs before proceeding.
  const written = await runtime.services.artifactRepo.listTaskSpecs(phase);
  if (written.length === 0) {
    await recordAnomaly(
      runtime,
      "slice-plan-empty",
      "error",
      `dl-slice-planner returned PASS but wrote no task specs into ${runRelativePhaseDir}/tasks/.`,
      { sliceId, phase },
    );
    return { type: "requeue", reason: "Slice planner produced no task specs." };
  }

  return { type: "continue" };
}

async function runFeasibilityCheck(
  runtime: StageRuntime,
  phase: number,
  sliceId: string,
  acceptanceCriteria: string[],
): Promise<RequeueResult & { result?: string }> {
  const goals = await safeReadArtifact(runtime, { kind: "goals" });
  const design = await safeReadArtifact(runtime, { kind: "design" });

  const result = await dispatchLeaf(
    runtime,
    "dl-feasibility-checker",
    [
      `=== SLICE ID ===\n${sliceId}`,
      `=== PHASE ===\n${phase}`,
      `=== ACCEPTANCE CRITERIA ===\n${acceptanceCriteria.join("\n")}`,
      `=== GOALS ===\n${goals}`,
      `=== DESIGN ===\n${design}`,
    ].join("\n\n"),
  );

  // Controller writes feasibility-results.md (checker is read-only per spec).
  const feasibilityArtifact = { kind: "phaseFile" as const, phase, name: "feasibility-results.md" };
  await writeArtifact(runtime, feasibilityArtifact, result.text);

  if (result.endReason === "aborted" || result.errorMessage) {
    return { type: "requeue", reason: `Feasibility check failed: ${result.errorMessage ?? result.endReason}` };
  }

  if (parseReviewStatus(result.text) === "FAIL") {
    const sections = parseMarkdownSections(result.text);
    return { type: "requeue", reason: sections["Summary"] ?? "Feasibility check: slice is not feasible as scoped." };
  }

  return { type: "continue" as const };
}

async function runDoneCheck(
  runtime: StageRuntime,
  phase: number,
  sliceId: string,
  acceptanceCriteria: string[],
): Promise<{ status: "PASS" | "FAIL"; reason: string }> {
  const goals = await safeReadArtifact(runtime, { kind: "goals" });

  const result = await dispatchLeaf(
    runtime,
    "dl-done-checker",
    [
      `=== SLICE ID ===\n${sliceId}`,
      `=== PHASE ===\n${phase}`,
      `=== ACCEPTANCE CRITERIA ===\n${acceptanceCriteria.join("\n")}`,
      `=== GOALS ===\n${goals}`,
      `=== STAGE 7 SUMMARY ===`,
      (await runtime.services.artifactRepo.read({ kind: "phaseFile", phase, name: "stage7-summary.md" })) ?? "N/A",
    ].join("\n\n"),
  );

  const doneCheckArtifact = { kind: "phaseFile" as const, phase, name: "done-check-results.md" };
  await writeArtifact(runtime, doneCheckArtifact, result.text);

  if (result.endReason === "aborted" || result.errorMessage) {
    return { status: "FAIL", reason: `Done check failed: ${result.errorMessage ?? result.endReason}` };
  }
  if (parseReviewStatus(result.text) === "FAIL") {
    const sections = parseMarkdownSections(result.text);
    return { status: "FAIL", reason: sections["Summary"] ?? "Slice does not meet done criteria." };
  }

  return { status: "PASS", reason: "" };
}

async function runSliceReflect(
  runtime: StageRuntime,
  sliceId: string,
  sliceTitle: string,
  implSummary: string,
): Promise<void> {
  const goals = await safeReadArtifact(runtime, { kind: "goals" });
  const existingLessons = await safeReadArtifact(runtime, { kind: "lessons" });
  const existingSpecHistory = await safeReadArtifact(runtime, { kind: "specHistory" });

  const result = await dispatchLeaf(
    runtime,
    "dl-reflector",
    [
      `=== MODE ===\nslice-success`,
      `=== SLICE ID ===\n${sliceId}`,
      `=== SLICE TITLE ===\n${sliceTitle}`,
      `=== IMPLEMENTATION SUMMARY ===\n${implSummary}`,
      `=== GOALS ===\n${goals}`,
      `=== EXISTING LESSONS ===\n${existingLessons || "(none yet)"}`,
      `=== EXISTING SPEC HISTORY ===\n${existingSpecHistory || "(none yet)"}`,
    ].join("\n\n"),
  );

  // dl-reflector is a read-only leaf; the controller persists its returned blocks.
  // Contract: ### Lessons / ### Spec History (append) and ### Goals Amendment (replace).
  const sections = parseMarkdownSections(result.text);

  await appendReflectorSection(runtime, { kind: "lessons" }, sections["Lessons"]);
  await appendReflectorSection(runtime, { kind: "specHistory" }, sections["Spec History"]);

  // Reflector may amend goals.md in place (full replacement; clarifications only).
  const goalsAmendment = sections["Goals Amendment"]?.trim();
  if (goalsAmendment && goalsAmendment !== "None.") {
    await writeArtifact(runtime, { kind: "goals" }, goalsAmendment);
  }
}

function classifyEscalation(target: string): "LOOP_DESIGN" | "LOOP_GOALS" {
  if (/goals/i.test(target)) return "LOOP_GOALS";
  return "LOOP_DESIGN";
}

/**
 * Dispatch dl-backward-loop-detector with the persistent-failure context for a slice
 * and use its classification to set the backward-loop classification. Returns the
 * classification derived from the agent, or the heuristic fallback on dispatch failure.
 *
 * The agent returns a markdown response including:
 *   **Overall Recommendation**: NO_LOOP | LOOP_DESIGN | LOOP_GOALS
 *   **Affected Artifact**: design | goals | structure
 */
async function classifyEscalationWithDetector(
  runtime: StageRuntime,
  sliceId: string,
  reason: string,
  requeueCount: number,
): Promise<"LOOP_DESIGN" | "LOOP_GOALS" | "NO_LOOP"> {
  const design = await safeReadArtifact(runtime, { kind: "design" });
  const goals = await safeReadArtifact(runtime, { kind: "goals" });
  const lessons = await safeReadArtifact(runtime, { kind: "lessons" });

  const result = await dispatchLeaf(
    runtime,
    "dl-backward-loop-detector",
    [
      "=== SLICE ID ===",
      sliceId,
      "",
      "=== REQUEUE COUNT ===",
      String(requeueCount),
      "",
      "=== FAILURE REASON ===",
      reason,
      "",
      "=== GOALS ===",
      goals || "(none)",
      "",
      "=== DESIGN ===",
      design || "(none)",
      "",
      "=== LESSONS ===",
      lessons || "(none)",
    ].join("\n"),
    { taskId: `${sliceId}-loop-detect` },
  );

  if (result.endReason === "aborted" || result.errorMessage) {
    // Fall back to heuristic on dispatch failure.
    return classifyEscalation(reason);
  }

  const text = result.text ?? "";
  const recMatch = text.match(/\*\*Overall Recommendation\*\*:\s*(NO_LOOP|LOOP_DESIGN|LOOP_GOALS)/i);
  if (!recMatch) {
    return classifyEscalation(reason);
  }

  const rec = (recMatch[1] ?? "").toUpperCase();
  if (rec === "NO_LOOP") return "NO_LOOP";
  if (rec === "LOOP_GOALS") return "LOOP_GOALS";
  return "LOOP_DESIGN";
}

// ---------------------------------------------------------------------------
// Evidence gate — controller-side check between done-check PASS and markDone
// ---------------------------------------------------------------------------

/**
 * Verifies that a slice that the agent-side done-check claimed PASS actually produced
 * real work: at least one real file was changed AND all configured build/test scripts pass.
 *
 * Catches the "0 tasks, marked done" vacuous-pass failure mode deterministically.
 */
async function assertSliceProducedEvidence(
  runtime: StageRuntime,
  phase: number,
  sliceId: string,
): Promise<{ status: "PASS" | "FAIL"; reason: string }> {
  const repo = runtime.services.artifactRepo;
  const buildTool = runtime.services.buildTool;
  const signal = runtime.services.eventContext.signal;

  // --- File evidence: read the stage7-summary to detect "0 task(s)" ---
  const stage7 = (await repo.read({ kind: "phaseFile", phase, name: "stage7-summary.md" })) ?? "";
  const taskCountMatch = stage7.match(/across\s+(\d+)\s+task\(s\)/i);
  if (taskCountMatch) {
    const taskCount = parseInt(taskCountMatch[1] ?? "0", 10);
    if (taskCount === 0) {
      await recordAnomaly(
        runtime,
        "done-check-vacuous",
        "error",
        `Slice ${sliceId} done-check passed vacuously: 0 tasks were planned/executed. No implementation work happened.`,
        { sliceId, phase, taskCount: 0 },
      );
      return {
        status: "FAIL",
        reason: `Slice ${sliceId} done-check vacuous PASS: 0 implementation tasks were executed. The slice planner produced no tasks.`,
      };
    }
  }

  // --- File evidence: verify that the execution manifest shows at least one PASS task ---
  const manifest = (await repo.read({ kind: "phaseFile", phase, name: "execution-manifest.md" })) ?? "";
  const hasNoRealTasks = /^\|\s*None\s*\|\s*None\s*\|/m.test(manifest);
  if (hasNoRealTasks && manifest.trim() !== "") {
    await recordAnomaly(
      runtime,
      "slice-no-evidence",
      "error",
      `Slice ${sliceId} execution manifest shows no tasks were executed.`,
      { sliceId, phase },
    );
    return {
      status: "FAIL",
      reason: `Slice ${sliceId} evidence gate: execution manifest reports no tasks were run.`,
    };
  }

  // --- Build/test evidence: run available scripts ---
  const scripts = await buildTool.availableScripts(runtime.workspaceRoot);
  for (const scriptName of ["build", "test"] as const) {
    if (!scripts.includes(scriptName)) continue;
    const result = await buildTool.runScript(scriptName, runtime.workspaceRoot);
    if (result.code !== 0) {
      await recordAnomaly(
        runtime,
        "slice-no-evidence",
        "error",
        `Slice ${sliceId} evidence gate: '${scriptName}' script failed (exit ${result.code}) after done-check PASS.`,
        { sliceId, phase, script: scriptName, exitCode: result.code, stderr: result.stderr.slice(0, 400) },
      );
      return {
        status: "FAIL",
        reason:
          `Slice ${sliceId} evidence gate: npm ${scriptName} exited ${result.code}. ${result.stderr.slice(0, 200)}`.trim(),
      };
    }
  }

  void signal; // signal intentionally unused here — build scripts are short

  return { status: "PASS", reason: "" };
}
