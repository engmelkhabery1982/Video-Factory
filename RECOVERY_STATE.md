# Recovery State

Last updated: 2026-09-29 — Phase 3D/3E integration review checkpoint. **Stopped here; the next phase has not started.**

## Where the work is

| Item | Value |
|---|---|
| Delivery branch | `arena/01a0ed0c-video-factory`. Arena sessions can only push to this branch. |
| Integration source | `origin/arena/integration-phase3d-phase3e` @ `ed0b4a60115c4082c184ba53eec253dbdb311125` (Phase 3E + hardening). This branch was **not modified**. |
| Phase 3D commit | `d8f7f3841f4a7e358963a8d357842643258d47a4`. It was not in the integration branch's history. |
| Merge | `merge: integrate Phase 3E captions with Phase 3D playback`. Parents: `d8f7f38` and `ed0b4a6`. |
| Checkpoint | The commit that adds this file (see `git log`). |

The checkpoint contains `ed0b4a6` in its history, so `arena/integration-phase3d-phase3e` can be fast-forwarded to it if you want that branch to carry the result.

## Completed in this checkpoint

1. **Integration guard** in `packages/core/src/scenario/compile-scenario-playback.ts`. `joinScenarioPlayback` now refuses to join the visual and audio plans when any of the following disagree, even if every scene and turn ID matches:
   - `scenarioId`, `projectId`, `language` or `targetFormat` (`playback.metadata_mismatch`);
   - scene identity, order or index (`playback.scene_mismatch`);
   - per-scene turn lists (`playback.turn_mismatch`);
   - scene boundaries (`playback.scene_timing_mismatch`);
   - the declared audio clip count (`playback.clip_count_mismatch`).

   `compileScenarioPlayback` also checks both generated plans against the source metadata before joining.
2. **Public exports** in `packages/core/src/scenario/index.ts`:
   - Phase 3D: the types, the compiler, and `validateScenarioPlaybackPlan` plus `resolvePlaybackDurationConfig`. These two are exported selectively so that the generic helpers `toMs`, `interval` and `toPlaybackCue` stay internal.
   - Phase 3E: types, compiler and validator.

   `packages/core/src/index.ts` already re-exports `./scenario/index.js`, so it was left unchanged.
3. **End-to-end test** `tests/scenario-playback-caption-integration.test.ts` (15 tests), imported through `@buildtrack/core`. It covers:
   - same scenario identity and format;
   - same scene identity, order and boundaries, to the millisecond;
   - caption cues exactly tiling each speech interval;
   - mapping of turn, clip, speaker, voice slot and reacting character;
   - word-for-word text;
   - alignment under a custom duration configuration;
   - refusal of foreign, format-, language-, scene-, turn- and timing-mismatched plans.
4. **Test floor** in `scripts/assert-test-count.mjs` raised from 240 to 300. The suite now has 355 tests; the floor is about 15% below that, as the script's policy states.

## Validation at checkpoint

`npm test` gives 355/355 across 16 files. `npm run typecheck`, `npm run build:core`, `npm run build`, the test-count check and `git diff --check` all pass. Lint is not configured.

## Resume notes

- Arena may reset the checkout to `d465cd3` between turns while leaving working files in place. Before any reset, compare the working tree to the expected commit using a temporary index.
- A reset also deletes `node_modules` and `.browser/`. Run `npm ci`, and run `npm run provision` if doctor needs Chromium.
- **Next phase: not started.** No rendering, audio synthesis, Remotion, API or UI work was done.
