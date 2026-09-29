# Phase 3D — Deterministic Unified Scenario Playback Manifest (handoff)

Source: `origin/arena/01a0ed0c-video-factory` @ `33d2c22a0227cce55f1e690f8ac3fa8e3b8130d2` ("fix(api): wait for failed upload stream cleanup").
Scope: this phase produces a manifest only. It does not render, synthesize audio, use FFmpeg, or touch Remotion, the API or the UI.

## New files (the only files touched)

| File | Purpose |
|---|---|
| `packages/core/src/scenario/scenario-playback-types.ts` | Contract types:<br>• `ScenarioPlaybackPlan`, `ScenarioPlaybackScene`, `ScenarioPlaybackBeat`, `ScenarioPlaybackDialogue`<br>• `ScenarioPlaybackCue`, `ScenarioPlaybackInterval`, `ScenarioPlaybackTransition`<br>• `ScenarioPlaybackFinding`, `ScenarioPlaybackValidationReport`, `CompileScenarioPlaybackResult`, `ScenarioPlaybackOptions` |
| `packages/core/src/scenario/compile-scenario-playback.ts` | `compileScenarioPlayback(scenario, options?)`<br>`joinScenarioPlayback(visual, audio, config, schemaVersion, basePath?)` |
| `packages/core/src/scenario/validate-scenario-playback.ts` | `validateScenarioPlaybackPlan(plan, source)`<br>Shared helpers: `toMs`, `interval`, `resolvePlaybackDurationConfig`, `toPlaybackCue` |
| `tests/scenario-playback.test.ts` | 31 tests; imports the modules directly |
| `PHASE3D_PLAYBACK_HANDOFF.md` | this document |

## Integration steps for the central reviewer (not done here, by instruction)

1. Add the following to `packages/core/src/scenario/index.ts`:
   ```ts
   export * from './scenario-playback-types.js';
   export * from './validate-scenario-playback.js';
   export * from './compile-scenario-playback.js';
   ```
   The helper names `toMs` and `interval` are generic. If they collide or feel too broad for the public surface, re-export selectively instead. No existing export uses either name today.
2. Optionally raise the test-count floor. The suite is now 300 tests (269 + 31).

## Contract

- **One call.** `compileScenarioPlayback(scenario, { durationConfig?, allowSharedVoiceSlots?, audioBasePath? })` does the following:
  1. Resolves the partial `durationConfig` into one complete `DurationEstimatorConfig`. Unknown keys and invalid values are refused.
  2. Runs the Phase 3B `compileScenarioVisualPlan` and the Phase 3C `planDialogueAudio` with that same config.
  3. Validates both sub-plans with their own validators.
  4. Joins the two plans.
  5. Validates the joined manifest against the source.

  Any failure returns `{ ok: false, plan: null, errors, sourceWarnings }`. Each finding carries a `stage` of `source`, `visual`, `audio` or `playback`. Nothing throws, not even for `null`, `42` or `{}`.
- **Identity.** The plan records `scenarioId`, `projectId`, `language` and `targetFormat`. It also records `schemaVersions` (scenario, visualPlan, audioPlan), the exact `durationConfig`, `allowSharedVoiceSlots`, `audioBasePath`, the 3B format profile and the 3C audio format.
- **One timeline.** Timing uses integer milliseconds starting at 0. Every interval is `{startMs, endMs, durationMs}` and half-open.
  - Scenes tile the timeline.
  - Beats tile their scene.
  - Cues sit inside their beat or scene.
  - `totalDurationMs` = last scene end = the 3A estimate.
  - speech + pause + transition + visual-only time = total.
- **Explicit interval relationships** for each dialogue:
  - `turnSpan` equals its visual beat's interval.
  - `speech.startMs` equals `turnSpan.startMs`.
  - `pause` runs from `speech.endMs` to `turnSpan.endMs`.
  - The scene's `dialogueSpan` covers its turns.
  - `transition.interval` equals the transition beat's interval, or is `null` when the transition adds no 3A time. That applies to cut, none, and production-level or default transitions.
- **Join.** Each `ScenarioPlaybackDialogue` holds the IDs of its source scene and turn, its 3B beat (`visualBeatId`, which is also its own `id`) and its 3C clip (`audioClipId`). It also holds:
  - speaker and reacting character;
  - verbatim text, intent and delivery;
  - evidence IDs and voice slot;
  - the relative `suggestedAudioPath`;
  - all three intervals.

  Each dialogue beat points back to its entry through `dialogueId`. Shots, cues (verbatim, re-timed in ms), evidence records, production directions and on-screen info are copied from 3B and deep-cloned.
- **Warnings.** Non-blocking format and diversity warnings from 3B are carried in `plan.warnings`.

## One-to-one proof

The join step indexes 3C clips by turn. It then walks the 3B beats:

- A dialogue beat without a clip gives `playback.beat_without_clip`.
- A clip no beat consumed gives `playback.clip_without_beat`.
- A turn with two clips gives `playback.clip_duplicate`.
- If the two planners disagree on start time, span or speech duration, the result is `playback.timing_disagreement`.
- If they disagree on speaker, text, intent, delivery or evidence, the result is `playback.plan_disagreement`.
- A config mismatch gives `playback.duration_config_mismatch`.
- A total mismatch gives `playback.total_disagreement`.

Test 7 asserts that the beat IDs equal the 3B dialogue beats in order, and the clip IDs equal the 3C clips in order. Both sets are unique and have the same size as the source turns.

## Validator (against the original Scenario)

The validator re-derives reference 3B and 3C plans from the source using the plan's own recorded `durationConfig`, `allowSharedVoiceSlots` and `audioBasePath`. It then checks the following.

**Identity and configuration**
- identity and schema versions;
- `durationConfig` is complete and valid;
- format and audio format;
- the character voice table.

**Scenes**
- missing, duplicate, unknown or out-of-order scenes;
- stable IDs and index;
- title, purpose, location, participants, visual-only flag, production, on-screen info and evidence records.

**Timing**
- scene intervals: overlap, gap, and match against the estimator under the recorded config;
- beat coverage and order, beat kind, and tiling;
- cue timing;
- speech anchoring and duration, pause bounds and duration;
- dialogue overlap;
- all five totals and `dialogueCount`.

**Content**
- shot, speaker, reaction and evidence IDs for every beat;
- every cue: invented, missing or changed, with text re-resolved against the source, numeric facts checked, and timing checked;
- transitions: type and source, `untimed_gained_duration`, and interval match;
- dialogue coverage: missing, duplicate, unknown or reordered turns;
- per turn: speaker, reaction, text, intent, delivery, evidence (including unknown IDs), voice slot and path.

**IDs and paths**
- duplicate IDs and duplicate clip IDs;
- an unsafe `audioBasePath`;
- any absolute or `file://` path anywhere in the plan.

The validator returns malformed findings instead of throwing.

## Fixture results (default configuration)

| Fixture | Format | Scenes | Dialogues | Total | Valid |
|---|---|---|---|---|---|
| progress-meeting | Long | 5 | 12 | 102 000 ms | yes |
| claim-variation | Long | 4 | 10 | 89 800 ms | yes |
| schedule-risk | Short | 3 | 7 | 41 400 ms | yes |

## Limitations

- **Resolution.** Phase 3C rounds its timeline to 0.01 s, while 3B uses integer ms. They agree because the 3A estimator rounds speech and turn totals to 0.01 s. The join tolerates at most 1 ms of float error and otherwise refuses. The playback timeline is taken from the 3B beats.
- **Pause precision.** A source `pauseAfterSeconds` with more than two decimals would be rounded by the estimator's 0.01 s turn total. The pause is therefore checked within 5 ms of the source value, while speech is checked exactly.
- **Estimated timing only.** Durations are estimates, not measurements. Replacing them with measured clip lengths after synthesis is future work and was not started here.
- **Scene-level shots.** Shot direction stays scene-level, inherited from 3B.
- **Cost.** The validator recompiles the reference plans, so validation costs about as much as compilation. That is negligible at fixture scale.
