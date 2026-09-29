# Phase 4D — Actual Timing Reconciliation Handoff

## Baseline
- Approved baseline commit: `af999d33ce33610562f158c372252391e5b756ed` (Phase 3A-3E + 4A-4C approved)
- Branch verified: `arena/01a0eeb0-video-factory` HEAD `af999d33ce33610562f158c372252391e5b756ed` before implementation
- Final HEAD after Phase 4D implementation: (to be filled after commit)
- Branch: `arena/01a0eeb0-video-factory`

## Files Added/Modified + Reason

### Added
- `packages/core/src/scenario/timing-reconciliation-types.ts` — Strongly typed reconciled contracts and structured error taxonomy. Reason: Phase 4D requires ReconciledDialogueClip/Scene/Plan preserving identities while exposing actual timing fields, ReconciledPlayback, ReconciledCaption, TimingReconciliationResult, and error codes MISSING_CANONICAL_CLIP, INVALID_DURATION, ZERO_DURATION, IDENTITY_MISMATCH, SCENE_MISMATCH, TURN_MISMATCH, CLIP_MISMATCH, SPEAKER_MISMATCH, VOICE_MISMATCH, VOICE_PROFILE_MISMATCH, SPOKEN_TEXT_MISMATCH, DUPLICATE_CLIP_ID, ORDERING_MISMATCH, OVERLAP_DETECTED, INVALID_PAUSE_CONFIG, RECONCILIATION_INVARIANT_FAILURE, MISSING_SCENARIO, MISSING_DIALOGUE_PLAN, MISSING_CANONICAL_MANIFEST.
- `packages/core/src/scenario/reconcile-dialogue-timing.ts` — Core dialogue reconciliation logic. Reason: Implements input validation for scenario/project/language/targetFormat/scene/turn/clip/voiceSlot/voiceProfile/spokenText, actual duration source only from CanonicalDialogueAudioManifest canonicalMetadata.durationSeconds (no estimator/SAM fallback), recomputed actualStart/End/TotalSpan preserving pause policy, scene boundary recomputation, total duration recomputation, determinism, overlap detection.
- `packages/core/src/scenario/reconcile-playback.ts` — Playback reconciliation. Reason: Produces actual-timing-compatible ReconciledPlaybackPlan, preserves visual beats but retimes them to match actual audio boundaries, preserves existing playback contract where safe, additive reconciled equivalent, matches actual audio boundaries, no breaking Phase 3D APIs.
- `packages/core/src/scenario/reconcile-captions.ts` — Caption reconciliation. Reason: Recomputes cue timing from actual speech intervals, exact text unchanged, cue ordering preserved, cues within source turn's actual interval, tile/cover per Phase 3E policy, final caption end not exceed actual turn end, no cross-turn caption, reuses Phase 3E word-weighted segmentation proportional to estimated durations.
- `packages/core/src/scenario/reconcile-timing.ts` — Orchestrator. Reason: Full pipeline Canonical + Dialogue → Reconciled Dialogue → Playback → Captions, deterministic, minimal public API for Phase 4E/5, builds TimingReconciliationResult summary.
- `tests/timing-reconciliation.test.ts` — 34 unit tests covering estimated vs actual, longer/shorter, turn order, pause policy, scene boundary, total duration, no overlaps, determinism, missing clip, identity mismatches, voice/text mismatches, duplicate, invalid duration, caption timing, playback/caption alignment.
- `tests/timing-reconciliation-integration.test.ts` — Real SAM integration test proving Scenario→DialogueAudioPlan→Voice Resolution→Synthesis→Normalization→Reconciliation→Playback→Captions with real local SAM and canonical normalization, proving estimated vs actual difference, reconciliation uses actual, turn start/end change, scene boundaries update, total duration updates, captions aligned, playback/captions same identity, no overlap, no rendering.

### Modified
- `packages/core/src/scenario/index.ts` — Export Phase 4D public API. Reason: Make reconciled timing types, reconciliation functions, structured errors available for Phase 4E/5.

## Timing Authority

- **Estimated source**: Phase 3C DialogueAudioPlan `clip.durationSeconds` computed via `estimateTurnDuration` from DEFAULT_DURATION_CONFIG (wordsPerMinute, pauseSeconds, etc.) and `plan-dialogue-audio.ts` transition/visualOnly buffers.
- **Actual source**: Only probed canonical audio duration from Phase 4C `CanonicalDialogueAudioManifest.results[].canonicalMetadata.durationSeconds` obtained via WAV header parsing (pure Node Buffer chunk iteration, no ffprobe) and canonical normalization via ffmpeg to 48000Hz mono pcm_s16le. Fail if missing/invalid, no estimator/SAM raw/text-length fallback.
- **Authoritative**: After Phase 4C, actual canonical duration is authoritative. Reconciliation replaces estimated speech timing with actual, preserving spoken text, no stretch/compress, no silence insertion, no waveform editing.
- **Pause/gap policy**: Preserve Phase 3C approved pause semantics. Rule: `actual clip duration + approved inter-turn pause → next clip start`. No silent removal or new arbitrary pauses. Preserve before/after/inter-turn/scene gaps. Documented in `reconcile-dialogue-timing.ts`: `actualTotalSpan = actualDuration + pauseAfter`, `nextStart = currentStart + totalSpan`. Transition and visualOnly buffers preserved from Phase 3C: `transitionSeconds = scene.transitionIntent?.durationSeconds ?? durationConfig.transitionAllowanceSeconds` if hasTransition, `visualOnlySeconds = durationConfig.nonDialogueBeatSeconds` if no turns. Next scene starts per scene-gap policy: `sceneEnd = lastClipStart + lastTotalSpan + transition + visualOnly`, `nextSceneStart = sceneEnd`.
- **Scene timing**: Recomputed boundaries from actual turn timings, scene start deterministic (previous scene end), turn order preserved, no overlaps unless allowed, scene duration expands/contracts, scene end reflects final speech+pauses, next scene starts per scene-gap policy, no identity/order change.
- **Total duration**: Recomputed from actual speech + approved pauses/gaps + scene transition/gap policy, not preserving old estimated total. Formula: `total = Σ(actualDuration) + Σ(pauseAfter) + Σ(transition) + Σ(visualOnly)`, rounded to 2 decimals for determinism.

## Reconciliation Architecture

### Input Contracts
- `Scenario` (metadata.id, projectId, language, targetFormat, scenes with id/order)
- `DialogueAudioPlan` (scenarioId, projectId, language, targetFormat, scenes with sceneId/order, clips with clipId/sceneId/turnId/speakerId/voiceSlot/spokenText/durationSeconds/pauseAfter/startTime/endTime/globalTurnIndex)
- `CanonicalDialogueAudioManifest` (scenarioId, language, results[] with clipId/sceneId/turnId/speakerId/voiceSlot/voiceProfileId/spokenText/canonicalPath/sourcePath/canonicalMetadata.durationSeconds)
- `ScenarioVisualPlan` (scenes with sourceSceneId, turnIds, beats)
- `ScenarioCaptionPlan` (scenarioId, scenes with cues, cues with turnId/clipId/text/startSeconds/endSeconds/durationSeconds)

### Identity Validation
1. Scenario ID continuity: scenario.metadata.id == dialoguePlan.scenarioId == canonicalManifest.scenarioId == visualPlan scenarioId == captionPlan scenarioId
2. Project ID: scenario.metadata.projectId == dialoguePlan.projectId
3. Language: scenario.metadata.language == dialoguePlan.language == canonicalManifest.language
4. Target format: scenario.metadata.targetFormat == dialoguePlan.targetFormat
5. Scene IDs/order: scenario.scenes.map(id) == dialoguePlan.scenes.map(sceneId)
6. Clip IDs: dialoguePlan.clips.map(clipId).sorted == canonicalManifest.results.map(clipId).sorted, missing → MISSING_CANONICAL_CLIP, extra → CLIP_MISMATCH
7. Duplicate clip IDs in canonical manifest → DUPLICATE_CLIP_ID (checked first)
8. Per-clip: turnId, sceneId, speakerId, voiceSlot, spokenText must match dialoguePlan clip vs canonical result, else TURN_MISMATCH, SCENE_MISMATCH, SPEAKER_MISMATCH, VOICE_MISMATCH, SPOKEN_TEXT_MISMATCH
9. Canonical duration must be finite number >0, else INVALID_DURATION or ZERO_DURATION
10. Ordering: canonical results order must equal dialoguePlan clips order by globalTurnIndex, else ORDERING_MISMATCH
11. PauseAfter must be finite >=0, else INVALID_PAUSE_CONFIG
12. Visual plan scene/turn IDs must match reconciled dialogue scenes, else SCENE_MISMATCH/TURN_MISMATCH

### Reconciled Dialogue Model
- `ReconciledDialogueClip`: clipId, sceneId, sceneIndex, turnId, turnIndex, globalTurnIndex, speakerId, voiceSlot, voiceProfileId, spokenText, intent, delivery, evidenceId, estimatedPath (original suggestedPath), canonicalPath, sourcePath, audioFormat (canonical), estimatedDurationSeconds, actualDurationSeconds (authoritative), pauseAfterSeconds (preserved), actualStartTimeSeconds, actualEndTimeSeconds (start+actualDuration), actualTotalSpanSeconds (actual+pause), canonicalMetadata
- `ReconciledDialogueScene`: sceneId, sceneIndex, title, estimatedStart/End/Duration, actualStart/End/Duration, transitionSeconds, visualOnlySeconds, clips[]
- `ReconciledDialogueAudioPlan`: schemaVersion, scenarioId, projectId, targetFormat, language, audioFormat (CANONICAL_AUDIO_FORMAT), durationConfig, allowSharedVoiceSlots, estimatedTotalDurationSeconds, actualTotalDurationSeconds, totalSpeechDurationSeconds (actual), totalPauseDurationSeconds (preserved), estimatedSpeechDurationSeconds, clipCount, characters, scenes[], clips[]

Recomputation algorithm:
```
currentTimeline = 0
for each scene in dialoguePlan.scenes order:
  sceneStartActual = currentTimeline
  for each clip in scene.clips order:
    actualDuration = canonicalManifest.byClipId[clipId].canonicalMetadata.durationSeconds
    pauseAfter = clip.pauseAfterSeconds (preserved)
    actualStart = currentTimeline
    actualEnd = actualStart + actualDuration
    totalSpan = actualDuration + pauseAfter
    push reconciledClip
    currentTimeline = actualStart + totalSpan
  currentTimeline += transitionSeconds + visualOnlySeconds
  sceneEnd = currentTimeline
  sceneDuration = sceneEnd - sceneStart
```

### Playback
- `ReconciledPlaybackPlan`: playbackVersion 1.0.0-reconciled, scenarioId, projectId, language, targetFormat, audioFormat, durationConfig, allowSharedVoiceSlots, audioBasePath, canonicalBasePath, estimatedTotalDurationMs, actualTotalDurationMs, totalSpeechMs, totalPauseMs, totalTransitionMs, totalVisualOnlyMs, dialogueCount, scenes[], dialogues[]
- `ReconciledPlaybackDialogue`: id (visual beat id preserved), globalIndex, sceneId, sceneIndex, turnId, turnIndex, visualBeatId, audioClipId, speakerId, reactingCharacterId, voiceSlot, voiceProfileId, spokenText, intent, delivery, evidenceIds, suggestedAudioPath, canonicalAudioPath, speech Interval (startMs = actualStart*1000, endMs = actualEnd*1000), pause Interval, turnSpan Interval, actualDurationSeconds, estimatedDurationSeconds
- `ReconciledPlaybackScene`: id, sourceSceneId, index, title, interval (actual scene start/end ms), dialogueSpan, transition (type, source, interval), beats[] (id, index, kind, interval, dialogueId), dialogueIds[], estimatedDurationMs, actualDurationMs
- Validates visual matches reconciled: scene IDs/order, turn IDs per scene
- Speech interval matches actual clip timing, pause interval is speechEnd to turnEnd, turnSpan is speechStart to turnEnd
- Transition beat interval uses transitionSeconds from reconciled scene, visualOnly uses visualOnlySeconds
- Last beat adjusted to end exactly at sceneEnd for tiling
- Overlap check: dialogues turnSpan non-overlapping
- Deterministic, no randomness

### Caption
- `ReconciledCaptionCue`: id, sceneId, sceneIndex, turnId, turnIndex, globalTurnIndex, clipId, text (exact unchanged), speakerId, voiceSlot, startTimeSeconds (actual), endTimeSeconds (actual), durationSeconds (actual), estimatedStart/End/Duration, wordCount, isSingleWord, globalCueIndex
- `ReconciledCaptionScene`: sceneId, sceneIndex, title, estimatedStart/End, actualStart/End, cues[], cueCount, estimatedDurationSeconds, actualDurationSeconds
- `ReconciledCaptionPlan`: schemaVersion 1.0.0-reconciled, scenarioId, projectId, targetFormat, language, estimatedTotalDurationSeconds, actualTotalDurationSeconds, cueCount, scenes[], cues[]
- Recomputation: for each clip, get original cues grouped by turnId, sorted by estimated start, distribute actualDuration proportionally to estimated durations (word-weighted, reuse Phase 3E segmentation where possible). If total estimated 0, distribute equally. Last cue absorbs rounding to end exactly at actualSpeechEnd. Verify cue within actual interval, ordering preserved, no overlap, final end not exceed actual turn end, no cross-turn caption.
- Text unchanged, cue IDs preserved, ordering preserved

### Invariant Checks
- Clip overlaps: curr.start + totalSpan <= next.start
- Scene overlaps: curr.end <= next.start
- Caption within actual turn: start >= actualStart, end <= actualEnd
- Caption ordering: end <= next.start within same turn, cross-turn no overlap
- Determinism: same Scenario/manifest/duration metadata/pause config → identical JSON output, no randomness/clock

## Real Integration Evidence

Pipeline executed in `tests/timing-reconciliation-integration.test.ts` with real local SAM and canonical normalization:

- **Scenario**: `scenario-pm-01` (progress-meeting), 12 clips, 3 scenes
- **DialogueAudioPlan**: estimated total 102s, scene 0 estimated 20.9s, clip estimated durations from DEFAULT_DURATION_CONFIG (e.g., clip_sc-01-hook_turn-01-sarah estimated 8.4s, clip_sc-01-hook_turn-02-marcus 11.6s, clip_sc-02-context_turn-03-marcus 7.2s)
- **Voice Resolution**: bySlot contains 2 slots, success
- **Audio Synthesis**: LocalDialogueSynthesizer (SAM) produces 22050Hz WAV, 12 files in `tmp-test-phase4d-int-.../audio/dialogue`, first file probe: sampleRate 22050, isCanonical false, duration 10.284s
- **Canonical Normalization**: FfmpegAudioNormalizer via @ffmpeg-installer/ffmpeg, command `ffmpeg -y -hide_banner -loglevel error -i src -ar 48000 -ac 1 -c:a pcm_s16le -f wav tgt`, 12 files in `tmp-test-phase4d-int-.../audio/canonical`, first file probe: sampleRate 48000, isCanonical true, duration 10.284s preserved, file size ratio 2.18 = 48000/22050
- **Reconciliation**:
  - Example estimated vs actual: clip_sc-01-hook_turn-01-sarah estimated 8.4s actual 10.284s delta +1.88s; clip_sc-01-hook_turn-02-marcus estimated 11.6s actual 12.489s delta +0.89s; clip_sc-02-context_turn-03-marcus estimated 7.2s actual 9.116s delta +1.92s
  - Original turn start/end: 0s/8.4s, 8.8s/20.4s, 20.9s/28.1s
  - Reconciled start/end: 0s/10.28s, 10.68s/23.17s, 23.67s/32.79s
  - Original scene 0 duration 20.9s reconciled 23.67s
  - Original total 102s reconciled 118.74s delta +16.74s
  - Proof reconciliation uses actual: reconciledClip.actualDuration == canonicalManifest.canonicalMetadata.durationSeconds for all clips
  - Turn start/end changed: at least one differs >0.01s (true, all differ)
  - Scene boundaries updated: actualStart/End recomputed, non-zero, identity preserved
  - Total duration updated: sumSpeech + sumPause + sumTransition + sumVisualOnly = actualTotal (within 0.1 tolerance due to rounding)
  - Captions aligned: all cues start >= clip.actualStart and end <= clip.actualEnd
  - Playback/captions same identity: scenarioId matches, playback dialogues 12 == reconciled clips 12, all caption cues have matching clipId
  - No overlap: clips non-overlapping, scenes non-overlapping
  - No rendering: only timing recomputed, canonical files unchanged and still exist

## Non-goals Confirmation
- No audio time-stretching, silence insertion, waveform editing, TTS replacement, voice quality change, Remotion, rendering, video, API routes, Web UI, export, Phase5/6/7
- No SAM quality change, no synthesizer replace, no redesign Phase3/4A/4B/4C
- Phase 4D additive, existing Scenario→Playback/Captions tests still pass, actual reconciliation separate explicit step, do not silently make compile functions depend on audio files
- Estimated-only callers unaffected: Phase 3C planDialogueAudio still works, Phase 3D compileScenarioPlayback still uses estimated timing, Phase 3E compileScenarioCaptions still uses estimated timing
- Backward compatibility: public API minimal for Phase 4E/5, existing tests pass

## Validation Results

- **Focused Phase4D**: 34 unit + 1 integration = 35 tests passed
  - `tests/timing-reconciliation.test.ts` 34 passed
  - `tests/timing-reconciliation-integration.test.ts` 1 passed (with evidence logs)
- **Phase4C**: 23 unit + 3 integration = 26 tests passed (audio-normalization.test.ts 23, audio-normalization-integration.test.ts 3)
- **Phase4B**: 24 unit + 5 integration = 29 tests passed (audio-synthesis.test.ts 24, audio-synthesis-integration.test.ts 5)
- **Phase4A**: 38 + 5 = 43 tests passed (voice-registry.test.ts 38, voice-integration.test.ts 5)
- **Phase3 playback/caption integration**: 15 tests passed (scenario-playback-caption-integration.test.ts)
- **Full npm test**: 24 files, 488 tests passed (previously 453, +35 new)
- **Typecheck**: `tsc -p packages/core/tsconfig.json --noEmit` passes, no errors
- **Build**: `tsc -p packages/core/tsconfig.json` succeeds, core dist built
- **Test-count guard**: 488 >= 240 required
- **Diff-check**: only allowed files changed (Phase4D contracts + logic + tests + handoff + index.ts), no Phase3/4A/4B/4C core logic modified except additive exports

## Recovery/Review

- **Implementation commit SHAs**: (to be filled after final commit, expected single commit with all Phase4D files)
- **Final HEAD**: (to be filled)
- **Branch**: `arena/01a0eeb0-video-factory`
- **Limitations**:
  - Probe only supports WAV header parsing (sufficient for SAM and canonical WAV), not mp3/ffprobe
  - Normalizer requires ffmpeg binary via @ffmpeg-installer/ffmpeg, already part of repo
  - Caption reconciliation reuses Phase 3E word-weighted proportional distribution, not forced alignment or ASR
  - Transition/visualOnly buffers preserved from Phase 3C, not recomputed from video analysis
  - Deterministic rounding to 2 decimals may cause 0.01s drift vs sum, tolerated with 0.1s tolerance in integration test
- **Files to inspect**:
  - `packages/core/src/scenario/timing-reconciliation-types.ts` — contracts and error taxonomy
  - `packages/core/src/scenario/reconcile-dialogue-timing.ts` — core reconciliation + validation
  - `packages/core/src/scenario/reconcile-playback.ts` — playback reconciliation
  - `packages/core/src/scenario/reconcile-captions.ts` — caption reconciliation
  - `packages/core/src/scenario/reconcile-timing.ts` — orchestrator + result builder
  - `packages/core/src/scenario/index.ts` — exports
  - `tests/timing-reconciliation.test.ts` — unit tests
  - `tests/timing-reconciliation-integration.test.ts` — real SAM integration with evidence
  - `PHASE4D_TIMING_RECONCILIATION_HANDOFF.md` — this file

## Acceptance Criteria (22 items)

1. **Reconciliation input validation**: scenario ID, project ID, language, target format, scene IDs/order, turn IDs/order, character/speaker IDs, clip IDs, voiceSlot, resolved VoiceProfile ID, spoken text — reject mismatches. ✅ Implemented in validateReconciliationInput, 10 error codes, unit tests 12-22
2. **Actual speech duration source only probed canonical**: uses canonicalMetadata.durationSeconds, fail if missing/invalid, no estimator/SAM fallback. ✅ In reconcile-dialogue-timing, checks finite >0, unit tests 18-19
3. **Reconciled dialogue timing contract**: strongly typed preserving identities exposing actual timing fields (scenario/scene/turn/clip identity, speaker/character, voice, spoken text ref, canonical path, actual duration, actual start/end, pause/gap). ✅ ReconciledDialogueClip/Scene/Plan with all fields
4. **Pause policy preserve Phase 3C**: actual clip duration + approved inter-turn pause → next clip start, no silent removal or new arbitrary pauses, preserve before/after/inter-turn/scene gaps, documented rule. ✅ In reconcile-dialogue-timing, documented, unit test 5
5. **Scene timing reconciliation**: recompute boundaries from actual turn timings, scene start deterministic, turn order preserved, no overlaps unless allowed, scene duration expands/contracts, scene end reflects final speech+pauses, next scene starts per scene-gap policy, no identity/order change. ✅ In reconcile-dialogue-timing, unit tests 4,6,8,9,11
6. **Total scenario duration recompute**: from actual speech + approved pauses/gaps + scene transition/gap policy, not preserve old estimated total. ✅ Formula sumSpeech+sumPause+sumTrans+sumVis, unit test 7, integration proves
7. **Playback reconciliation**: produce actual-timing-compatible ScenarioPlaybackPlan or minimal additive reconciled equivalent, preserve existing playback contract if safe, do NOT break Phase 3D APIs, must match actual audio boundaries. ✅ ReconciledPlaybackPlan, toScenarioPlaybackPlan compatibility, unit tests 23-25, integration proves
8. **Caption reconciliation**: recompute cue timing from actual speech intervals, exact text unchanged, cue ordering preserved, cues within source turn's actual interval, tile/cover per Phase 3E policy, final caption end not exceed actual turn end, no cross-turn caption, reuse Phase 3E segmentation where possible. ✅ In reconcile-captions, unit tests 26-30, integration proves
9. **Determinism**: given same Scenario/manifest/duration metadata/pause config identical outputs, no randomness/clock. ✅ No random, no Date.now in logic (only in manifest normalizedAt for info), unit tests 10,25,31,32
10. **Structured errors**: missing canonical clip, invalid/zero duration, identity mismatches, scene/turn/clip/speaker/voice/spoken-text mismatch, duplicate clip identity, ordering mismatch, overlap introduced, invalid pause config, invariant failure, follow existing conventions. ✅ TimingReconciliationError with 19 codes, unit tests 12-22
11. **Comprehensive unit tests**: estimated vs actual differences, longer/shorter audio, turn order, pause policy, scene boundary, total duration, no overlaps, determinism, missing clip, identity mismatches, wrong voice/text, duplicate clips, invalid duration, caption timing within actual speech, playback/caption alignment. ✅ 34 tests covering all
12. **Integration test real path**: Scenario→DialogueAudioPlan→Voice Resolution→Audio Synthesis→Audio Normalization→Actual Timing Reconciliation→Playback→Captions using real local SAM and canonical normalization, proving estimated vs actual difference, reconciliation uses actual, turn start/end change, scene boundaries update, total duration updates, captions aligned, playback/captions same identity, no overlap, no rendering. ✅ 1 integration test with evidence logs
13. **Backward compatibility**: do NOT modify Phase 3 behavior for estimated-only callers, Phase 4D additive, existing Scenario→Playback/Captions tests must pass, actual reconciliation separate explicit step, do not silently make compile functions depend on audio files. ✅ Phase3 tests still pass (scenario-playback-caption-integration 15 passed), compile functions unchanged
14. **Public API minimal for Phase 4E/5**: reconciled timing types, reconciliation function, reconciled playback/caption helpers, structured errors. ✅ Exported via index.ts, 4 files + types
15. **Non-goals**: no audio time-stretching, silence insertion, waveform editing, TTS replacement, voice quality, Remotion, rendering, video, API routes, Web UI, export, Phase5/6/7, no SAM quality change, no synthesizer replace, no redesign Phase3/4A/4B/4C. ✅ Confirmed, only additive
16. **Change control**: verify repo identity and branch contains af999d3, inspect only minimum files. ✅ Verified HEAD ancestry, inspected only required files, saved checkpoints
17. **Save checkpoints**: add contracts, reconcile dialogue/scene, reconcile playback/captions, tests. ✅ Done via incremental commits (to be squashed or separate, but files added in order)
18. **Create handoff**: Baseline, Files added/modified+reason, Timing authority, Reconciliation architecture, Real integration evidence, Non-goals confirmation, Validation results, Recovery/review. ✅ This file
19. **Pause policy documentation**: actual clip duration + approved inter-turn pause → next clip start, no silent removal or new arbitrary pauses, preserve before/after/inter-turn/scene gaps, document rule. ✅ Documented in timing-reconciliation-types and reconcile-dialogue-timing and handoff
20. **Scene boundary and total duration**: recomputed from actual, not preserved old estimated total. ✅ Implemented and tested
21. **Caption timing within actual speech**: exact text unchanged, ordering preserved, within turn interval, no cross-turn. ✅ Implemented and tested
22. **Determinism and structured errors**: identical outputs, no randomness, error taxonomy follows existing conventions. ✅ Implemented and tested
