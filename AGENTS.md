# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project overview

`pi-deeplooper` is a deterministic TypeScript extension for the [pi](https://github.com/mariozechner/pi-coding-agent) runtime. The `/deeplooper` command is implemented in code and orchestrates the DEEPLOOPER vertical-slice pipeline:

Goals -> Research -> Design -> Skeleton -> Baseline -> Slice Loop -> Verify -> Accept -> Report

The middle is a continuous, queue-driven `slice-loop` (plan -> feasibility -> implement -> done-check -> reflect, per slice) rather than a static phase counter. The route is always `full`.

The runtime lives under `src/`. The repository still ships markdown prompt files in `agents/`, but only as leaf prompts dispatched by the TypeScript controller.

## Repository layout

The codebase follows a hexagonal (ports and adapters) architecture:

- `src/index.ts` — registers the `/deeplooper` command and wires the composition root.
- `src/domain/` — pure value types, state policies, and domain events (no infrastructure imports).
- `src/application/port/index.ts` — all shared port types and interfaces (no infrastructure imports).
- `src/application/pipeline/` — pipeline loop, stage runner, outcome interpreter, and state reconstruction shim.
- `src/application/stage/` — deterministic stage implementations and sub-stages.
- `src/application/workflow/` — multi-step workflow helpers (e.g. agent review gate, synthesize-review gate).
- `src/infra/` — adapters implementing the application ports: `fs/` (artifact repo, state), `git/` (version control), `pi/` (dispatcher, human gate, session), `npm/` (build tool), `codec/` (markdown anti-corruption), `telemetry/` (JSONL sink), `system/` (IDs).
- `agents/` contains the 39 retained markdown leaf prompts. Do not reintroduce deleted orchestrator prompts.
- `docs/agent-inventory.md` is the cutover inventory for orchestrator (code) vs retained leaf agents.
- `test/` contains TypeScript unit and scenario coverage. `test/support/harness.ts` provides the mocked runtime harness.

## Build, test, and run

There is no build step. The extension is loaded from source through the package manifest.

Local quality gate:

```bash
npm run verify
```

That runs `tsc --noEmit` and the TypeScript test suite under `node --test` with `tsx`.

Headless pi smoke test from a target repository:

```bash
bash -lc 'set -a; source "$HOME/.env"; set +a; timeout 20m pi --no-extensions --extension "/home/n3m6/src/pi-deeplooper/src/index.ts" --provider deepseek --model deepseek-v4-flash --mode text --no-session -p "/deeplooper mode:automated failure:best-effort create a SMOKE.md file containing exactly one sentence: Deeplooper smoke test." < /dev/null'
```

Always close stdin with `< /dev/null`; otherwise `pi` can wait indefinitely in headless runs. Use `--extension <repo>/src/index.ts` when testing local edits before reinstalling the package.

## Coding conventions

- Keep the runtime deterministic. Prefer explicit state transitions and typed payloads over parsing freeform text where possible.
- Preserve `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` compatibility.
- Keep diffs minimal. Avoid refactoring unrelated files.
- Leaf prompt files in `agents/` remain markdown with YAML frontmatter. Update them only when the prompt contract itself needs to change.
- Do not reintroduce install-time symlink scripts or markdown stage orchestrators. The TypeScript controller replaces them.

## Pipeline state and artifacts

- Runs use IDs shaped like `deeplooper-YYYYMMDD-HHMMSS`.
- Recovery state lives in `.pipeline/deeplooper-<run-id>/state.json`.
- Telemetry is appended to `.pipeline/deeplooper-<run-id>/telemetry/events.jsonl`.
- Derived telemetry summaries live beside it as `run-log.md` and `metrics-summary.md`.
- `.pipeline/` is scratch state and must never be committed to **this repository**. When the pipeline runs against a target repo, it commits the active run's `.pipeline/<runId>/` to the `deeplooper/<runId>` run branch in that target repo as a per-stage progress trail.

When changing stage ordering, resume behavior, or telemetry schema, update the relevant `src/` modules and expand tests when the change meaningfully alters behavior.

## Agent inventory

- Expected retained markdown agent count: **39**.
- The deleted orchestrator/sub-orchestrator prompts were replaced by code in `src/application/stage/`.
- The generic coding worker is not a bundled markdown agent; it is dispatched programmatically through the `Dispatcher` port (`PiSessionDispatcher` in `src/infra/pi/session-dispatcher.ts`).

## Install model

Preferred install path:

```bash
pi install git:github.com/n3m6/pi-deeplooper@main
```

The package advertises `src/index.ts` via `package.json#pi.extensions`, so pi discovers the extension without any symlink step.

## Operational safety

- Never commit `.pipeline/` to this repository. The runtime commits `.pipeline/<runId>/` only to the run branch in the target repo.
- Avoid adding runtime build steps or install-time scripts.
- Keep `package.json` peer dependencies aligned with pi-hosted runtime packages.
