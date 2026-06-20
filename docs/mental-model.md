## What pi-deeplooper is

`pi-deeplooper` is a **deterministic TypeScript extension** for the `pi` coding-agent runtime. It registers a single slash command, `/deeplooper`, which runs the **DEEPLOOPER pipeline** — a fixed, code-orchestrated, vertical-slice sequence that takes a task from a raw user request all the way to verified, committed code:

```
Goals → Research → Design → Skeleton → Baseline → Slice Loop → Verify → Accept → Report
```

The key design idea (called out in `AGENTS.md`) is that the *orchestration is code, not prompts*. The control flow — which stage runs next, when to loop back, when to stop — lives in TypeScript. Only the "leaf" work (synthesizing goals, reviewing a design, planning a slice, checking it's done, etc.) is delegated to LLM agents driven by the 39 markdown prompts in `agents/`.

Unlike a static phase-counter pipeline, DEEPLOOPER's middle is a **continuous queue-driven slice loop**: the design is decomposed into vertical slices, and the engine repeatedly selects the next ready slice, plans it, checks feasibility, implements it, checks it's done, and reflects — until the queue is exhausted. The route is always `full`; there is no quick-fix path.

The codebase uses **hexagonal architecture** (ports & adapters):
- `src/domain/` — pure logic, no I/O (state machine, transition rules, the `SliceQueue` aggregate, policies)
- `src/application/` — pipeline loop + stage implementations, depends only on *port* interfaces
- `src/infra/` — adapters that implement those ports (filesystem, git, pi sessions, npm, telemetry)

## 1. Entry point: `src/index.ts` (the composition root)

At extension load it registers a transcript renderer and the command itself:

```34:37:src/index.ts
  pi.registerMessageRenderer(DEEPLOOPER_PROGRESS_CUSTOM_TYPE, DEEPLOOPER_PROGRESS_RENDERER);

  pi.registerCommand("deeplooper", {
    description: "Run the deterministic DEEPLOOPER vertical-slice pipeline.",
```

When `/deeplooper ...` is invoked, the handler is the **composition root** — it builds every concrete adapter, wires them into one `PipelineServices` bag, and hands that to the pipeline loop. The important steps:

1. **Parse interaction mode & run ID.** `determineInteractionMode` reads flags like `mode:automated` / `failure:best-effort` / `review:fast` / `models:<profile>` from the args. The run ID is either a resumed one (`run-id:deeplooper-...`) or a fresh timestamp ID (`deeplooper-YYYYMMDD-HHMMSS`).

2. **Load agent catalog & build adapters:** the markdown agent catalog (filtered to `dl-*`), the `PiSessionDispatcher`, the gate manager, progress reporter, artifact repo (filesystem), git version control, npm build tool, and the telemetry sinks. Model routing reads `.deeplooper/models.json` via `loadModelConfig`.

3. **Resume or start fresh.** `resumeOrInferState` tries to recover prior state; the run is either rehydrated or started fresh.

4. **Run the pipeline** by calling `runPipeline({ services, state, workspaceRoot, isResumed })`, optionally wrapping the dispatcher/gates in cassette **recorders** when `DEEPLOOPER_RECORD` is set, then notify the user of the final stage.

Everything below the composition root depends only on the port interfaces in `src/application/port/index.ts`, never on `pi` or `node` directly.

## 2. The domain state machine: `Run` and the transition policy

Determinism is anchored by the `Run` aggregate (`src/domain/run/index.ts`). It owns a `RunState` snapshot — route (always `full`), last completed stage, next stage, backward-loop counter, and the slice-tracking fields (`currentSlice`, `slicesDone`, `slicesBlocked`, `requeueCounts`, `pendingReconcile`). It exposes pure mutators (`completeStage`, `setCurrentSlice`, `markSliceBuilding`, `markSliceDone`, `requeueSlice`, `escalateSlice`, `incrementBackwardLoops`, `setPendingReconcile`) and emits **no side effects**.

What stage comes next is decided by a single pure function:

```23:44:src/domain/stage/transition-policy.ts
export function nextStageFor(stage: StageName, context: NextStageContext = {}): NextStage {
  switch (stage) {
    case "goals":
      return "research";
    case "research":
      return "design";
    case "design":
      return "skeleton";
    case "skeleton":
      return "baseline";
    case "baseline":
      return "slice-loop";
    case "slice-loop":
      return "verify";
    case "verify":
      return context.remediationSlicesAdded ? "slice-loop" : "accept";
    case "accept":
      return context.remediationSlicesAdded ? "slice-loop" : "report";
    case "report":
      return "done";
  }
}
```

Two things to notice:
- **The graph is linear** up to the slice loop, then `slice-loop → verify → accept → report`.
- **Remediation routing.** When `verify` or `accept` finds red, actionable criteria, the reflector appends remediation slices (`R-NNN`) to the queue and sets `remediationSlicesAdded`, which routes the pipeline **back into `slice-loop`** instead of advancing.

## 3. The `SliceQueue` aggregate

`src/domain/slice/slice-queue.ts` is a pure aggregate that owns `slice-queue.md`. It can `parse`/`serialize` the markdown, `selectNextReady()` (the first `ready` slice whose deps are all `done`), apply status mutations (`markBuilding`/`markDone`/`requeue`/`escalate`/`markBlocked`), `addRemediationSlices` (`R-NNN`), `buildInitial` from the design's `## Vertical Slices` section, report `isExhausted()`, and — crucially for escalation recovery — `reconcile(newDesignMd, { preserveDone: true })`, which rebuilds the queue from a revised design while keeping already-`done` slices intact.

Backward loops never delete completed work: `escalationTarget` (`src/domain/backward-loop/artifact-reset-policy.ts`) only ever maps a classification to `design` or `goals`.

## 4. The pipeline loop: `pipeline-loop.ts`

`runPipeline` is the engine. It holds a `STAGES` registry mapping each of the 9 stage names to its `StageModule`, then loops `while (run.nextStage !== "done")`.

```69:72:src/application/pipeline/pipeline-loop.ts
    while (run.nextStage !== "done") {
      const stageName = run.nextStage;
      const stage = STAGES[stageName];
      services.progress.setStage(`deeplooper/${stageName}`);
```

Each iteration runs one stage via `executeStage`, then inspects the `StageOutcome`:

- **Escalation backward loop.** If a stage returns `outcome.backwardLoop` with `LOOP_DESIGN`/`LOOP_GOALS` (raised by the slice loop when a slice's requeue cap is exceeded, or by verify/accept when no remediation is actionable), the loop increments the backward-loop counter, sets `pendingReconcile` (so the slice loop reconciles the queue when it re-enters), and reroutes to `design`/`goals` — **without archiving or deleting any completed slices**. If the backward-loop cap (`MAX_BACKWARD_LOOPS = 3`) is hit, the run stops as PARTIAL.
- **Hard FAIL** (no backward loop) breaks the loop and stops the run.
- **Normal completion**: apply the transition (`applyStageTransition`), persist state, regenerate telemetry summaries, and create a git checkpoint.

State is saved after *every* transition, which is what makes resume possible. There is **no** engine-level `phase.started`/`totalPhases` emission anymore — phase progress now lives in the `slice.started`/`slice.completed` events inside the slice loop.

### `outcome-interpreter.ts` — applying transitions

`applyStageTransition` (synchronous) bridges a stage's `StageOutcome` and the state machine. For each stage it calls `run.completeStage(stage, nextStageFor(...))`. Notable extras: `design` clears `pendingReconcile` on re-run; `verify` extracts `verify_status`; `verify`/`accept` pass the `remediationSlicesAdded` flag into the transition policy.

## 5. The Slice Loop in depth

`src/application/stage/slice-loop.ts` is the monolithic core. It first **loads or builds** the `SliceQueue` (building it from `design.md` on first entry; **reconciling** it against the revised design when `pendingReconcile` is set after an escalation). Then it loops:

```75:79:src/application/stage/slice-loop.ts
    while (true) {
      const slice = queue.selectNextReady();
      if (!slice) {
        break;
      }
```

For each selected slice it runs five sub-steps, persisting the queue + state and emitting telemetry along the way:

1. **`dl-slice-planner`** — writes task specs into `phases/phase-NN/tasks/`. A FAIL escalates (`LOOP_DESIGN`/`LOOP_GOALS`).
2. **`dl-feasibility-checker`** (read-only) — the controller persists its output to `<phase-dir>/feasibility-results.md`. A FAIL requeues the slice.
3. **`runSliceImplementation`** (`implement.ts`) — builds dependency **waves** (`wave-planner.ts`), runs each task in a parallel **git worktree** through the **code → test → verify** fast-impl loop, squash-merges passing tasks, then runs e2e + baseline regression and `dl-integration-checker`. An integration FAIL surfaces a `backwardLoop` (escalate) or requeues.
4. **`dl-done-checker`** — a FAIL requeues the slice.
5. **`dl-reflector`** (`slice-success`) — appends `lessons.md` and `spec-history.md`, and may apply clarifying amendments to `goals.md`.

Requeues are bounded by `MAX_REQUEUE = 2`; exceeding the cap **escalates** the slice (returns a `LOOP_DESIGN` backward loop). After each successful slice the loop marks it `done`, emits `slice.completed`, and checkpoints. When `selectNextReady()` returns nothing the queue is exhausted and the stage returns PASS → `verify`.

## 6. Skeleton, Baseline, Verify, Accept, Report

- **Skeleton** (`skeleton.ts`) builds the slice-0 scaffold in a worktree (reusing the fast-impl/worktree/squash machinery), then runs the `dl-structure-mapper` ↔ `dl-structure-reviewer` review loop to produce `structure.md`. It early-PASSes when `structure.md` already exists (resume / escalation re-entry); a hard failure escalates to `design` (`LOOP_DESIGN`).
- **Baseline** (`baseline.ts`) dispatches `dl-baseline-checker` to record `baseline-results.md`; idempotent (early-PASS when results exist).
- **Verify** (`verify.ts`) runs `dl-verifier` globally across all completed slices. On red criteria it dispatches `dl-reflector` in `global-remediation` mode; if remediation slices are produced they are appended to the queue and the run routes back to the slice loop, otherwise it escalates.
- **Accept** (`accept.ts`) runs global acceptance (`dl-coverage-planner` + generic coding) and writes the run-level `global-acceptance-results.md`. Same remediation-vs-escalate logic as verify.
- **Report** (`report.ts`) dispatches `dl-reporter` and ends the run (`done`).

## 7. How stages call agents: dispatch + review loops

Each stage is a `StageModule` with a `run(runtime)` method returning a `StageOutcome`. Stages do their work by **dispatching agents** through the `Dispatcher` port (`PiSessionDispatcher`).

- **Leaf agents** — one of the 39 markdown prompts, loaded by `MarkdownAgentCatalog` (which filters to files starting with `dl-`). The dispatcher creates an isolated pi session, applies the leaf's system prompt, tool allowlist, model (by tier), and max-turns.
- **Generic coding** — an unnamed `generic-coding` worker used to actually edit code, given a `stage_return` tool to return structured results.

A recurring pattern is the **write → review → rewrite loop** (`src/application/workflow/agent-review-loop.ts`), bounded per stage (e.g. `MAX_GOALS_REVIEW_ROUNDS = 5`). `review:fast` clamps every loop to `FAST_REVIEW_ROUNDS`.

## 8. Interaction modes, gates, and failure policy

`determineInteractionMode` (`human-gate.ts`) picks the mode:
- **interactive** → live human gates; defaults to **fail-closed**.
- **automated** → gates auto-approve; defaults to **best-effort** (retry transient failures). This is what the headless smoke test uses (`mode:automated failure:best-effort`).

The `DefaultGateManager` also exposes an `ask_human` tool so leaf agents can ask the human a question mid-session in interactive mode.

## 9. Persistence, resume, and telemetry

- **State** is saved to `.pipeline/deeplooper-<run-id>/state.json` after every transition (`FileSystemRunStateRepository`). The DEEPLOOPER spec's `state.md` is informational; `state.json` is the engine's machine state.
- **Resume** (`state-reconstruction.ts`): `resumeOrInferState` first loads `state.json`. If absent, it *infers* state by scanning artifact markers (`goals.md`, `research/summary.md`, `design.md`, `structure.md`, `skeleton-results.md`, `baseline-results.md`), recovers slice-loop progress from `slice-queue.md` (done/blocked/escalated counts, exhaustion), and computes the next stage with the same `nextStageFor` policy (`resume_source: artifacts`).
- **Telemetry**: every event is appended as JSONL to `.pipeline/deeplooper-<run-id>/telemetry/events.jsonl` (with `writer_agent: "deeplooper"`), including the DEEPLOOPER slice lifecycle events `slice.started` / `slice.completed` / `requeue.requested` / `requeue.decided` / `requeue.exhausted`. Derived `run-log.md` and `metrics-summary.md` are regenerated alongside, and `LiveUiTelemetrySink` streams breadcrumbs into the pi transcript.
- Branches are `deeplooper/<run-id>`, checkpoints use `deeplooper:` messages, and worktrees live under `.deeplooper-worktrees`.
- `.pipeline/` is scratch and must never be committed to this repository.

## 10. Replay / cassettes

`src/infra/replay/**` records agent dispatches and git operations into golden **cassettes** (`DEEPLOOPER_RECORD=<dir>`), which are replayed deterministically in tests (`test/cassettes/<name>/`) in both pure and semi-live modes. The committed scenarios are `full-run`, `verify-remediation`, and `backward-loop-design`.

---

### The whole thing in one mental model

`/deeplooper` → composition root builds adapters → `runPipeline` drives a `while (nextStage !== "done")` loop → linear stages reach the **slice loop**, which builds/reconciles a `SliceQueue` and repeatedly plans → checks feasibility → implements → checks done → reflects per slice (requeue on local failure, escalate to design/goals on cap) → when the queue is exhausted, global **verify** and **accept** either pass through to **report** or append remediation slices that route back into the loop → state is checkpointed to disk and git after every step → it ends at `report` (PASS) or stops early (PARTIAL/abort).
