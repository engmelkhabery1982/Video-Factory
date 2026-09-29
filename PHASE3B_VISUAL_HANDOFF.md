# Phase 3B — Deterministic Scenario Visual-Plan Compiler (handoff)

Source: `origin/arena/01a0ed0c-video-factory` @ `05b823434b4b1c7da406c56bd39b7a8c8493fc1c`.
Scope: a plan only. No renderer, React/Remotion, audio, captions, API or UI work was done.

## New files (the only files touched)

| File | Purpose |
|---|---|
| `packages/core/src/scenario/visual-plan-types.ts` | `ScenarioVisualPlan`, `ScenarioVisualScene`, `ScenarioVisualBeat`, `ScenarioVisualCue`, `ScenarioVisualPlanFinding`, result/report types |
| `packages/core/src/scenario/compile-visual-plan.ts` | `compileScenarioVisualPlan(scenario, config?)`, `SCENARIO_VISUAL_FORMAT_PROFILES` |
| `packages/core/src/scenario/validate-visual-plan.ts` | `validateScenarioVisualPlan(plan, source)`, `resolveVisualCueSourceText(source, pointer)` |
| `tests/scenario-visual-plan.test.ts` | 28 tests; imports the modules directly |
| `PHASE3B_VISUAL_HANDOFF.md` | this document |

## Integration steps for the central reviewer (not done here, by instruction)

1. Add the following to `packages/core/src/scenario/index.ts`:
   ```ts
   export * from './visual-plan-types.js';
   export * from './compile-visual-plan.js';
   export * from './validate-visual-plan.js';
   ```
   No name collides with existing exports.
2. Raise the floor in `scripts/assert-test-count.mjs` if you want to. The suite is now 229 tests (201 + 28).

## Design

- **Reuse, no duplication.** Phase 3A `validateScenario` gates compilation. `estimateScenarioDuration` provides all timing. `analyzeScenarioDiversity` provides the repetition signals.
- **Refusal is data.** An invalid source returns `{ ok: false, plan: null, errors, sourceWarnings }` with the 3A findings. An object that crashes the validator returns `visual_plan.source_unreadable`. The compiler never throws.
- **Structure.** Each source scene produces exactly one visual scene. Its beats, in order, are:
  - one `dialogue` beat per turn, timed as speech plus pause;
  - one `visual_only` beat when the scene has no turns;
  - one `transition` beat when the 3A estimator allots transition time.

  Scene-wide `sceneCues` carry:
  - the scene title, lower-third title/subtitle, callout and bullets;
  - the screen insert (title, description and logical `assetRef`);
  - overlay, B-roll and environmental-action intents;
  - scene evidence that no turn cites.
- **Traceability.** Every cue has a `source` pointer (`sceneId`, `field`, optional `turnId`/`evidenceId`/`itemIndex`), and its text is a verbatim copy. The validator re-resolves every pointer against the source and rejects any mismatch. Only `evidence` cues may carry `numericFacts`, and those must deep-equal the evidence record.
- **Speakers and shots.** Each dialogue beat has an `activeSpeakerId` and a `reactingCharacterId` (which is the turn's `reactionTargetId`; it is never inferred). `shot` copies the scene direction. `focusCharacterId` is the speaker for `speaking_character`, the reaction target for `reacting_character`, and null otherwise.
- **Timing.** Timing uses integer milliseconds internally, so repeated compilation is byte-identical. Scenes are contiguous from 0, and beats tile each scene exactly. Spoken cues cover the speech, not the trailing pause.
- **Stable IDs.** Only source IDs are used: `scenarioId/sceneId`, `…/turn/turnId`, `…/visual`, `…/transition`, `…/cue/kind[/evidenceId|/index]`. There are no clocks, randomness, environment values or paths.
- **Purity.** The compiler works on a private deep copy, and the plan shares no references with the input.
- **Formats.**

  | Format | Orientation | Aspect | Max bullets per frame | Max scene text cues |
  |---|---|---|---|---|
  | Long | landscape | 16:9 | 5 | 4 |
  | Short | portrait | 9:16 | 3 | 3 |
  | reusable | format-neutral | any | 3 | 3 |

  Exceeding a limit, or the target duration, produces a warning. Text is never truncated.
- **Diversity.** Unjustified 3A runs (speaker, shot, setting, purpose) and repeated sentences are passed through as warnings. So is an identical consecutive shot/framing/focus/movement pattern, unless `justifications.repeatedShot` is set. Nothing is rewritten.
- **Validator checks:**
  - version, scenario ID and format;
  - scene missing, duplicate, unknown or out of order;
  - scene index, purpose, location, participants, turns, production, on-screen info and visual-only flag;
  - evidence changed or untraceable;
  - turns missing, duplicate or foreign, and speaker, text or reaction changed;
  - non-dialogue beats carrying dialogue;
  - cue untraceable, text changed or in the wrong scene;
  - numeric facts invented or changed;
  - scene, beat and cue timing (invalid, overlap, outside parent, incomplete, total mismatch);
  - duplicate or unstable IDs;
  - absolute filesystem paths anywhere in the plan.

## Fixture results

| Fixture | Format | Scenes | Estimated duration | Plan valid | Compiler findings | Diversity warnings |
|---|---|---|---|---|---|---|
| progress-meeting | Long | 5 | 102 s | yes | duration under 110 s minimum | 2 speaker runs, 1 setting run |
| claim-variation | Long | 4 | 89.8 s | yes | duration under 115 s minimum | 1 speaker run, 1 setting run |
| schedule-risk | Short | 3 | 41.4 s | yes | none | 1 setting run |

The under-target durations are what the 3A estimator reports for the existing fixtures. They are surfaced as warnings and not changed.

## Limitations

- A production-level `transitionIntent` is carried as data but adds no time, because the 3A estimator only times `scene.transitionIntent`.
- One shot per scene: the source directions are scene-level, so every beat inherits them. Per-turn shot changes would need a source-contract extension.
- A repeated sentence is a 3A **error**, so such a scenario is refused. The compiler cannot receive one to warn about.
- Cue timing within a beat is scene-level or turn-level. There is no word-level timing, which belongs to later audio phases.
