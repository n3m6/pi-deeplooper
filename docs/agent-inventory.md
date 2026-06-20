# DEEPLOOPER Agent Inventory

This inventory tracks the deterministic TypeScript port of DEEPLOOPER. Orchestration logic lives in `src/application/` (the pipeline loop + stage modules); the 39 markdown leaf prompts in `agents/` remain as prompt payloads dispatched by the runtime.

- **Orchestrators → TypeScript** carried orchestration logic (`tools: subagent`) and were reimplemented as code; they have no markdown file in `agents/`.
- **Leaf** agents remain as markdown prompts dispatched through the `Dispatcher` port.
- The generic code-writing worker is not a markdown agent — it is dispatched programmatically as the `generic-coding` target.

## Orchestrators reimplemented in TypeScript

| Orchestrator | Replacement |
| --- | --- |
| `deeplooper` (primary controller) | `src/index.ts` + `src/application/pipeline/` |
| `dl-goals` | `src/application/stage/goals.ts` |
| `dl-research` | `src/application/stage/research.ts` |
| `dl-research-pass` | `src/application/stage/research-pass.ts` |
| `dl-questions` | `src/application/stage/questions.ts` |
| `dl-design` | `src/application/stage/design.ts` |
| `dl-skeleton` | `src/application/stage/skeleton.ts` (also subsumes the old `structure` stage) |
| `dl-implement` | `src/application/stage/implement.ts` (`runSliceImplementation`, driven by `slice-loop.ts`) |
| `dl-fast-impl-loop` | `src/application/stage/fast-impl-loop.ts` |
| `dl-code-review` | `src/application/stage/code-review.ts` |
| `dl-acceptance-tester` | `src/application/stage/acceptance-tester.ts` (driven by `accept.ts`) |
| `dl-verify` | `src/application/stage/verify.ts` |
| `dl-accept` | `src/application/stage/accept.ts` |
| `dl-report` | `src/application/stage/report.ts` |

The slice loop itself (`deeplooper`'s continuous queue loop) is implemented in `src/application/stage/slice-loop.ts`, with regression sub-orchestrators in `e2e-regression.ts` / `baseline-regression.ts`.

## Leaf agents (39)

`Tier` is the model-routing tier from `src/domain/model/tier-policy.ts`. `Wired` indicates whether the agent is currently dispatched by a stage (some leaves are carried verbatim from the spec but not yet wired into a stage).

| Agent | Stage / Area | Tier | Wired |
| --- | --- | --- | --- |
| `dl-goals-synthesizer` | Goals | architect | yes |
| `dl-goals-interviewer` | Goals | architect | yes |
| `dl-goals-reviewer` | Goals | review | yes |
| `dl-question-generator` | Research | utility | yes |
| `dl-question-leakage-reviewer` | Research | utility | yes |
| `dl-question-quality-reviewer` | Research | utility | yes |
| `dl-codebase-researcher` | Research | utility | yes |
| `dl-web-researcher` | Research | utility | yes |
| `dl-research-synthesizer` | Research | architect | yes |
| `dl-research-reviewer` | Research | review | yes |
| `dl-design-synthesizer` | Design | architect | yes |
| `dl-design-reviewer` | Design | review | yes |
| `dl-structure-mapper` | Skeleton | architect | yes |
| `dl-structure-reviewer` | Skeleton | review | yes |
| `dl-baseline-checker` | Baseline | utility | yes |
| `dl-slice-planner` | Slice Loop — planning | architect | yes |
| `dl-feasibility-checker` | Slice Loop — feasibility | review | yes |
| `dl-fast-impl-code` | Slice Loop — implementation | utility | yes |
| `dl-fast-impl-test` | Slice Loop — implementation | utility | yes |
| `dl-fast-impl-verify` | Slice Loop — implementation | review | yes |
| `dl-review-code-quality` | Slice Loop — code review | review | yes |
| `dl-review-code-simplifier` | Slice Loop — code review | review | yes |
| `dl-review-goal-traceability` | Slice Loop — code review | review | yes |
| `dl-review-security` | Slice Loop — code review | review | yes |
| `dl-review-silent-failure` | Slice Loop — code review | review | yes |
| `dl-review-test-coverage` | Slice Loop — code review | review | yes |
| `dl-review-test-quality` | Slice Loop — code review | review | no |
| `dl-integration-checker` | Slice Loop — integration | review | yes |
| `dl-e2e-regression-checker` | Slice Loop — regression | review | yes |
| `dl-baseline-regression-checker` | Slice Loop — regression | review | yes |
| `dl-done-checker` | Slice Loop — done check | review | yes |
| `dl-backward-loop-detector` | Slice Loop — backward loop | review | no |
| `dl-reflector` | Slice Loop / Verify / Accept — reflection & remediation | architect | yes |
| `dl-verifier` | Verify | review | yes |
| `dl-coverage-planner` | Accept | utility | yes |
| `dl-review-accept-spec` | Accept | review | no |
| `dl-review-accept-code-quality` | Accept | review | no |
| `dl-review-accept-goal-traceability` | Accept | review | no |
| `dl-reporter` | Report | utility | yes |

Totals:

- Leaf agents: 39
- Currently wired: 34
- Carried but not yet wired: 5 (`dl-review-test-quality`, `dl-backward-loop-detector`, `dl-review-accept-spec`, `dl-review-accept-code-quality`, `dl-review-accept-goal-traceability`)

The not-yet-wired leaves are kept verbatim from the DEEPLOOPER spec for parity. The slice loop currently derives backward-loop classification from the integration checker's output rather than dispatching `dl-backward-loop-detector`, and the global accept gate uses `dl-coverage-planner` + generic coding + `dl-reflector` rather than the per-criterion accept reviewers.
