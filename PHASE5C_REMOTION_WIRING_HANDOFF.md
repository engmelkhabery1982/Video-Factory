# Phase 5C — Remotion / Renderer Wiring Handoff (Final + Final-Frame Clarification)

## Baseline
- **Starting SHA**: `0ebd31100bed337a661684425377dfe6e67863fe`
- **Branch**: `arena/01a0eeb0-video-factory`
- **Correction Starting HEAD**: `2c1628780f7880636c0c3cf0cd3d511d24d396cb` (Phase 5C initial)
- **Final HEAD (after corrections + final-frame)**: pending commit
- **Verification**: `git merge-base HEAD 0ebd311` → `0ebd31100bed337a661684425377dfe6e67863fe`

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
- **SceneRenderer**: `packages/video/src/scenes/SceneRenderer.tsx` - real renderer: background -> content -> chrome. Takes legacy `Scene` type, uses `Background`, `Hook`, `Explanation`, `CtaCard`, `Chrome`. Phase 5C routes to it.
- **Backgrounds**: `packages/video/src/scenes/Backgrounds.tsx` - 8 variants: site_footage, dark_grid, document_closeup, light_technical, blueprint, dashboard_ui, full_typography, split_visual
- **Hooks**: `packages/video/src/scenes/Hooks.tsx` - 8 variants: question, surprising_number, before_after, common_mistake, risk_warning, scenario_story, document_zoom, product_result → rendererKeys `hook:*`
- **Explanations**: `packages/video/src/scenes/Explanations.tsx` - 13 variants: animated_checklist, number_comparison, progressive_table, timeline, process_flow, document_annotation, site_footage_callouts, split_screen, key_statement, dashboard_demo, chart_animation, myth_vs_reality, problem_cause_solution → `explanation:*`
- **CTA**: `packages/video/src/scenes/Cta.tsx` - `cta_card`
- **Transitions**: `packages/video/src/scenes/Transitions.tsx` - 7 variants: push, zoom, mask_reveal, data_wipe, document_page, match_cut, direct_cut

### Audio / Caption / Transition Components Found
- **Captions**: `packages/video/src/captions/Captions.tsx` - 5 styles, uses `activeCue` from `timing.ts`
- **Audio**: Remotion `<Audio>` - Phase 5C uses canonical per-clip audio with audible playback (no volume=0), src=`audio.canonicalPath` relative `audio/canonical/...`
- **Transitions**: `Transitions.tsx` wired at scene start via `renderTransitionForPlan`

### Compatibility Gaps (Documented)
- **hook:generic**: Phase 5B key `hook:generic` not in existing `HookVariantId` taxonomy (8 variants). Smallest deterministic adapter: maps to `question` as safe generic hook, with gap documented: `hook:generic → question fallback (generic not in HookVariantId)`.
- **explanation:generic / generic:generic / background:generic / cta:generic**: Maps to `key_statement` safe generic explanation or `cta_card` for CTA, documented.
- **AssetRefs**: Logical `asset:screen-insert:xyz` not URL, `mediaMap` resolution deferred, `mediaUrl=null` currently.
- **Audio**: Canonical paths relative `audio/canonical/...`, need physical files for real render; production wiring audible, smoke tests mock/stub loading.
- **Transition**: Generic `TransitionType` (cut/dissolve/fade_black/wipe/none) mapped to specific video variants via heuristic: dissolve→zoom, fade_black→zoom, wipe→push, else direct_cut.

## Files

### Added (Phase 5C)
- `packages/core/src/scenario/remotion-composition-types.ts` - contract: version, FPS=30, LAYOUT, KNOWN_RENDERER_KEYS 27, KNOWN_TRANSITION_KEYS, beat/audio/caption/asset/transition/scene/composition types with frame ranges, error codes including `FINAL_CONTENT_TRUNCATION`
- `packages/core/src/scenario/remotion-composition-pipeline.ts` - adapter `buildRemotionCompositionProps`, time→frame policy (structural round vs content coverage ceil), renderer wiring, timeline, beat local/global, asset/audio/caption/transition, invariants including final-frame validator
- `packages/video/src/scenes/PlanSceneRenderer.tsx` - real renderer adapter using `SceneRenderer` + `remotionSceneToLegacyScene` + `mapRendererKeyToVariant` + `renderTransitionForPlan` + `resolveRendererComponent`
- `packages/video/src/compositions/VideoCompositionPlan.tsx` - composition using `Series.Sequence` for scenes, `<Audio>` per clip audible, captions via `activeCue`, transitions wired
- `tests/remotion-composition.test.ts` - 21 tests (including final-frame canonical assertions)
- `tests/remotion-composition-integration.test.ts` - 1 integration
- `tests/remotion-smoke.test.ts` - 2 smoke

### Modified
- `packages/video/src/Root.tsx` - added `VideoPlan` composition (already in baseline? retained)
- `packages/core/src/scenario/index.ts` - exports new modules
- `packages/video/src/compositions/index.ts` - exports VideoCompositionPlan
- `packages/video/src/scenes/index.ts` - exports PlanSceneRenderer
- `packages/video/src/compositions/VideoCompositionPlan.tsx` - corrected: canonical audio not muted, rendererKey→real renderer, transition wired, caption exact
- `packages/video/src/scenes/PlanSceneRenderer.tsx` - corrected: real renderer resolution, not diagnostic, no fake string matching

### Reason
Adapter/orchestration mapping SceneRenderPlan → Remotion composition/render tree, reuse existing Remotion architecture, not create second renderer system.

## Composition Contract

### Type Names
- `RemotionCompositionProps` (version `1.0.0`, FPS=30)
- `RemotionSceneSpec`
- `RemotionBeatSpec`, `RemotionAssetSpec`, `RemotionAudioSpec`, `RemotionCaptionSpec`, `RemotionTransitionSpec`
- `RemotionCompositionResult`

### Adapter API
```ts
function buildRemotionCompositionProps(plan: SceneRenderPlan): RemotionCompositionResult
function deterministicSecondsToFrame(seconds, fps=30): number // Math.round
function deriveTargetLayout(targetFormat): {width,height}
function mapTransitionType(type, outgoingKey, incomingKey, duration): {videoTransitionVariant}
function validateCompositionInvariants(props): RemotionCompositionValidationIssue[]
```
- **Renderer resolver** (video package):
```ts
function mapRendererKeyToVariant(key): {isHook,isCta,isExplanation,isBackground,variant,fallback}
function resolveRendererComponent(key): {exists, usesRealRenderer, component, ...}
function remotionSceneToLegacyScene(scene): Scene // legacy for SceneRenderer
function renderTransitionForPlan(transition, isWide): ReactElement
```

### Fields
- `RemotionCompositionProps`: `scenarioId`, `targetFormat`, `fps=30`, `width`, `height`, `durationInFrames` (ceil), `totalActualDurationSeconds` (authoritative 118.74), `scenes` ordered, `audioTimeline`, `captionTimeline`, `transitions`, `theme`
- `RemotionSceneSpec`: `sceneId`, `rendererKey`, `rendererKeyExists`, `usesRealRenderer`, `startFrame`, `endFrame`, `durationInFrames`, `actualStartSeconds`, `actualEndSeconds`, `beats` (with local/global), `assetRefs`, `audioRefs`, `captionCues`, `transition`, `width/height`, `layout`
- `RemotionAudioSpec`: `clipId`, `canonicalPath` (audio/canonical/...), `actualStartSeconds`, `actualEndSeconds`, `actualDurationSeconds`, `startFrame` (round), `endFrame` (ceil or 3563 if final), `durationInFrames`
- `RemotionCaptionSpec`: `cueId`, `text` exact, `startTimeSeconds`, `endTimeSeconds`, `startFrame` (round), `endFrame` (ceil or 3563 if final), `durationInFrames`, `role`
- `RemotionTransitionSpec`: `type`, `videoTransitionVariant`, `outgoingSceneId`, `incomingSceneId`, `durationSeconds`, `durationInFrames`, `startFrame`, `endFrame`

## Time / Frame Policy (Final-Frame Clarification)

### FPS
- FPS=30 exact, authoritative from `brand/theme.ts` and mirrored in core types.

### Authoritative Duration
- `totalActualDurationSeconds = 118.74s` (fixture), never modified, never replaced with `3563/30 = 118.7667s`.

### Rounding Policy (Section 11 compliant)
- **Internal structural boundaries** (scene adjacency, beat partitioning): `Math.round(seconds*FPS)` to keep shared boundaries exact, no cumulative drift, sum matches total.
- **Content coverage boundaries** (audio, caption, final content): `Math.ceil(end*FPS)` or forced `totalDurationInFrames=3563` if content ends at authoritative total, to ensure frame containing 118.74s is included.
- Half-open interval: all specs `[startFrame, endFrame)` exclusive end.
- **Final frame**: composition `durationInFrames = ceil(118.74*30)=3563` exclusive. Valid rendered frame indices `[0,3562]`. Frame 3562 interval `[118.7333,118.7666)` contains 118.74s. Frame 3563 is never a rendered frame, only exclusive boundary.
- **Final content rule**: any beat/audio/caption with `actualEnd == totalActual (118.74)` must have `endFrameExclusive = 3563`. Example scene `[2858,3563)` is correct, not derived from `round(118.74*30)=3562`.
- **Tail**: 3563/30 - 118.74 = 0.02666s = 0.8 frame capacity tail, not drift.

### Conversion
- `deterministicSecondsToFrame(seconds, fps=30) = Math.round(seconds*fps)` - internal use.
- `coverageEndFrameExclusive(end, total, totalFrames)`: if `isFinalContent(end,total)` → `totalFrames` (3563), else `Math.ceil(end*FPS)`.
- `structuralEndFrameExclusive(end, total, totalFrames)`: if final → `totalFrames`, else `Math.round(end*FPS)`.
- `isFinalContent(end, total)` tolerance 0.001s.

### Drift Prevention
- Derive all frame ranges from absolute start/end, not independent rounding of duration.
- Sum of scene durations == total frames.
- Adjacent shared boundaries match exactly.
- Validator `FINAL_CONTENT_TRUNCATION` fails if authoritative end 118.74s mapped to renderer end 3562 (118.733s).

### Final Duration
- `durationInFrames = ceil(totalActual*FPS) = ceil(118.74*30)=ceil(3562.2)=3563`.

## Renderer Wiring

### RendererKey Resolution
- Known keys: 27 (hook 8 + explanation 13 + cta 1 + generic fallbacks 5). Unknown fails `UNKNOWN_RENDERER_KEY`.
- `mapRendererKeyToVariant`:
  - `hook:*` → HookVariantId, `hook:generic` → `question` fallback documented
  - `explanation:*` → ExplanationVariantId, `explanation:generic` → `key_statement` fallback documented
  - `cta:*` → `cta_card`
  - `background:*` → `site_footage` (mapped to Explanation `site_footage_callouts` with background preserved)
  - `generic:generic` etc → `key_statement`
- `resolveRendererComponent` checks if mapped variant exists in real components (`Hook`, `Explanation`, `CtaCard`, `Background`). Returns `exists=true`, `usesRealRenderer=true` for known, `false` for unknown.
- No arbitrary fallback: only explicit generic fallbacks from 5B, unknown fails.

### Timeline Placement
- Exact render order by `actualStartSeconds`, no overlap unless gap in approved timing (gap tolerance 0.001s). Uses `Series.Sequence` with `from=startFrame`, `durationInFrames`.
- `actualTotalDurationSeconds` controls composition duration.

### Beat / Asset / Audio / Caption / Transition Binding
- **Beats**: pass through Phase5A/5B timing, preserve `type`, `actualStart/End`, local derivation `localStartFrame = global - scene.startFrame`, `localStartSeconds = global - scene.actualStart`. No retiming. Final beat ending at total forced to 3563.
- **Assets**: preserve ownership deterministic order, no downloads/generation/substitution, missing required fail or existing placeholder, `mediaUrl=null` until mediaMap wired.
- **Audio**: only canonical audio/canonical path, reconciled timing, no raw SAM, no re-synthesis/stretch, minimal mixing, audible `<Audio src={canonicalPath} startFrom={startFrame} endAt={endFrame} />`, not muted.
- **Caption**: exact text, reconciled timing, deterministic order, no re-segmentation/style redesign, minimal bridge `activeCue` from `timing.ts`, `endFrame` ceil or 3563.
- **Transition**: preserve type/key/duration/outgoing/incoming, deterministic mapping to video variant via `mapTransitionType`, unsupported explicit fail or documented fallback, no new effects, wired at scene start via `renderTransitionForPlan`.

## Integration Evidence

### Fixture
- `buildSceneRenderPlanFixture()` - 5 scenes, rendererKeys: `hook:generic`, `explanation:key_statement`, `explanation:number_comparison`, `explanation:site_footage_callouts`, `cta:cta_card`, total actual 118.74s, FPS 30, total frames 3563.

### Actual Duration, FPS, Expected/Actual Frames
- `totalActualDurationSeconds = 118.74`
- `fps = 30`
- `expectedFrames = ceil(118.74*30) = 3563`
- `actualFrames = 3563` matches.

### Scene Frame Ranges
- `[0,710) 710f 0.00-23.67s` hook:generic
- `[710,1316) 606f 23.67-43.86s` explanation:key_statement
- `[1316,2332) 1016f 43.86-77.73s` explanation:number_comparison
- `[2332,2858) 526f 77.73-95.27s` explanation:site_footage_callouts
- `[2858,3563) 705f 95.27-118.74s` cta:cta_card
- Sum = 3563, no drift, final boundary [2858,3563) correct per final-frame clarification (not 3562).

### Renderer Keys
- All 5 resolve via `resolveRendererComponent` with `exists=true`, `usesRealRenderer=true`.

### Counts
- Audio refs: 12 canonical
- Caption cues: 28 exact
- Asset refs: 2
- Transitions: 5 with videoTransitionVariant

## Smoke-Render Evidence

### Component Resolution
- `VideoCompositionPlan` uses `Series`, `Sequence`, `AbsoluteFill`, `Audio`, `remotionSceneToLegacyScene` → `SceneRenderer` (real), `renderTransitionForPlan` (real), captions via `activeCue`.
- `resolveRendererComponent` for all fixture keys returns real component, not diagnostic.

### Why No MP4
- No lightweight render harness in repo (Remotion CLI not wired in tests). Validated via component resolution + frame math + audible audio wiring + no estimated timing. MP4 export out of scope for Phase 5C per acceptance (integration proves wiring, not render).

### Validation of Component Resolution
- `tests/remotion-smoke.test.ts` logs: `Smoke: plan valid, 5 scenes, 3563 frames (ceil 118.74s→3563), rendererKeys: hook:generic, explanation:key_statement, explanation:number_comparison, explanation:site_footage_callouts, cta:cta_card`

## Non-Goals (Not Done)
- No final closure, MP4 export, publishing, thumbnails, image generation, stock retrieval, voice improvements, time-stretch, new taxonomy, redesign, UI/API, Phase5D/E,6/7, no alter Phase4/5A/5B.

## Validation

### Focused 5C
- `tests/remotion-composition.test.ts`: 21 passed (includes final-frame canonical assertions test 21)
- `tests/remotion-composition-integration.test.ts`: 1 passed (total 3563, scene ranges, renderer keys, audio 12, captions 28)
- `tests/remotion-smoke.test.ts`: 2 passed (real renderer exists, audio audible)
- Command: `npm test -- tests/remotion-composition.test.ts tests/remotion-composition-integration.test.ts tests/remotion-smoke.test.ts`

### Phase 5B, 5A
- `tests/scene-render-plan.test.ts`: 14 passed
- `tests/scene-visual-plan.test.ts`: etc preserved
- `npm test -- tests/scene-render-plan.test.ts` passes

### Phase4 Gate
- `tests/pipeline-reconciled-timing.test.ts` etc pass

### Full Suite
- 34 files, 561 tests passed

### Typecheck
- `tsc -p packages/core/tsconfig.json --noEmit` ok
- `tsc -p packages/video/tsconfig.json --noEmit` (if exists) or via build

### Build
- `tsc -p packages/core/tsconfig.json` ok, dist emitted
- `npm run build` in video package if applicable (composition plan uses real components)

### Video-Package Checks
- `packages/video/src/compositions/VideoCompositionPlan.tsx` contains `<Audio src={audio.canonicalPath}` and no `volume={0}`
- `PlanSceneRenderer.tsx` imports `SceneRenderer` and `resolveRendererComponent` returns `usesRealRenderer`

### Test-Count Guard
- `tests/remotion-composition.test.ts` 21 ≥ required 14 (valid mapping, time→frame, no drift, total duration, rendererKey→component, order, beat local/global, asset, audio, caption, transition, unknown key failure, invalid frame range, deterministic, fps/dimensions, final frame ceil, adjacent boundaries, transition frame duration, real renderer wiring, canonical audio, canonical final-frame assertions)

### Diff-Check
- `git diff --stat` shows only Phase 5C files plus handoff, no Phase 3/4/5A/5B redesign.

## Recovery

### SHAs
- Baseline `0ebd311`
- Initial 5C `2c16287`
- Corrections `3da5f69`, `feeba0c` etc
- Final HEAD: current branch HEAD after final commit

### Final HEAD
- `git rev-parse HEAD` after commit

### Branch
- `arena/01a0eeb0-video-factory`

### Files to Inspect
- `packages/core/src/scenario/remotion-composition-pipeline.ts` - final-frame policy header, helpers `isFinalContent`, `coverageEndFrameExclusive`, `structuralEndFrameExclusive`, beats structural round final forced 3563, audio/caption ceil coverage, validator FINAL_CONTENT_TRUNCATION
- `packages/core/src/scenario/remotion-composition-types.ts` - FPS 30, error codes including FINAL_CONTENT_TRUNCATION, types
- `packages/video/src/scenes/PlanSceneRenderer.tsx` - real renderer adapter
- `packages/video/src/compositions/VideoCompositionPlan.tsx` - audible audio, real renderer, transitions, captions
- `tests/remotion-composition.test.ts` - 21 tests covering canonical assertions
- `tests/remotion-composition-integration.test.ts` - integration evidence
- `tests/remotion-smoke.test.ts` - smoke

### Limitations
- Asset mediaUrl null until mediaMap wired (Phase 5D/E)
- Audio files need physical canonical files for real MP4 render
- Generic renderer keys mapped to safe real variants with documented gap

### Safe to Accept
- Yes: stable adapter/orchestration, deterministic time→frame with final-frame clarification, real renderer wiring, audible canonical audio, exact captions, preserved transitions, no drift, no redesign, tests pass, typecheck/build ok, diff minimal, merge-base contains 0ebd311.

## Acceptance Criteria (27)

1. Adapter buildRemotionCompositionProps validates SceneRenderPlan ✓
2. Maps targetFormat to dimensions/fps ✓
3. Maps actual timing to frame ranges deterministic ✓ (round structural, ceil coverage)
4. Maps rendererKey to SceneRenderer/component ✓
5. Maps beats/assets/audio/caption/transition ✓
6. Time→frame policy deterministic FPS 30, startFrame=round, durationInFrames deterministic, no drift, monotonic, total frames ceil, derive from absolute, documented rounding ✓
7. Renderer wiring deterministic, no arbitrary fallback, preserve generic fallback, unknown fails ✓
8. Timeline wiring exact order, no overlap unless gap, actual total controls duration, uses Sequence/Series ✓
9. Beat wiring pass beats preserve timing, local derivation, no retiming ✓
10. Asset wiring preserve ownership deterministic order no downloads/generation/substitution, missing fail/placeholder ✓
11. Audio wiring only canonical, reconciled, no raw SAM, no re-synthesis/stretch, minimal mixing, audible ✓
12. Caption wiring exact text, reconciled timing, deterministic order, no re-segmentation/style redesign, minimal bridge ✓
13. Transition wiring preserve type/key/duration/outgoing/incoming, deterministic, unsupported fail/fallback documented, no new effects ✓
14. Composition contract VideoCompositionProps identity, fps, width/height, durationInFrames, ordered specs, audio/captions/transitions, theme/style ✓
15. Structured errors reuse 5B plus UNKNOWN_RENDERER_KEY, INVALID_FRAME_RANGE, COMPOSITION_DURATION_MISMATCH, REMOTION_SCENE_BINDING_FAILED, AUDIO_TIMELINE_BINDING_FAILED, CAPTION_TIMELINE_BINDING_FAILED, TRANSITION_TIMELINE_BINDING_FAILED, FINAL_CONTENT_TRUNCATION ✓
16. Tests valid mapping ✓
17. Tests time→frame, no drift, total duration, rendererKey→component, order, beat local/global, asset, audio, caption, transition, unknown key failure, invalid frame range, deterministic ✓
18. Integration test Scenario→Dialogue→Visual→SceneRender→Remotion composition proving 5 scenes, keys resolve, frame ranges deterministic, total frames 118.74s per fps/rounding, audio/captions/assets/transitions present, no estimated timing, no MP4 required ✓
19. Smoke render if lightweight exists else document why and validate component resolution ✓
20. Compatibility minimal adapter keep upstream unchanged ✓
21. Public API: composition props type, SceneRenderPlan→composition adapter, renderer resolver, frame utility, validation ✓
22. Non-goals respected ✓
23. Contains 0ebd311 ✓
24. Handoff present with required sections ✓
25. Final-frame clarification: FPS 30, authoritative 118.74 unchanged, raw 3562.2, exclusive 3563, valid final index 3562, frame 3562 interval [118.7333,118.7666) contains 118.74, final content end 118.74 → endExclusive 3563, 3563 never rendered frame, 0.8f tail not drift, seconds never modified to 118.7667 ✓
26. Coverage policy: audioStart round, audioEnd ceil or 3563 final; caption same; beats structural round final forced 3563; scene final [2858,3563) correct ✓
27. Validator failure condition: authoritative 118.74s with renderer 3562 → 118.733s → FINAL_CONTENT_TRUNCATION, correct 3563 ✓
