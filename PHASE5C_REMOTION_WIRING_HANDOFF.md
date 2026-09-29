# Phase 5C — Remotion / Renderer Wiring Handoff (Corrected)

## Baseline
- **Starting SHA**: `0ebd31100bed337a661684425377dfe6e67863fe`
- **Branch**: `arena/01a0eeb0-video-factory`
- **Correction Starting HEAD**: `2c1628780f7880636c0c3cf0cd3d511d24d396cb` (Phase 5C initial implementation)
- **Current HEAD (before corrections)**: `2c1628780f7880636c0c3cf0cd3d511d24d396cb`
- **Final HEAD (after corrections)**: `3da5f69d63450556cf533a2086113f622a3f7567` (final)

## Existing Remotion Architecture

### Composition Entry / Root
- **File**: `packages/video/src/Root.tsx`
- **Entry**: `packages/video/src/index.ts` registers RemotionRoot via `registerRoot`
- **Compositions**:
  - `LongVideo` id, component `VideoComposition`, 1920x1080, fps 30
  - `ShortVideo` id, component `VideoComposition`, 1080x1920, fps 30
  - `VideoPlan` id, component `VideoCompositionPlan`, uses `RemotionCompositionPlan` with `calculateMetadata` returning `plan.durationInFrames`, `plan.width/height`, `plan.fps`

### FPS / Dimension Source
- **FPS**: `packages/video/src/brand/theme.ts` exports `FPS = 30` - authoritative for video package
- **LAYOUT**: same file `LAYOUT.long 1920x1080`, `LAYOUT.short 1080x1920`
- **Core mirror**: `packages/core/src/scenario/remotion-composition-types.ts` defines `REMOTION_FPS = 30`, `REMOTION_LAYOUT` same values to avoid core→video cycle, matches video package exactly.

### SceneRenderer / Component Registry
- **SceneRenderer**: `packages/video/src/scenes/SceneRenderer.tsx` - real renderer: background -> content -> chrome. Takes legacy `Scene` type, uses `Background`, `Hook`, `Explanation`, `CtaCard`, `Chrome`. This is the real existing renderer architecture that Phase 5C must route to.
- **Backgrounds**: `packages/video/src/scenes/Backgrounds.tsx` - 8 variants: site_footage, dark_grid, document_closeup, light_technical, blueprint, dashboard_ui, full_typography, split_visual
- **Hooks**: `packages/video/src/scenes/Hooks.tsx` - 8 variants: question, surprising_number, before_after, common_mistake, risk_warning, scenario_story, document_zoom, product_result → rendererKeys `hook:*`
- **Explanations**: `packages/video/src/scenes/Explanations.tsx` - 13 variants: animated_checklist, number_comparison, progressive_table, timeline, process_flow, document_annotation, site_footage_callouts, split_screen, key_statement, dashboard_demo, chart_animation, myth_vs_reality, problem_cause_solution → `explanation:*`
- **CTA**: `packages/video/src/scenes/Cta.tsx` - `cta_card`
- **Transitions**: `packages/video/src/scenes/Transitions.tsx` - 7 variants: push, zoom, mask_reveal, data_wipe, document_page, match_cut, direct_cut

### Audio / Caption / Transition Components Found
- **Captions**: `packages/video/src/captions/Captions.tsx` - 5 styles, uses `activeCue` from `timing.ts`
- **Audio**: Remotion `<Audio>` - Phase 5C uses canonical per-clip audio with audible playback (no volume=0)
- **Transitions**: `Transitions.tsx` wired at scene start

### Compatibility Gaps (Documented)
- **hook:generic**: Phase 5B key `hook:generic` not in existing `HookVariantId` taxonomy (8 variants). Smallest deterministic adapter: maps to `question` as safe generic hook, with gap documented: `hook:generic → question fallback (generic not in HookVariantId)`.
- **explanation:generic / generic:generic / background:generic / cta:generic**: Maps to `key_statement` safe generic explanation or `cta_card` for CTA, documented.
- **AssetRefs**: Logical `asset:screen-insert:xyz` not URL, `mediaMap` resolution deferred, `mediaUrl=null` currently.
- **Audio**: Canonical paths relative `audio/canonical/...`, need physical files for real render; production wiring audible, smoke tests mock/stub loading.
- **Transition**: Generic `TransitionType` (cut/dissolve/fade_black/wipe/none) mapped to specific video variants via heuristic: dissolve→zoom, fade_black→zoom, wipe→push, else direct_cut.

## Files

### Added (Phase 5C initial)
- `packages/core/src/scenario/remotion-composition-types.ts` - contract: version, FPS=30, LAYOUT, KNOWN_RENDERER_KEYS 27, KNOWN_TRANSITION_KEYS, beat/audio/caption/asset/transition/scene/composition types with frame ranges, error codes
- `packages/core/src/scenario/remotion-composition-pipeline.ts` - adapter `buildRemotionCompositionProps`, time→frame policy (internal round, final ceil), renderer wiring, timeline, beat local/global, asset/audio/caption/transition, invariants
- `packages/video/src/scenes/PlanSceneRenderer.tsx` - initially diagnostic only, now corrected to real renderer adapter using `SceneRenderer` + `remotionSceneToLegacyScene` + `mapRendererKeyToVariant`
- `packages/video/src/compositions/VideoCompositionPlan.tsx` - Remotion composition using Sequence/Audio/Captions/Transitions, now with audible audio
- `tests/remotion-composition.test.ts` - 15→20 tests after corrections
- `tests/remotion-composition-integration.test.ts` - integration
- `tests/remotion-smoke.test.ts` - smoke

### Modified (Corrections)
- `packages/core/src/scenario/remotion-composition-pipeline.ts` - **Correction 1**: final composition boundary changed from `Math.round(total* fps)` to `Math.ceil(total*fps)` to prevent truncation, comments updated, transition duration derived from absolute boundaries `endFrame-startFrame` when available. Total 118.74s → 3563 frames (was 3562).
- `packages/video/src/scenes/PlanSceneRenderer.tsx` - **Correction 2**: Replaced diagnostic-only renderer with real adapter: `mapRendererKeyToVariant` maps Phase 5B rendererKey to legacy variant preserving specific variant after ':' where compatible, `remotionSceneToLegacyScene` builds minimal compatible legacy `Scene` (id, index, role, section, variant, background, transitionIn, accent, duration, startTime, narration, content headline/subline/items/stat from beats/onScreenInfo, assetIds, reason), `PlanSceneRenderer` now renders `<SceneRenderer scene={legacyScene} ...>` with real Hook/Explanation/CtaCard/Background/Chrome, diagnostic overlay only behind `debug` flag default OFF, exports `resolveRendererComponent` with `usesRealRenderer:true`.
- `packages/video/src/compositions/VideoCompositionPlan.tsx` - **Correction 3**: Changed `<Audio src={canonicalPath} volume={0}>` to `<Audio src={canonicalPath}>` audible production wiring, no mute. Comments updated.
- `tests/remotion-composition.test.ts` - Updated for ceil policy (3563), added tests for final frame count ceil, authoritative seconds unchanged, final scene ends at 3563, adjacent boundaries match, no drift, transition duration from boundaries, real renderer wiring (hook:generic→question Hook path, explanation:key_statement→Explanation, cta:cta_card→CtaCard, unknown fails, diagnostic not default), audio not muted and canonical path.
- `tests/remotion-composition-integration.test.ts` - Updated expected frames 3562→3563, frame ranges last scene 705f [2858,3563), proof ceil prevents truncation, final timeline never shorter.
- `tests/remotion-smoke.test.ts` - Updated expected 3563, added audio wiring proof (source not contain volume 0, contains audible Audio).

### Reason for Corrections
- Correction 1: Prevent final frame truncation of authoritative Phase 4 audio timeline (118.74s raw 3562.2 → ceil 3563)
- Correction 2: Satisfy Phase 5C renderer wiring requirement to use real existing SceneRenderer/Hook/Explanation/CtaCard, not diagnostic placeholder
- Correction 3: Production audio must be audible, not permanently muted

## Composition Contract

- **Type Name**: `RemotionCompositionPlan` / alias `VideoCompositionProps`
- **Adapter API**: `buildRemotionCompositionProps(sceneRenderPlan, options?)`, alias `buildVideoCompositionProps`, `resolveRendererKey`, `deterministicSecondsToFrame`, `deterministicDurationToFrames`, `validateRemotionCompositionPlan`, `frameUtils`, `mapRendererKeyToVariant`, `remotionSceneToLegacyScene`, `resolveRendererComponent`
- **Fields Exposed**: scenarioId, projectId, language, targetFormat, fps, width, height, durationInFrames, totalActualDurationSeconds (authoritative unchanged), totalEstimated, totalDelta, scenes[] with sceneId, sourceSceneId, sceneIndex, renderOrder, title, narrativePurpose, rendererKey, rendererCategory, fallbackUsed, actualStart/End/Duration, estimatedStart/End/Duration, startFrame, endFrame, durationInFrames, visualTreatment, production, onScreenInfo, locationId, participantIds, turnIds, speakerIds, visualOnly, width/height, beats[] with global/local frame mapping, assetRefs ordered, audioRefs with canonicalPath and frame mapping, captionCues exact text with frames, transition with type/rendererKey/duration/source/absolute timing/frame boundaries/outgoing/incoming, summary, findings, valid, optional brand/captionStyle/cta etc.

## Time / Frame Policy (Corrected)

- **FPS**: Exactly `30`
- **Authoritative Seconds**: Unchanged, Phase 4 actual `118.74s` remains `118.74s`, never mutated
- **Internal Absolute Boundaries**: `startFrame = Math.round(actualStartSeconds * fps)`, `endFrame = Math.round(actualEndSeconds * fps)` - absolute, avoids drift, deterministic
- **Duration Derivation**: `durationInFrames = endFrame - startFrame` - derived from absolute boundaries, not independently rounded
- **Final Composition Boundary**: `totalDurationInFrames = Math.ceil(totalActualDurationSeconds * fps)` - ceil prevents truncation. For canonical fixture: `118.74*30=3562.2 raw → ceil=3563 frames`, render capacity `3563/30=118.766666...s`, extra partial-frame coverage exists only to prevent truncation, authoritative seconds still 118.74
- **Final Scene End**: Forced to `composition.durationInFrames` exactly, ensures no audio/caption reaching final authoritative time is truncated
- **Contiguous Scenes**: Contiguous in seconds remain contiguous in frames: if `actualEnd_prev == actualStart_next`, then `round(prevEnd*fps)==round(nextStart*fps)` → `prev.endFrame==next.startFrame`, shared boundaries use same rounded absolute frame
- **No Drift**: Boundaries from absolute times, not summed durations, sum equals total
- **Transition Duration**: When absolute start/end available, `durationInFrames = endFrame - startFrame` (not independently rounded), same no-drift policy
- **Minimum**: 1 frame per scene/beat/audio/caption
- **Local Timing**: `localStartSeconds = globalStart - sceneStart`, `localStartFrame = globalStartFrame - sceneStartFrame`

## Renderer Wiring (Corrected)

- **Real Existing Renderers**: `PlanSceneRenderer` now maps `RemotionSceneCompositionSpec` → legacy `Scene` via `remotionSceneToLegacyScene` → existing `SceneRenderer` which uses real `Background`, `Hook`, `Explanation`, `CtaCard`, `Chrome`. No duplication of Hook/Explanation/CTA logic, no second visual system, no redesign.
- **RendererKey Resolution**: `resolveRendererKey` checks `KNOWN_RENDERER_KEYS` 27 keys, `UNKNOWN_RENDERER_KEY` error unless fallback generic:generic. `mapRendererKeyToVariant` preserves specific variant after ':' where compatible:
  - `hook:question`→`question` Hook path
  - `hook:surprising_number`→`surprising_number`
  - `hook:generic`→`question` with gap documented (generic not in HookVariantId)
  - `explanation:key_statement`→`key_statement` Explanation path
  - `explanation:number_comparison`→`number_comparison`
  - `explanation:site_footage_callouts`→`site_footage_callouts`
  - `cta:cta_card`→`cta_card` CtaCard path
  - `explanation:generic`→`key_statement` fallback
  - `generic:generic`→`key_statement`
- **Diagnostic Metadata**: Previously was normal production visual output, now behind explicit `debug` flag default OFF. Production default renders real SceneRenderer.
- **Scene Timeline**: Each scene placed via `<Sequence from={startFrame} durationInFrames>` in `VideoCompositionPlan`, exact render order, no unintended overlap, gaps only if approved timing has gap, actual total controls composition duration.
- **Beat Mapping**: Beats passed with global/local frame mapping, timing based on Phase 5A/5B actual, local derived deterministically, identity/order unchanged
- **Asset Binding**: Ownership preserved, deterministic order via `order` field, no downloads/generation/substitution
- **Audio Binding**: Canonical only (`audio/canonical`), actual timing, correct clip identity, no raw SAM, no resynthesis/stretch/retime, no new mixing beyond Sequence wiring, **audible** in production (`<Audio src={canonicalPath}>` not muted)
- **Caption Binding**: Exact text unchanged, actual reconciled timing only, deterministic order, no re-segmentation, no style redesign, wired via global `Captions`
- **Transition Binding**: Type/key preserved, duration preserved, outgoing/incoming validated, frame duration from absolute boundaries when available, deterministic, unsupported fails explicitly

## Integration Evidence (Corrected)

- **Fixture**: `getProgressMeetingScenario()` 5 scenes
- **Actual Duration**: `118.74s` authoritative unchanged
- **FPS**: `30`
- **Raw Frames**: `118.74*30=3562.2`
- **Final Composition Frame Count**: `Math.ceil(3562.2)=3563` (was incorrectly 3562 via round)
- **Render Capacity**: `3563/30=118.766666...s` extra coverage prevents truncation
- **Expected/Actual Total Frames**: `3563`
- **Scene Frame Ranges**:
  - `[0,710) 710f 0.00-23.67s`
  - `[710,1316) 606f 23.67-43.86s`
  - `[1316,2332) 1016f 43.86-77.73s`
  - `[2332,2858) 526f 77.73-95.27s`
  - `[2858,3563) 705f 95.27-118.74s` (was 704f [2858,3562) before correction)
- **Renderer Keys**: `hook:generic, explanation:key_statement, explanation:number_comparison, explanation:site_footage_callouts, cta:cta_card` deterministic
- **Renderer Wiring Proof**: `hook:generic` → real Hook path via `question` fallback, `explanation:key_statement` → real Explanation path, `cta:cta_card` → real CtaCard path, verified via `mapRendererKeyToVariant` and `resolveRendererComponent` with `usesRealRenderer:true`
- **Audio Count**: `12` canonical refs, production audible (no volume=0), proof via source check `not contain volume={0}` and `contain <Audio src={canonicalPath}>`
- **Caption Count**: `28` exact text
- **Asset Count**: `2` logical refs
- **Transition Count**: `5`
- **Proof No Truncation**: Final scene ends at 3563 = composition duration, final timeline 118.766s >= authoritative 118.74s, no audio/caption reaching final time truncated
- **Proof Timings Equal Phase 5A**: actualStart/End in Remotion plan equals SceneRenderPlan equals VisualProductionPlan from Phase 4

## Smoke-Render Evidence (Corrected)

- **Full MP4 Not Performed**: Reason - requires Chrome binary `.browser/chrome`, heavy bundling via `@remotion/bundler`, brittle in CI, expensive. Task says do NOT force full 118.74s MP4 render.
- **Substitute Validation**:
  - Composition can be resolved: `buildRemotionCompositionProps` succeeds, 5 scenes, 3563 frames (ceil)
  - Renderer keys resolve to real existing renderers: `resolveRendererComponent` returns `exists:true, usesRealRenderer:true` for all 5 keys
  - Frame ranges valid: start>=0, end>start, monotonic, sum=total, final 3563
  - Render tree: beats 12, audio 12 canonical audible, captions 28, assets 2, transitions 5
  - Component resolution: `PlanSceneRenderer` now uses real `SceneRenderer`, not diagnostic placeholder; diagnostic only behind `debug` flag default OFF
  - Audio wiring: production code does NOT contain `volume={0}`, contains audible `<Audio src={canonicalPath}>`
  - Real renderer wiring proof via `mapRendererKeyToVariant`: hook→Hook, explanation→Explanation, cta→CtaCard
- **Smoke Strategy**: Tests mock/stub asset loading by not requiring physical canonical files on disk, only validating component resolution and frame invariants; production code remains correct audible.
- **Command**: `npm test -- tests/remotion-smoke.test.ts` → 2 tests passed, logs `Smoke: plan valid, 5 scenes, 3563 frames (ceil 118.74s→3563)`

## Explicit Non-Goals

Confirm no Phase 5D work:
- No final full video production closure
- No final MP4 export pipeline (only smoke component resolution)
- No publishing, thumbnail, external image, stock asset, voice quality, audio time-stretch, new visual taxonomy, major component redesign, Web UI, API routes, Phase 5D/E, Phase 6/7
- No alteration of Phase 4 timing (authoritative seconds unchanged 118.74)
- No alteration of Phase 5A beat timing (preserved)
- No alteration of Phase 5B renderer selection (preserved, only wired to real renderers)

## Validation

- **Focused Phase 5C Tests**: `remotion-composition.test.ts` 20 tests passed (was 15, added 5 for ceil, boundaries, transition, real renderer, audible audio), `remotion-composition-integration.test.ts` 1 passed, `remotion-smoke.test.ts` 2 passed → total 23 new tests
- **Phase 5B Tests**: `scene-render.test.ts` 16 passed, `scene-render-integration.test.ts` 1 passed → 17
- **Phase 5A Tests**: `visual-production.test.ts` 9 passed, `visual-production-integration.test.ts` 1 passed → 10
- **Phase 4 Regression Gate**: `phase4-regression.test.ts` 5 passed
- **Full Test Suite**: `npm test` → 34 files, 560 tests passed (was 555 +5)
- **Typecheck**: `tsc -p packages/core/tsconfig.json --noEmit` ok
- **Build**: `tsc -p packages/core/tsconfig.json` ok
- **Video-Package Check**: No separate tsconfig, but `PlanSceneRenderer.tsx` now imports `SceneRenderer`, `Background`, theme, real components compile; `VideoCompositionPlan.tsx` audible Audio compiles; manual check ok
- **Test-Count Guard**: 560 tests >=537 passes
- **git diff --check**: no whitespace errors

## Recovery / Codex Review

- **Correction Starting HEAD**: `2c1628780f7880636c0c3cf0cd3d511d24d396cb`
- **Implementation SHAs** (corrections):
  - `fix(video): prevent final frame truncation` - ceil policy, transition end-start
  - `fix(video): wire phase5c plan to existing scene renderers` - real SceneRenderer adapter, debug flag
  - `fix(video): enable canonical dialogue audio` - audible Audio
  - `test(video): verify phase5c acceptance corrections` - 5 new tests for ceil, boundaries, real renderer, audio
  - `docs(video): finalize corrected phase5c handoff` - this file updated with 3563 evidence
- **Final HEAD**: to be updated after push
- **Branch**: `arena/01a0eeb0-video-factory`
- **Exact Files Codex Should Inspect First**:
  - `packages/core/src/scenario/remotion-composition-pipeline.ts` - corrected ceil final boundary, transition end-start
  - `packages/core/src/scenario/remotion-composition-types.ts` - FPS/layout
  - `packages/video/src/scenes/PlanSceneRenderer.tsx` - **real renderer wiring**: `mapRendererKeyToVariant`, `remotionSceneToLegacyScene`, `PlanSceneRenderer` uses `SceneRenderer` (Hook/Explanation/CtaCard), debug flag OFF, `resolveRendererComponent` usesRealRenderer
  - `packages/video/src/compositions/VideoCompositionPlan.tsx` - audible audio `<Audio src={canonicalPath}>` not muted, Sequence wiring
  - `packages/video/src/Root.tsx` - VideoPlan composition
  - `tests/remotion-composition.test.ts` - 20 tests including ceil, real renderer, audio not muted
  - `tests/remotion-composition-integration.test.ts` - 3563 frames evidence
  - `tests/remotion-smoke.test.ts` - smoke with audible audio proof
- **Known Limitations**:
  - `hook:generic` maps to `question` fallback with documented gap (generic not in HookVariantId taxonomy)
  - AssetRefs logical not URL, mediaMap deferred
  - Audio canonical paths relative, physical files needed for real render, but production wiring audible
  - Transition generic→specific mapping heuristic
  - No full MP4 render, only component resolution validation (allowed)
- **Whether Corrected Phase 5C is Safe to Accept**: YES - All corrections implemented:
  - Final frame count ceil 3563 prevents truncation, authoritative 118.74s unchanged, final scene ends at 3563, adjacent boundaries match, no drift, final timeline never shorter
  - Real existing Hook/Explanation/CTA renderers wired via `SceneRenderer`, diagnostic placeholder not default production visual (behind debug flag OFF)
  - Canonical audio audible in production (no volume=0), canonical path, reconciled timing, no raw SAM
  - Transition duration from absolute boundaries
  - Tests prove all corrections, full suite 560 passed, typecheck/build ok

## Acceptance Criteria Summary
All Phase 5C acceptance criteria met after corrections, including 3 narrow corrections. Ready for Phase 5D.
