# THIS IS TERRIBLE. DON'T RUN THIS (ARCHIVED PROJEDCT)
## pi-deeplooper

`pi-deeplooper` is a deterministic TypeScript extension for [pi](https://github.com/mariozechner/pi-coding-agent). It runs the DEEPLOOPER pipeline in code while still reusing the bundled markdown leaf prompts for specialized synthesis, review, and reporting work.

The runtime is intentionally zero-build: pi loads `src/index.ts` directly from the package manifest, so there is no `dist/` directory, no compile step at install time, and no symlink-based agent registration hack.

## What changed

- The top-level `/deeplooper` orchestration is implemented in TypeScript using a hexagonal (ports and adapters) architecture under `src/domain/`, `src/application/`, and `src/infra/`.
- Only the 39 markdown leaf agents remain in `agents/`; the deleted orchestrator prompts were replaced by code in `src/application/stage/`.
- Pipeline recovery state is persisted in `.pipeline/deeplooper-<run-id>/state.json`.
- Telemetry is written to `.pipeline/deeplooper-<run-id>/telemetry/events.jsonl`, with derived `run-log.md` and `metrics-summary.md`.

## Install

Install with pi:

```bash
pi install git:github.com/n3m6/pi-deeplooper@main
```

That is enough for pi to discover the extension through the package's `pi.extensions` manifest.

If you prefer a wrapper script:

```bash
./install.sh
```

## Use

Run deeplooper from the workspace you want to modify:

```text
/deeplooper build a health-check endpoint for the API
```

Resume a prior run:

```text
/deeplooper resume run-id:deeplooper-20260601-120000

## Or

/deeplooper resume run-id:deeplooper-YYYYMMDD-HHMMSS mode:automated failure:best-effort review:thorough
```

Optional flags:

- `mode:interactive` or `mode:automated`
- `failure:fail-closed` or `failure:best-effort`
- `review:thorough` or `review:fast`
- `models:<profile>` — selects a named model profile from `.deeplooper/models.json`

## Command Reference

All flags are space-separated key:value pairs appended to the task description:

```text
/deeplooper my task description mode:automated failure:best-effort
/deeplooper resume run-id:deeplooper-20260603-120000 mode:interactive
```

### `mode:` — Interaction Mode

Controls whether the pipeline presents human approval gates during execution.

| Value              | Behavior                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `mode:interactive` | Stages pause at review gates and ask for feedback. Interview questions prompt the user for missing context. |
| `mode:automated`   | All gates are auto-approved. Required interview answers use conservative fallbacks when unavailable.        |

**Default**: If pi has a UI (TUI mode), the pipeline defaults to `interactive`. In headless or non-interactive environments, it defaults to `automated`.

### `failure:` — Failure Policy

Controls what happens when a stage cannot converge within its review loop cap, or when a required interview answer is unavailable.

| Value                 | Behavior                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `failure:fail-closed` | The run stops on unresolved review caps or missing required answers.                                       |
| `failure:best-effort` | Unresolved review caps are auto-approved as `PARTIAL`. Missing answers proceed with conservative defaults. |

**Default**: `fail-closed` in interactive mode, `best-effort` in automated mode.

### `review:` — Review Loop Depth

Controls the maximum number of rounds each multi-stage review loop may run before hitting its cap.

| Value             | Behavior                                                                                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `review:thorough` | Each stage uses its full review-round budget (up to 5 rounds for goals and skeleton, 3 for research/questions/acceptance).                                                                      |
| `review:fast`     | Every review loop is capped to **2 rounds** — one initial review, one rewrite-on-fail, one re-review, then stop. Non-review retry loops (implementation retries, fix attempts) are unaffected. |

**Default**: `thorough`.

> **Recommended pairing**: `review:fast failure:best-effort`. If a review still fails after the 2-round cap, it produces an `unclean-cap` FAIL. Under `failure:best-effort` this is automatically softened to `PARTIAL` and the run proceeds rather than stopping. Without `failure:best-effort` in interactive mode, the cap hit instead triggers a human gate where you can approve, retry, or abort.

### `models:` — Model Profile

Selects a named model profile defined in `.deeplooper/models.json` (see [Model Routing](#model-routing) below).

| Value           | Behavior                                                              |
| --------------- | --------------------------------------------------------------------- |
| `models:<name>` | Activates the named profile, overriding the file's `profile` default. |

**Default**: The `profile` field in `.deeplooper/models.json`, or the user's current pi model for all tiers if the file is absent.

```text
/deeplooper my task models:cheap
/deeplooper my task models:max review:thorough
```

### `run-id:` — Resume a Prior Run

Resume a run that was interrupted or stopped. The pipeline reconstructs state from `.pipeline/<run-id>/state.json`. If the state file is missing, it attempts to infer the last completed stage from persisted artifacts.

```text
/deeplooper resume run-id:deeplooper-20260603-120000
```

You can combine `run-id:` with `mode:` and `failure:` to override the original run's settings on resume.

## Pipeline

DEEPLOOPER always runs the full vertical-slice pipeline (there is no quick-fix route):

```text
Goals -> Research -> Design -> Skeleton -> Baseline -> Slice Loop -> Verify -> Accept -> Report
```

The front of the pipeline establishes goals, research, and a design that decomposes the work into **vertical slices**. `Skeleton` scaffolds the slice-0 structure and produces `structure.md`; `Baseline` records the starting test/build state.

The **Slice Loop** is the queue-driven core. It builds a `SliceQueue` from the design and repeatedly selects the next ready slice, then runs five steps against it:

```text
plan (dl-slice-planner) -> feasibility (dl-feasibility-checker) -> implement (worktrees + fast-impl) -> done-check (dl-done-checker) -> reflect (dl-reflector)
```

A slice that fails a step is **requeued** (up to `MAX_REQUEUE = 2`); exceeding that cap **escalates** to `design` or `goals` without deleting any completed slices, after which the queue is reconciled against the revised design. When the queue is exhausted, the run proceeds to global **Verify** and **Accept**. If either finds red, actionable criteria, the reflector appends remediation slices (`R-NNN`) and the run routes back into the Slice Loop; otherwise it advances to **Report**.

## Repository Layout

The codebase follows a hexagonal (ports and adapters) architecture:

- `src/index.ts` registers the `/deeplooper` command and wires the composition root.
- `src/domain/` holds pure value types, the `Run` state aggregate, stage transition policies, and domain events (no infrastructure imports).
- `src/application/port/index.ts` declares all shared port types and interfaces.
- `src/application/pipeline/` contains the pipeline loop, stage runner, and outcome interpreter.
- `src/application/stage/` contains the deterministic stage implementations and sub-stages.
- `src/application/workflow/` contains multi-step workflow helpers (e.g. the agent review loop).
- `src/infra/` contains the adapters implementing the application ports: `fs/` (artifacts, state, resume), `git/` (version control, worktrees), `pi/` (session dispatcher, human gate, telemetry UI), `npm/` (build tool), `codec/` (markdown parsing), `telemetry/` (JSONL sink), and `system/` (clock, IDs).
- `agents/` contains the 39 markdown leaf prompts dispatched by the runtime.
- `docs/agent-inventory.md` records which legacy markdown agents were deleted versus retained.
- `docs/mental-model.md` is a deeper architectural walkthrough.
- `test/` contains TypeScript unit and scenario tests. `npm run verify` is the local gate.

## Local Development

Install dependencies once:

```bash
npm install
```

Run the verification gate:

```bash
npm run verify
```

This runs, in order:

```text
tsc --noEmit
eslint --max-warnings=0 src/domain src/application src/infra test
prettier --check src/ test/
node --import tsx --test --test-concurrency=1 "test/*.test.ts" "test/**/*.test.ts"
```

## Model Routing

The pipeline routes each agent dispatch to one of four tiers, and each tier can be mapped to a different model and thinking level via a project config file.

### Tiers

| Tier        | Agents                                                                                                                                                                                                                                             | Purpose                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `architect` | `dl-goals-synthesizer`, `dl-goals-interviewer`, `dl-research-synthesizer`, `dl-design-synthesizer`, `dl-structure-mapper`, `dl-slice-planner`, `dl-reflector`                                                                                       | Frontier synthesis work; errors here cascade downstream.                    |
| `coding`    | `generic-coding` (the programmatic implementation worker)                                                                                                                                                                                          | Agentic code writing, test writing, and verification. High tool-use volume. |
| `review`    | `dl-goals-reviewer`, `dl-research-reviewer`, `dl-design-reviewer`, `dl-structure-reviewer`, `dl-feasibility-checker`, `dl-done-checker`, all `dl-review-*` and `dl-review-accept-*` agents, `dl-integration-checker`, `dl-e2e-regression-checker`, `dl-baseline-regression-checker`, `dl-backward-loop-detector`, `dl-fast-impl-verify`, `dl-verifier` | Read-only adversarial critique. High fan-out per task.                      |
| `utility`   | `dl-question-generator`, `dl-question-leakage-reviewer`, `dl-question-quality-reviewer`, `dl-codebase-researcher`, `dl-web-researcher`, `dl-coverage-planner`, `dl-baseline-checker`, `dl-reporter`, `dl-fast-impl-code`, `dl-fast-impl-test`        | Cheap mechanical work: extraction, search, formatting.                      |

### `.deeplooper/models.json`

Create `.deeplooper/models.json` in your workspace root (this directory is committable project config, unlike `.pipeline/` which is scratch state):

```json
{
  "profile": "balanced",
  "profiles": {
    "balanced": {
      "architect": { "model": "deepseek/deepseek-v4-pro", "thinking": "high" },
      "coding": { "model": "deepseek/deepseek-v4-pro", "thinking": "high" },
      "review": { "model": "deepseek/deepseek-v4-flash", "thinking": "medium" },
      "utility": { "model": "deepseek/deepseek-v4-flash", "thinking": "medium" }
    }
  }
}
```

See `.deeplooper/models.example.json` for a full example with `balanced`, `cheap`, and `max` profiles.

### Precedence

1. `models:<flag>` overrides the file's `profile` field.
2. Within the active profile, tier binding → pi default model (if tier is absent).
3. `thinking` in the tier binding overrides the agent frontmatter's `thinking:`; if both are absent, `high` is used.
4. If `.deeplooper/models.json` is missing entirely, all agents use the pi session model.

Any tier can be omitted from a profile; omitted tiers fall back to the pi default model.

## Notes

- `.pipeline/` is runtime scratch state and must never be committed to the **pi-deeplooper** repository itself. When running against a target repo, the pipeline automatically commits the active run's `.pipeline/<runId>/` directory (artifacts, state, and telemetry) to the `deeplooper/<runId>` run branch after each stage, creating a staged progress trail. Those commits live only on the run branch in the target repo.
- The extension expects pi-hosted peers such as `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `typebox`.
- The generic implementation worker is no longer a markdown agent; it is a plain nested coding session launched through the dispatcher.

## License

MIT. See [LICENSE](LICENSE).
