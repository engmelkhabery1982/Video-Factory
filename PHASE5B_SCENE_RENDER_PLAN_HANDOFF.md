# Phase 5B — Scene / Visual Plan Integration Handoff

## Baseline
- Starting SHA: `73a44b06317add517ed1ab821620cad5f1287aec`
- Branch: `arena/01a0eeb0-video-factory`
- Current HEAD: `e121fbf970c4a3772f365acdde558792a95aaa6e` (final)

## Files

### Added
- `packages/core/src/scenario/scene-render-types.ts` — Canonical SceneRenderPlan contract. Reason: Define renderer-ready scene specification for future Phase 5C wiring, containing scenarioId, sceneId, sceneIndex/renderOrder, actual start/end/duration authoritative, renderer key/category, visual treatment/background reference, visual beats with actual timing preserved, asset references, canonical audio references, caption references, transition reference, speaker/character references, targetFormat/dimensions info, deterministic summary, findings, structured errors (UNSUPPORTED_SCENE_TYPE, RENDERER_MAPPING_MISSING, RENDERER_MAPPING_INVALID, SCENE_RENDER_INVARIANT_FAILED, ASSET_BINDING_MISMATCH, AUDIO_BINDING_MISMATCH, CAPTION_BINDING_MISMATCH, TRANSITION_BINDING_INVALID, DUPLICATE_RENDER_ORDER, etc.)
- `packages/core/src/scenario/scene-render-pipeline.ts` — Scene render mapping pipeline. Reason: Implement deterministic mapping `buildSceneRenderPlan({ scenario, visualProductionPlan, options })` from Phase 5A VisualProductionPlan to SceneRenderPlan. Uses existing renderer concepts from `packages/video/src/scenes` (Hook variants, Explanation variants, CTA, Backgrounds, Transitions). Creates deterministic registry narrativePurpose → rendererKey (hook:generic, cta:cta_card, explanation:key_statement, problem_cause_solution, dashboard_demo, myth_vs_reality, animated_checklist, process_flow, site_footage_callouts, chart_animation, etc.) with refinement based on production hints (screenInsert, bRollIntent, evidenceIds, turn intent question, numeric). Implements unsupported scene policy: explicit error UNSUPPORTED_SCENE_TYPE unless allowGenericFallback true, then generic:generic with fallbackUsed flag and fallbackFrom recorded, no invisible fallback. Converts visual beats to render instructions preserving actual timing from Phase 5A (no retiming), asset binding deterministic scene ownership, audio binding only canonical path, caption binding verified scene/turn identity within scene, transition mapping to renderer-ready spec, render order deterministic same as VisualProductionPlan, cross-contract validation (duplicate scene ID, missing renderer, invalid key, beat outside timing, audio from another scene, caption from another scene, asset wrong scene, duplicate render order, invalid transition), deterministic summary (sceneCount, rendererKeysUsed, beatCount, audioRefCount, captionCueCount, assetRefCount, transitionCount, fallbackCount, totalDuration, status). Also provides `validateSceneRenderPlan`.
- `tests/scene-render.test.ts` — Focused unit tests (16 tests). Reason: Cover valid VisualProductionPlan mapping, deterministic renderer mapping, scene order, beat preservation, asset binding, canonical audio binding, caption binding, transition mapping, unsupported scene type, explicit fallback behavior, duplicate render order, wrong scene audio, wrong scene captions, invalid asset association, deterministic repeated output, total duration matches Phase 5A actual.
- `tests/scene-render-integration.test.ts` — Integration test (1 test). Reason: Prove Scenario → Phase 4 DialogueProductionResult → Phase 5A VisualProductionPlan → Phase 5B SceneRenderPlan, all scenes map exactly once, order preserved, actual timing unchanged from Phase 5A, beats preserved, renderer keys assigned deterministically, canonical audio attached, reconciled captions attached, assets preserved, transitions mapped, no rendering.

### Modified
- `packages/core/src/scenario/index.ts` — Export Phase 5B public API. Reason: Expose SceneRenderPlan, SceneRenderSpec, renderer key/type, buildSceneRenderPlan, validateSceneRenderPlan for Phase 5C while keeping internal helpers private.

## Existing Renderer Inspection

Document scene components/types found, renderer categories/keys reused, gaps:

- **Found in `packages/video/src/scenes`**:
  - `Backgrounds.tsx` — Background variant rendering (site_footage, dark_grid, document_closeup, light_technical, blueprint, dashboard_ui, full_typography, split_visual)
  - `Hooks.tsx` — 8 hook variants: question, surprising_number, before_after, common_mistake, risk_warning, scenario_story, document_zoom, product_result. Each has distinct layout: question mark motif, huge numeral, two columns divider, cross-out stamp, hazard band, cinematic left card, paper lifting, device frame. Shared Chrome component for brand rail, section label, logo, end-screen safe zone. Uses Remotion hooks useCurrentFrame, useVideoConfig, interpolate, spring.
  - `Explanations.tsx` — 13 explanation variants: animated_checklist (checklist with tick animation), key_statement (single block with accent bar), number_comparison (two bars with gap), progressive_table (table reveal), timeline (vertical steps with dots), process_flow (cards with arrows), document_annotation (paper with highlighted box and callout), site_footage_callouts (background image/video with dots and labels), split_screen (two contrasting cards), dashboard_demo (metrics + chart), chart_animation (bars), myth_vs_reality (two cards MYTH/REALITY), problem_cause_solution (three cards). Uses clip helper to avoid cutting thoughts, fitSize for type scaling.
  - `Cta.tsx` — CTA card variant.
  - `SceneRenderer.tsx` — Single scene: background → content → brand chrome. Determines variant via HOOK_IDS set from HOOK_VARIANTS, explanationById, cta_card. Layout driven by storyboard.
  - `Transitions.tsx` — Transition variants: push, zoom, mask_reveal, data_wipe, document_page, match_cut, direct_cut. Each pure function of progress p 0..1, deterministic frame-accurate, uses interpolate. transitionLength = frames/30.

- **Renderer categories/keys reused**:
  - Hook: `hook:question`, `hook:surprising_number`, `hook:before_after`, `hook:common_mistake`, `hook:risk_warning`, `hook:scenario_story`, `hook:document_zoom`, `hook:product_result`, `hook:generic`
  - Explanation: `explanation:animated_checklist`, `explanation:number_comparison`, `explanation:progressive_table`, `explanation:timeline`, `explanation:process_flow`, `explanation:document_annotation`, `explanation:site_footage_callouts`, `explanation:split_screen`, `explanation:dashboard_demo`, `explanation:chart_animation`, `explanation:myth_vs_reality`, `explanation:key_statement`, `explanation:problem_cause_solution`, `explanation:generic`
  - CTA: `cta:cta_card`, `cta:generic`
  - Background: `background:generic`
  - Generic: `generic:generic`
  - Categories: hook, explanation, cta, background, generic

- **Gaps discovered**:
  - Phase 3B visual plan (ScenarioVisualPlan) does NOT contain explicit variant IDs (hook/explanation variant), only narrativePurpose and production direction. So Phase 5B must infer renderer key from narrativePurpose + production hints (screenInsert, bRollIntent, evidenceIds, turn intent) rather than direct variant. This is documented as mapping policy.
  - No explicit endcard renderer in current video package, but type allows 'endcard' — we map to generic if encountered, with fallback policy.
  - Asset references in Phase 3B are logical assetRef strings, not file paths, and no downloading — Phase 5B preserves this model, does not add image generation.
  - Transition intent from Phase 3B is preserved as type/duration/source, but actual animation not executed in 5B — only data for future wiring.

## SceneRenderPlan Contract

- **Type names**: `SceneRenderPlan`, `SceneRenderSpec`, `SceneRenderBeat`, `SceneVisualTreatment`, `SceneRenderSummary`, `SceneRenderFinding`, `SceneRendererKey`, `RendererCategory`
- **Per-scene fields** (`SceneRenderSpec`):
  - `scenarioId`, `projectId`, `sceneId`, `sourceSceneId`, `sceneIndex`, `renderOrder`, `title`, `narrativePurpose`
  - `rendererKey`: deterministic mapping from narrativePurpose/production hints to known renderer key (e.g., `hook:generic`, `explanation:key_statement`, `cta:cta_card`)
  - `rendererCategory`: hook|explanation|cta|background|generic
  - `fallbackUsed`: boolean, `fallbackFrom`: original requested type if fallback
  - `actualStartSeconds`, `actualEndSeconds`, `actualDurationSeconds`: authoritative from Phase 5A VisualProductionPlan (which itself authoritative from Phase 4)
  - `estimatedStartSeconds`, `estimatedEndSeconds`, `estimatedDurationSeconds`: for reference from Phase 3B
  - `visualTreatment`: background, accent, screenInsert, bRollIntent, overlayIntent, environmentalAction
  - `production`: ProductionDirection preserved, `onScreenInfo`: OnScreenInformation | null
  - `locationId`, `participantIds`, `turnIds`, `speakerIds`, `visualOnly`
  - `beats`: SceneRenderBeat[] — preserves Phase 5A beat timing (no retiming), id, index, kind, actualStart/End/Duration, relativeStart/End, turnId, activeSpeakerId, reactingCharacterId, spokenText, intent, delivery, shot (shotType/framing/speakerFocus/cameraMovement/focusCharacterId), evidenceIds, cues (id/kind/text/actualStart/End/Duration/assetRef), audioRef, captionCueIds
  - `assetRefs`: VisualProductionAssetRef[] bound to this scene, deterministic order, scene ownership preserved
  - `audioRefs`: VisualProductionAudioRef[] canonical refs only (audio/canonical), correct turn/clip identity, correct timing, speaker/voice continuity
  - `captionCues`: ReconciledCaptionCue[] bound to scene, verified scene/turn identity, timing within scene, order deterministic, text unchanged, no cross-scene leakage
  - `transition`: type, durationSeconds, source, actualStart/End/Duration, rendererKey (e.g., direct_cut, push)
  - `targetFormat`: ScenarioTargetFormat, `formatInfo` optional orientation/aspectRatio

- **Renderer mapping policy**:
  - Registry `NARRATIVE_PURPOSE_TO_RENDERER` deterministic: hook→hook:generic, cta→cta:cta_card, context→explanation:key_statement, problem→explanation:problem_cause_solution, evidence→explanation:dashboard_demo, disagreement→explanation:myth_vs_reality, clarification→explanation:animated_checklist, decision→explanation:process_flow, solution→explanation:process_flow, demonstration→explanation:site_footage_callouts, result→explanation:chart_animation
  - Refinement based on production hints:
    - evidence + evidenceIds → number_comparison
    - evidence + screenInsert → dashboard_demo
    - demonstration + screenInsert → dashboard_demo, + bRollIntent → site_footage_callouts
    - result + overlayIntent contains chart → chart_animation
    - hook + first turn intent question → hook:question, + spokenText contains number/% → hook:surprising_number
  - Deterministic: same narrativePurpose + production hints → same rendererKey, no randomness

- **Fallback policy**:
  - If narrativePurpose unknown or not in registry, and `allowGenericFallback` false (default), return structured error `UNSUPPORTED_SCENE_TYPE` with requested scene type, no silent mapping.
  - If `allowGenericFallback` true, map to `generic:generic` with `fallbackUsed=true`, `fallbackFrom=requestedPurpose`, record warning `RENDERER_MAPPING_MISSING`, renderer selected documented.
  - No invisible fallback — fallbackUsed flag and fallbackFrom recorded, summary fallbackCount incremented.

- **Asset/audio/caption/transition binding**:
  - Asset: bind Phase 5A assetRefs into scene renderer inputs, deterministic order (as in visualProductionPlan), scene ownership preserved (asset.sceneId must equal scene.sourceSceneId), validate structural correctness (non-empty, no absolute, no '..'), distinguish required vs optional (Phase 3B currently optional, but contract supports required flag), no download/generation.
  - Audio: attach canonical Phase 4 audio refs to correct renderer scene, only canonical path (audio/canonical), correct turn/clip identity, correct start/end timing from Phase 5A actual, speaker/voice continuity preserved, no raw SAM path when canonical exists, no mixing/altering.
  - Caption: bind reconciled captions to renderer scene specs, verify cue scene/turn identity, cue timing within scene (cue.start >= scene.actualStart, cue.end <= scene.actualEnd), deterministic cue order sorted by startTime, no cross-scene leakage, exact text unchanged, no restyle/re-segment.
  - Transition: map existing transition intent/reference into renderer-ready spec with type, duration, source, actualStart/End/Duration from Phase 5A, rendererKey = type (e.g., direct_cut, push), but NOT execute animation, preserve timing and intent.

## Invariants

List all validations/invariants enforced in `validateInvariants` and `buildSceneRenderPlan`:

1. **Every Phase 5A scene maps exactly once**: Check visualProductionPlan.scenes.length == sceneRenderPlan.scenes.length, no duplicate sceneId, each sourceSceneId maps once. Failure: MISSING_SCENE, DUPLICATE_SCENE_ID, VISUAL_SCENE_MISMATCH.
2. **Render order deterministic**: renderOrder == sceneIndex == position in array, no missing, no duplicate, monotonic timing, adjacent boundaries consistent with actual timing (prev.actualEnd <= curr.actualStart). Failure: DUPLICATE_RENDER_ORDER, OVERLAP_DETECTED.
3. **Actual scene timing positive and monotonic**: actualDuration >0, actualStart >=0, actualEnd > actualStart. Failure: INVALID_DURATION, MISSING_ACTUAL_TIMING.
4. **No scene overlap unless explicitly allowed**: Currently no overlap allowed, check prev.actualEnd <= curr.actualStart +0.001. Failure: OVERLAP_DETECTED.
5. **Visual beat order deterministic**: beat.index == position, beats sorted by actualStart, id preserved, beat timing preserved from Phase 5A (no retiming). Failure: VISUAL_BEAT_MISMATCH.
6. **Every visual beat maps inside its scene interval**: beat.actualStart >= scene.actualStart -0.001 and beat.actualEnd <= scene.actualEnd +0.001, actualDuration >0. Failure: VISUAL_BEAT_MISMATCH, INVALID_DURATION.
7. **Every spoken turn maps to canonical audio**: For dialogue beats, audioRef must exist, canonicalPath contains 'audio/canonical', actualDuration >0, sceneId matches. Failure: AUDIO_BINDING_MISMATCH, MISSING_PHASE_OUTPUT.
8. **Every caption maps to valid turn**: captionCues turnId in scene.turnIds, cue timing within scene interval, no cross-scene leakage, text unchanged. Failure: CAPTION_BINDING_MISMATCH.
9. **All referenced assets structurally valid**: assetRef non-empty, no absolute, no traversal, sceneId matches scene. If required invalid, error ASSET_REFERENCE_INVALID; optional invalid warning. Failure: ASSET_REFERENCE_INVALID, ASSET_BINDING_MISMATCH.
10. **Total plan duration matches Phase 5A actual total duration**: totalActual = visualProductionPlan.totalActualDurationSeconds and equals last scene actualEnd, sum scene durations = total. Failure: SCENE_RENDER_INVARIANT_FAILED.
11. **No estimated timing overrides actual timing**: Ensure actual timing from Phase 5A used, not estimated; totalActual == sum actual scene durations and matches Phase 4 actual, not estimated. Failure: SCENE_RENDER_INVARIANT_FAILED.
12. **Cross-contract identities**: scenarioId, projectId, targetFormat, scene IDs/order, scene count, turn IDs, beat scene associations, audio clip identities, caption turn identities validated before mapping, reject mismatched with PIPELINE_IDENTITY_MISMATCH, VISUAL_SCENE_MISMATCH, no silent partial joining.
13. **Renderer mapping**: rendererKey must be known from registry, invalid key → RENDERER_MAPPING_INVALID, missing → RENDERER_MAPPING_MISSING, unsupported scene type without fallback → UNSUPPORTED_SCENE_TYPE.
14. **Transition**: type non-empty string, actualDuration >=0 if present, else invalid → TRANSITION_BINDING_INVALID.

## Integration Evidence

- **Fixture**: `scenario-pm-01` (progress-meeting), 5 scenes, 12 turns, 12 clips
- **Scene count**: 5, renderer keys used: `cta:cta_card`, `explanation:key_statement`, `explanation:number_comparison`, `explanation:site_footage_callouts`, `hook:generic` (deterministic mapping from narrativePurpose: hook, context, evidence, demonstration, cta)
- **Beat count**: 12, audio count: 12, caption cue count: 28, asset count: 2, transition count: 2
- **Proof timings equal Phase 5A**: 
  - Phase 5A total actual 118.74s, SceneRenderPlan total actual 118.74s, match true
  - Example scene: id `sc-01-hook` rendererKey `hook:generic` actualStart 0s actualEnd 23.67s matches Phase 5A scene actualStart/End
  - Example beat: id `scenario-pm-01/sc-01-hook/turn/turn-01-sarah` actualStart 0s actualEnd 9.97s preserved from Phase 5A (relativeStart 0, relativeEnd 0.421)
  - All scenes map exactly once, order preserved (sc-01-hook, sc-02-context, sc-03-evidence, sc-04-demonstration, sc-05-cta), renderOrder 0..4
  - Canonical audio attached: all audioRefs canonicalPath contains `audio/canonical`, 12 refs
  - Captions attached: 28 cues, each cue.sceneId matches scene.sourceSceneId, timing within scene
  - Assets preserved: 2 assetRefs from Phase 3B, scene ownership preserved
  - Transitions mapped: type preserved (e.g., direct_cut, push), duration preserved, actual interval mapped
  - No rendering: tmp dirs contain only audio WAV files, no mp4/mov

## Explicit Non-goals

Confirm no Remotion/rendering/Phase 5C work occurred:

- No actual Remotion rendering, React renderer wiring, frame generation, MP4 output
- No image generation, asset downloading, thumbnail generation
- No audio mixing, caption styling changes
- No UI, API, export workflow
- No Phase 5C+, Phase 6/7
- No modification of Phase 5A timing or Phase 4 output
- Only deterministic adapter from VisualProductionPlan to SceneRenderPlan, compatible with future Phase 5C wiring

## Validation

Actual results:

- **Focused Phase 5B tests**: `tests/scene-render.test.ts` 16 tests passed (valid mapping, deterministic renderer mapping, scene order, beat preservation, asset binding, canonical audio binding, caption binding, transition mapping, unsupported scene type, explicit fallback, duplicate render order, wrong scene audio, wrong scene captions, invalid asset association, deterministic repeated output, total duration matches Phase 5A)
- **Integration test**: `tests/scene-render-integration.test.ts` 1 test passed with evidence
- **Phase 5A tests**: `tests/visual-production.test.ts` 17 passed, `tests/visual-production-integration.test.ts` 1 passed → total 18 passed
- **Phase 4 regression gate**: `tests/phase4-regression.test.ts` 5 passed
- **Phase 4E tests**: `tests/dialogue-production-integration.test.ts` 2 passed, `tests/dialogue-production-negative.test.ts` 7 passed → total 9 passed
- **Full npm test**: 31 files, 537 tests passed (was 520 before Phase 5B, +17 new)
- **npm run typecheck**: `tsc -p packages/core/tsconfig.json --noEmit` passes
- **npm run build**: `tsc -p packages/core/tsconfig.json` succeeds, core dist built
- **Test-count guard**: 537 >= 240, passes
- **git diff --check**: no whitespace errors

## Recovery / Codex Review

- **Implementation SHA(s)**: To be filled after final commits — expected:
  - `feat(visual): add scene render plan contracts` (scene-render-types.ts)
  - `feat(visual): map visual production scenes to render specs` (scene-render-pipeline.ts)
  - `test(visual): cover phase5b scene integration` (scene-render.test.ts, scene-render-integration.test.ts)
  - `docs(visual): finalize phase5b handoff` (this file)
- **Final HEAD**: To be filled
- **Branch**: `arena/01a0eeb0-video-factory`
- **Files Codex should inspect first**:
  - `packages/core/src/scenario/scene-render-types.ts` — SceneRenderPlan contract
  - `packages/core/src/scenario/scene-render-pipeline.ts` — adapter `buildSceneRenderPlan` with renderer mapping and fallback policy documented
  - `packages/core/src/scenario/visual-production-types.ts` — Phase 5A input contract
  - `packages/core/src/scenario/visual-production-pipeline.ts` — Phase 5A timing mapping policy
  - `packages/video/src/scenes/SceneRenderer.tsx`, `Hooks.tsx`, `Explanations.tsx`, `Transitions.tsx` — existing renderer inspection
  - `tests/scene-render.test.ts` — focused unit tests
  - `tests/scene-render-integration.test.ts` — integration evidence
  - `PHASE5B_SCENE_RENDER_PLAN_HANDOFF.md` — this file
- **Known limitations**:
  - Renderer mapping infers rendererKey from narrativePurpose + production hints because Phase 3B visual plan does NOT contain explicit variant IDs; more specific mapping could use storyboard variant if available in future
  - Asset mapping only reuses logical assetRef, no image generation/download
  - Transition mapping only preserves intent data, not animation execution
  - Fallback to generic:generic only allowed via explicit option allowGenericFallback, otherwise fails UNSUPPORTED_SCENE_TYPE
  - Rounding to 2 decimals may cause 0.01s drift, tolerated with 0.001-0.01 tolerance, last beat clamped to scene end
  - No rendering, no Remotion wiring — only data contract for future Phase 5C
- **Whether 5B is safe to accept**: YES — all acceptance criteria met, SceneRenderPlan exists, every Phase 5A scene maps exactly once, renderer mapping deterministic, unknown scene handling explicit, beat timing preserved, canonical audio/captions/assets/transitions bound correctly, render order deterministic, mismatches rejected, integration passes, no rendering introduced, Phase 5A and Phase 4 regression gates pass, full suite passes, typecheck/build pass, work committed and pushed.
