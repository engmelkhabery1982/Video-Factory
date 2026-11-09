# D6 direction and binding integrity delta — 9 November 2026

Reviewed parent: `664422adec545a6657dc7fd233ceb0c197307adc`. Existing educational local refinement only; no new capability, resource, dependency, owner data/timing or approved/F change.

## Defects addressed

1. The response host trusted the decoder's subject/action `const` constraints. A provider returning valid JSON could ignore those constants, and the host would persist the replacement in its refined plan. Added strict equality against the chosen binding before accepting a scene. Two regressions (replacement subject and replacement action) failed before and pass after; an empty-subject case was already rejected by the existing field check. Original input remains immutable on every rejection. This verifies **binding integrity**, not correctness of the earlier model-extracted binding or source entailment.
2. `result_then_explanation` always demanded before/after, including observational inspection. Replaced this with authorized result/detail plus process detail; before/after is conditional on both states being supplied. Added explicit source authority over findings and physical changes; draft continuity settings cannot authorize actions/outcomes. Removed the earlier unreviewed subject from the continuity hint, retaining environment only. Conversational direction now asks for distinct demonstrator/response gestures and the narrated action.

No host semantic certificate was added; prompt guidance remains fallible. No QA-specific visual answer was inserted. Source words, IDs, methods, camera choices, references, bounds, cancellation and validator stay unchanged. Other profiles remain untouched.

## Executed checks

- `node node_modules/vitest/vitest.mjs run tests/local-visual-refinement.test.ts`: **14/14 PASS**, labelled provider doubles, including the two actual regression-first failures and existing empty-value protection.
- API `tsc --noEmit`: exit0.
- `git diff --check`: exit0 after documentation whitespace normalization.
- No old provider36, planner5, CLOSEOUT07 path20/native3/export, schedule, capture or full renders were repeated.

## Changed native subtask evidence

Used the **existing authorized1.5B**, not another7B trial. Exact previously verified model/runtime, CPU4threads/context4096/loopback. Reused the actual saved original plan and **two explicitly replayed historical native binding responses**; made **six new actual composition calls** through the changed production helper. No main-plan regeneration or fixture-authored native output.

Artifacts: local `D6_LOCAL_20261109/direction-authority-refinement/qualification.json`, six full request/response pairs and runtime logs. Actual interval16:52:02–16:52:14UTC (exact fractional timestamps in JSON). Changed helper completed, unchanged core plan validator passed, original plan JSON stayed identical. Owned runtimePID13564 stopped in `finally`; no resource download.

Review: inspection result/detail now shows a person inspecting, without the previous filling/marking transition. This limited sample is an observed improvement, not general safety proof. **Semantic quality still FAILS:** worked pipe composition is only `the empty trench`; conversational outputs omit distinct roles; pipe result/detail collapses to `blue pipe in trench`. Native answers were retained unchanged, not corrected by hand or Applied/persisted as accepted/rendered.

## Stop and next bounded task

Code-level host binding integrity and conditional direction are qualified. D6 meaning and whole-factory release remain OPEN. The earlier7B three-case trial remains concluded; no further7B run or larger-model permission is inferred.

Next investigate why the composition subtask loses the bound action and method roles despite valid fields: define a bounded, source-linked **method coverage rejection boundary**, exercising these saved native failures before any changed native attempt. Do not turn a deterministic layout preset, keyword fixture, repeated camera change or reworded prompt into a claim of semantic planning. No repeat unchanged full planning, successful historical tests, downloads or render. All other engine/native-capture/quality gates remain open. Approved/F stay `daae482aac9de85e993599a6d010e29908ac567a`.
