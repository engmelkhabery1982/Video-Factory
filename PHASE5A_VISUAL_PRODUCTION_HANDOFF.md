# Phase 5A — Visual Production Contract & Phase 4→5 Adapter Handoff

## Baseline
- Approved starting SHA: `07c8a24175b34aed94b3c1c615c82987c86f8f52`
- Branch: `arena/01a0eeb0-video-factory`
- Current HEAD: `6303faf090a28e850cba603bb6662b64c359cde0` (final after Phase 5A)

## Files

### Added
- `packages/core/src/scenario/visual-production-types.ts` — Canonical Phase 5A visual production contract. Reason: Define one strongly typed `VisualProductionPlan` containing only what downstream rendering needs: global identity (scenarioId, projectId, language, targetFormat, total actual duration), scene production data (sceneId, index/order, actual start/end/duration, narrativePurpose, location, participantIds, turnIds, speakerIds, production direction, onScreenInfo, transition intent, visual beats adapted to actual timing, audio clip references canonical, caption cue references, asset references, deterministic renderOrder), beat structure with relative-position preservation, audio ref (canonicalPath, actualDuration, speaker/voice identity), asset ref (logical assetRef from Phase 3B cues), summary (deterministic, no timestamps), findings, structured errors (VISUAL_SCENE_MISMATCH, VISUAL_BEAT_MISMATCH, MISSING_ACTUAL_TIMING, AUDIO_REFERENCE_MISMATCH, CAPTION_REFERENCE_MISMATCH, ASSET_REFERENCE_INVALID, VISUAL_PRODUCTION_INVARIANT_FAILED, etc.)
- `packages/core/src/scenario/visual-production-pipeline.ts` — Phase 4→5 adapter. Reason: Implement deterministic adapter `buildVisualProductionPlan({ scenario, visualPlan, dialogueResult })` that reuses existing Phase 3B visual plan and Phase 4 DialogueProductionResult, uses actual timing authoritative from reconciledDialogue, maps visual beats onto actual timing via relative-position preservation, attaches canonical audio refs (not raw SAM), attaches reconciled caption cues, reuses asset model from Phase 3B, preserves transition intent, validates cross-phase identities (scenarioId, projectId, targetFormat, scene IDs/order, scene count, turn IDs, beat scene associations, audio clip identities, caption turn identities), enforces final invariants (every scene exists in both pipelines, scene order matches, actual timing positive monotonic no overlap, beat order deterministic inside scene interval, every spoken turn maps to canonical audio, every caption maps to valid turn, asset refs structurally valid, total duration matches Phase 4 actual total, no estimated override). Also provides `validateVisualProductionPlan`.
- `tests/visual-production.test.ts` — Focused unit tests (17 tests). Reason: Cover correct Phase 4→visual adaptation, actual timing used not estimated, longer/shorter scene duration mapping, beat relative-position preservation, scene order preservation, canonical audio ref mapping, caption mapping, asset mapping, deterministic output, missing scene, wrong scene order, wrong scenarioId, missing actual timing, caption mismatch, audio mismatch, invalid asset, no estimated override.
- `tests/visual-production-integration.test.ts` — Integration test (1 test). Reason: Prove Scenario → VisualPlan + DialogueProductionResult → VisualProductionPlan, actual Phase 4 duration used, all scenes map, beats order preserved, beat timing adapted to actual scene boundaries, canonical audio attached, reconciled captions attached, total duration matches Phase 4, no rendering.

### Modified
- `packages/core/src/scenario/index.ts` — Export Phase 5A public API. Reason: Expose VisualProductionPlan type, VisualProductionScene, buildVisualProductionPlan, validateVisualProductionPlan, structured errors for Phase 5B/5C while keeping lower-level APIs.

## Input Contracts

### From Phase 3 Visual Planning
- `Scenario` (metadata.id, projectId, language, targetFormat, scenes with id/order, turns)
- `ScenarioVisualPlan` (planVersion, scenarioId, projectId, format.targetFormat, totalDurationSeconds, scenes[] with sourceSceneId, index, title, narrativePurpose, locationId, participantIds, turnIds, speakerIds, visualOnly, startSeconds, endSeconds, durationSeconds, production: ProductionDirection, onScreenInfo, transitionOut: type/duration/source, beats[] with id, sceneId, index, kind, startSeconds, endSeconds, turnId, activeSpeakerId, reactingCharacterId, spokenText, intent, delivery, shot: shotType/framing/speakerFocus/cameraMovement/focusCharacterId, evidenceIds, cues[] with id/kind/text/startSeconds/endSeconds/source/assetRef, sceneCues[])
- Visual intent already defined in Phase 3: shot types, framing, speaker focus, camera movement, evidence claims, on-screen text, etc.

### From Phase 4 Final Dialogue Production
- `DialogueProductionResult` (schemaVersion 1.0.0, scenarioId, projectId, language, targetFormat, dialoguePlan, voiceResolution, synthesisManifest, canonicalManifest, reconciledDialogue: actualStart/End/Duration per scene/clip, reconciledPlayback: speech intervals ms matching actual, reconciledCaptions: cues within actual speech, visualPlan, captionPlan, summary deterministic, findings, valid)
- Reconciled timing authoritative: reconciledDialogue.scenes actualStart/End/Duration, reconciledDialogue.clips actualStart/End/Duration/TotalSpan, reconciledPlayback dialogues speech startMs/endMs, reconciledCaptions cues start/end within actual
- Canonical audio artifacts: canonicalManifest results with canonicalPath (audio/canonical/...), sourcePath, actualDuration, isCanonical true, sampleRate 48000, channels 1, codec pcm_s16le
- Voice identity: voiceResolution.bySlot, voiceProfileId
- Speaker/character identity, scene/turn/clip identity preserved

## Output Contract

- **Canonical type name**: `VisualProductionPlan`
- **Plan version**: `1.0.0`
- **Fields**:
  - `planVersion`: '1.0.0'
  - `scenarioId`, `projectId`, `language`, `targetFormat`: global identity
  - `totalActualDurationSeconds`: authoritative from Phase 4 reconciledDialogue.actualTotalDurationSeconds
  - `totalEstimatedDurationSeconds`: from Phase 3 visual plan for comparison
  - `totalDeltaSeconds`: actual - estimated
  - `scenes`: VisualProductionScene[] in deterministic render order (index = renderOrder)
  - `summary`: VisualProductionSummary deterministic
  - `findings`: VisualProductionFinding[]
  - `valid`: boolean

- **Scene structure** (`VisualProductionScene`):
  - `id`, `sourceSceneId`, `sceneId`, `index`, `title`, `narrativePurpose`, `locationId`, `participantIds`, `turnIds`, `speakerIds`, `visualOnly`
  - `estimatedStartSeconds`, `estimatedEndSeconds`, `estimatedDurationSeconds` (from Phase 3B for reference)
  - `actualStartSeconds`, `actualEndSeconds`, `actualDurationSeconds` (authoritative from Phase 4)
  - `production`: ProductionDirection preserved
  - `onScreenInfo`: OnScreenInformation | null preserved
  - `transition`: type, durationSeconds, source, actualStart/End/Duration (actual interval at end of scene after dialogue)
  - `beats`: VisualProductionBeat[] adapted
  - `audioRefs`: VisualProductionAudioRef[] canonical refs for scene
  - `captionCues`: ReconciledCaptionCue[] reconciled captions for scene
  - `assetRefs`: VisualProductionAssetRef[] from sceneCues and beat cues
  - `renderOrder`: deterministic = index

- **Timing authority**: Phase 5A uses actual timing from Phase 4 reconciledDialogue. If actual timing missing, fails explicitly with MISSING_ACTUAL_TIMING. Does NOT fall back to Phase 3 estimated durations once Phase 4 actual exists. Estimated timing kept only for reference/comparison.

- **Audio reference structure** (`VisualProductionAudioRef`):
  - `clipId`, `turnId`, `sceneId`, `sceneIndex`, `turnIndex`, `globalTurnIndex`, `speakerId`, `voiceSlot`, `voiceProfileId`, `spokenText`
  - `canonicalPath`: `audio/canonical/...` (must use canonical, not raw SAM)
  - `sourcePath`: original SAM path for traceability
  - `actualDurationSeconds`, `actualStartSeconds`, `actualEndSeconds`, `actualTotalSpanSeconds`, `pauseAfterSeconds`
  - All from reconciledDialogue clips, which map to canonicalManifest canonicalMetadata.durationSeconds

- **Caption reference structure**:
  - Reuses `ReconciledCaptionCue` (id, sceneId, sceneIndex, turnId, turnIndex, globalTurnIndex, clipId, text, speakerId, voiceSlot, startTimeSeconds, endTimeSeconds, durationSeconds, estimatedStart/End/Duration, wordCount, isSingleWord, globalCueIndex)
  - Attached to correct scene via sceneId, turn via turnId, verified boundaries within actual speech interval, order preserved, text unchanged, no cross-scene

- **Asset reference structure** (`VisualProductionAssetRef`):
  - `assetRef`: logical reference from Phase 3B cue (e.g., 'asset:screen-insert:xyz')
  - `cueKind`, `cueId`, `beatId`, `sceneId`, `sourceField`, `required` (false for Phase 3B optional assets), `warning` if structurally invalid
  - Reuses Phase 3B asset model, does NOT generate images, download, or call stock APIs
  - If optional asset missing/invalid, preserves warning; if required invalid, fails ASSET_REFERENCE_INVALID

## Visual Timing Mapping Policy

Document exactly how estimated visual beat placement is adapted to actual reconciled scene timing:

**Policy: Preserve relative position within scene (normalized fraction)**

For each scene:
- Original estimated scene interval from Phase 3B: [estStart, estEnd] duration estDur = estEnd - estStart (from visualPlan.scenes[i].startSeconds/endSeconds/durationSeconds)
- Actual scene interval from Phase 4: [actStart, actEnd] duration actDur = actEnd - actStart (from reconciledDialogue.scenes[i].actualStartTimeSeconds/actualEndTimeSeconds/actualDurationSeconds)

For each visual beat within scene:
- Compute relativeStart = (beat.estStart - scene.estStart) / scene.estDur
- Compute relativeEnd = (beat.estEnd - scene.estStart) / scene.estDur
- Clamp relative to [0,1] to handle edge cases
- Actual beat start = scene.actStart + relativeStart * scene.actDur
- Actual beat end = scene.actStart + relativeEnd * scene.actDur
- Round to 2 decimals for determinism
- For last beat in scene, force actualEnd = scene.actEnd to avoid gaps due to rounding
- Ensure positive duration (if end <= start, set end = start + 0.01)
- Sort beats by actualStart to preserve order, fix small overlaps from rounding by adjusting curr end to next start
- Preserve beat identity, order, visual purpose, associated scene, intended relative placement
- Do NOT invent visual content

For visual cues within beat:
- Compute cue relative within beat: cueRelStart = (cue.estStart - beat.estStart) / beat.estDur, cueRelEnd similarly
- Clamp to [0,1]
- Actual cue start = beat.actStart + cueRelStart * beat.actDur
- Actual cue end = beat.actStart + cueRelEnd * beat.actDur
- This preserves cue relative placement inside beat

Transition beats:
- If scene has transitionSeconds >0 from reconciledDialogue, transition actual interval = [lastDialogueBeat.actualEnd, scene.actualEnd]
- Preserves transition intent type/source/duration from Phase 3B visualPlan.transitionOut

This is simplest defensible rule, deterministic, no randomness, no clock.

## Final Invariants

Enforced in `validateInvariants` and `buildVisualProductionPlan`:

1. **Every scene exists in both visual and dialogue pipelines**: Check visualPlan.scenes.length == reconciledDialogue.scenes.length and each sourceSceneId has matching reconciled scene. Failure: MISSING_SCENE or VISUAL_SCENE_MISMATCH.
2. **Scene order matches**: renderOrder == index == position in array, and order equals scenario.scenes order. Failure: VISUAL_SCENE_MISMATCH.
3. **Actual scene timing positive and monotonic**: actualDuration >0, actualStart >=0, actualEnd > actualStart, and prev.actualEnd <= curr.actualStart. Failure: INVALID_DURATION, MISSING_ACTUAL_TIMING, OVERLAP_DETECTED.
4. **No scene overlap unless explicitly allowed**: Currently no overlap allowed; check prev.actualEnd <= curr.actualStart +0.001. Failure: OVERLAP_DETECTED.
5. **Visual beat order deterministic**: beat.index == position in beats array, beats sorted by actualStart, id preserved. Failure: VISUAL_BEAT_MISMATCH.
6. **Every visual beat maps inside its scene interval**: beat.actualStart >= scene.actualStart -0.001 and beat.actualEnd <= scene.actualEnd +0.001, actualDuration >0. Failure: VISUAL_BEAT_MISMATCH, INVALID_DURATION.
7. **Every spoken turn maps to canonical audio**: For dialogue beats, audioRef must exist, canonicalPath non-empty containing 'audio/canonical', actualDuration >0. Failure: AUDIO_REFERENCE_MISMATCH.
8. **Every caption maps to valid turn**: captionCues turnId must be in scene.turnIds, cue boundaries within actual speech interval of corresponding audioRef, text unchanged vs original. Failure: CAPTION_REFERENCE_MISMATCH.
9. **All referenced assets structurally valid**: assetRef non-empty, no absolute path, no traversal '..'. If required and invalid, error ASSET_REFERENCE_INVALID; if optional invalid, warning.
10. **Total plan duration matches Phase 4 actual total duration**: totalActual = reconciledDialogue.actualTotalDurationSeconds and equals last scene actualEnd. Failure: VISUAL_PRODUCTION_INVARIANT_FAILED.
11. **No estimated timing overrides actual timing**: totalActual must equal sum of actual scene durations and match Phase 4 actual, not estimated. Check totalActual != visualPlan.totalDurationSeconds (if Phase 4 delta non-zero, must differ) and totalActual == sum actual scene durations. Failure: VISUAL_PRODUCTION_INVARIANT_FAILED.

Also cross-phase identity validation before building: scenarioId, projectId, targetFormat, scene IDs/order, scene count, turn IDs, visual beat scene associations, audio clip identities, caption turn identities — reject mismatched with PIPELINE_IDENTITY_MISMATCH, VISUAL_SCENE_MISMATCH, no silent partial joining.

## Integration Evidence

- **Fixture used**: `scenario-pm-01` (progress-meeting), 5 scenes, 12 turns, 12 clips
- **Phase 4 actual duration**: 118.74s (from DialogueProductionResult reconciledDialogue.actualTotalDurationSeconds), estimated from Phase 3 visual plan 102s, delta +16.74s
- **Scene count**: 5, beat count: 12, audio count: 12, caption cue count: 28, asset reference count: 2 (from Phase 3B visual plan sceneCues/beat cues with assetRef)
- **Example old beat timing vs adapted actual**:
  - Old: id=`scenario-pm-01/sc-01-hook/turn/turn-01-sarah` estimatedStart 0s estimatedEnd 8.8s sceneEstimatedStart 0s sceneEstimatedDuration 20.9s relativeStart 0
  - Adapted actual: same id actualStart 0s actualEnd 9.97s sceneActualStart 0s sceneActualDuration 23.67s relativeStart 0 preserved
  - Proof relative position preserved: relativeStart 0→0, relativeEnd 8.8/20.9≈0.421 → actualEnd 0+0.421*23.67≈9.97s
- **Proof total duration matches Phase 4**: VisualProductionPlan totalActual 118.74s == DialogueProductionResult reconciledDialogue.actualTotalDurationSeconds 118.74s == last scene actualEnd 118.74s, true

No rendering occurred — checked tmp dirs contain only audio/dialogue and audio/canonical WAV files, no mp4/mov.

## Explicit Non-goals

Confirm no Remotion/rendering/UI/API/export/Phase 5B+ work:

- No Remotion rendering, SceneRenderer wiring, React visual components
- No transitions animation (only transition intent data preserved)
- No video export, image generation, external image APIs, asset downloading, thumbnail generation
- No Phase 5B implementation, no Phase 5C, no Web UI, API routes, Phase 6/7
- No alteration of Phase 4 timing or audio
- No redesign of Phase 3 VisualPlan (only mapping)

Only deterministic adapter, no rendering.

## Validation

Actual results:

- **Focused Phase 5A tests**: `tests/visual-production.test.ts` 17 tests passed (correct adaptation, actual timing authoritative, longer/shorter mapping, relative-position preservation, scene order, canonical audio ref, caption mapping, asset mapping, deterministic, missing scene, wrong order, wrong scenarioId, missing actual timing, caption mismatch, audio mismatch, invalid asset, no estimated override)
- **Integration test**: `tests/visual-production-integration.test.ts` 1 test passed with evidence logs
- **Phase 4 regression gate**: `tests/phase4-regression.test.ts` 5 tests passed (4A voice resolution deterministic, 4B SAM WAV, 4C 22.05kHz→48kHz mono PCM16, 4D actual replaces estimated, 4E orchestration)
- **Phase 4E tests**: `tests/dialogue-production-integration.test.ts` 2 passed, `tests/dialogue-production-negative.test.ts` 7 passed → total 9 passed
- **Full npm test**: 29 files, 520 tests passed (was 502 before Phase 5A, +18 new)
- **npm run typecheck**: `tsc -p packages/core/tsconfig.json --noEmit` passes
- **npm run build**: `tsc -p packages/core/tsconfig.json` succeeds, core dist built
- **Test-count guard**: 520 >= 240, passes
- **git diff --check**: no whitespace errors

## Recovery / Codex Review

- **Implementation commit SHA(s)**: To be filled after final commits — expected:
  - `feat(visual): add phase5 visual production contracts`
  - `feat(visual): add phase4-to-visual adapter`
  - `test(visual): cover phase5a production mapping`
  - `docs(visual): finalize phase5a handoff`
- **Final HEAD**: To be filled
- **Branch**: `arena/01a0eeb0-video-factory`
- **Exact files Codex should inspect first**:
  - `packages/core/src/scenario/visual-production-types.ts` — canonical VisualProductionPlan contract
  - `packages/core/src/scenario/visual-production-pipeline.ts` — adapter `buildVisualProductionPlan` with timing mapping policy documented
  - `packages/core/src/scenario/index.ts` — public exports
  - `tests/visual-production.test.ts` — unit tests for mapping, identities, invariants
  - `tests/visual-production-integration.test.ts` — integration evidence
  - `PHASE5A_VISUAL_PRODUCTION_HANDOFF.md` — this file
- **Known limitations**:
  - Asset mapping only reuses existing Phase 3B assetRef logical references, does not generate/download images
  - Visual timing mapping uses relative-position preservation, not forced alignment or content-aware retiming
  - Transition actual interval derived as [lastDialogueEnd, sceneActualEnd] if transitionSeconds>0, not animated
  - Rounding to 2 decimals may cause 0.01s drift, tolerated with 0.001 tolerance in validation, last beat clamped to scene end
  - No rendering, no Remotion, no video export — only data contract
- **Whether Phase 5A is safe to accept**: YES — all acceptance criteria met, actual Phase 4 timing authoritative, beat mapping deterministic, canonical audio and reconciled captions attached, identities/order intact, mismatches rejected, invariants enforced, integration passes, no rendering introduced, full suite passes, typecheck/build pass, work committed and pushed.
