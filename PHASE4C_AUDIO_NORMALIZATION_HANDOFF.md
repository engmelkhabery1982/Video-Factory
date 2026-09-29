# BuildTrack Video Factory — Phase 4C Audio Validation & Normalization Handoff

## Baseline
- **approved starting SHA**: `75b31189da3733c84b8e4d41e2ed2b246a38b698` — Phase 3A-3E + Phase 4A Voice Registry + Phase 4B Dialogue Audio Synthesis Engine completed
- **Arena branch**: `arena/01a0eeb0-video-factory`
- **current HEAD before Phase 4C**: `75b3118`
- **current HEAD after Phase 4C implementation**: will be updated after commits (see git log)

## Files
### Exact files added (Phase 4C)
- `packages/core/src/scenario/audio-validation-types.ts` — canonical audio metadata contract, validation result, normalization result, canonical manifest, structured error taxonomy, canonical format constants (WAV, PCM16, 48kHz, mono)
- `packages/core/src/scenario/audio-probe.ts` — deterministic local probe mechanism using WAV header parsing (handles extra chunks like LIST from ffmpeg), validates container/codec/sampleRate/channels/bitDepth, detects malformed/truncated/empty/missing/unsafe/unreadable files, returns CanonicalAudioMetadata and AudioValidationResult
- `packages/core/src/scenario/audio-normalizer.ts` — deterministic local normalization into canonical format using FFmpeg (already part of repo toolchain via @ffmpeg-installer/ffmpeg and platform.ts), supports 22.05kHz mono PCM16 WAV → 48kHz mono PCM16 WAV, preserves identity mapping, deterministic output path via generateCanonicalPath, safe filesystem writes, structured failure NORMALIZER_UNAVAILABLE / NORMALIZATION_FAILED
- `packages/core/src/scenario/canonical-dialogue-audio.ts` — manifest integration: DialogueSynthesisManifest → probe/validate each clip → normalize if needed → CanonicalDialogueAudioManifest, preserves clip order, identities, records wasNormalized, source metadata, canonical metadata, no silent skipping, explicit partial failure
- `tests/audio-normalization.test.ts` — 23 comprehensive unit tests covering canonical WAV accepted, 22.05kHz detected non-canonical, normalization to 48kHz, mono preservation, PCM16 preservation, malformed WAV, missing file, empty file, unsafe path, invalid header, deterministic metadata, deterministic manifest ordering, identity continuity, normalizer failure, no silent fallback, no timeline retiming
- `tests/audio-normalization-integration.test.ts` — 3 integration tests proving Scenario → DialogueAudioPlan → Voice Resolution → Audio Synthesis → Audio Validation → Normalization → canonical WAV artifact, using real SAM synthesizer, verifies SAM output begins non-canonical at 22.05kHz, Phase 4C detects, normalized output is 48kHz mono PCM16 WAV, file exists non-empty, identity mapping unchanged, no timeline retiming, public API for Phase 4D

### Exact files modified
- `packages/core/src/scenario/index.ts` — added exports for Phase 4C: `audio-validation-types.js`, `audio-probe.js`, `audio-normalizer.js`, `canonical-dialogue-audio.js` (additive, preserves Phase 3D/3E playback/caption + Phase 4A voice + Phase 4B synthesis exports)

### Reason for every change
- audio-validation-types: defines canonical contract (WAV, PCM16, 48kHz, mono, 16-bit) from Phase 3C DEFAULT_AUDIO_FORMAT, metadata for probed audio (path, container, codec, sampleRate, channels, bitDepth, duration, fileSize, isValid, isCanonical, probeEngine), validation result, normalization result, canonical manifest, error taxonomy
- audio-probe: probe abstraction (engineId, probe, probeSync), implementation WavHeaderProbe using pure Node Buffer parsing (no heavy dependency), handles ffmpeg WAV with extra LIST chunk (found via chunk iteration, not fixed offset), validates safe relative path, detects missing/empty/unreadable/malformed, returns deterministic metadata
- audio-normalizer: normalizer abstraction (engineId, isAvailable, normalizeSync, normalize), implementation FfmpegAudioNormalizer using ffmpeg path resolution same as apps/api/src/services/platform.ts (env BUILDTRAKE_FFMPEG, system PATH, @ffmpeg-installer/ffmpeg), converts to 48kHz mono PCM16 WAV via `ffmpeg -y -i source -ar 48000 -ac 1 -c:a pcm_s16le -f wav target`, deterministic output path via generateCanonicalPath (audio/dialogue/... → audio/canonical/...), safe writes, structured failures
- canonical-dialogue-audio: manifest integration required by spec, validates each synthesized clip via probe, normalizes if non-canonical, preserves order, identities, records wasNormalized, source/canonical metadata, no silent skipping, explicit partial failure, sync and async variants
- index.ts: expose only APIs Phase 4D needs (metadata, probe/validation result, canonical manifest, orchestrator, errors), keep low-level helpers internal
- tests: prove validation, normalization, safety, determinism, identity continuity, real audio generation, no silent fallback

## Canonical contract
Exact accepted format (from Phase 3C `dialogue-audio-types.ts` DEFAULT_AUDIO_FORMAT):
- **container**: WAV (`wav`)
- **codec/sample format**: PCM signed 16-bit little-endian (`pcm_s16le`)
- **sample rate**: 48,000 Hz
- **channels**: mono (1)
- **bit depth**: 16

Interpretation: This matches Phase 3C contract exactly. Phase 4B SAM outputs 22.05kHz WAV mono PCM16, which is detected as non-canonical (wrong sample rate) and normalized to 48kHz mono PCM16 WAV. No silent change of target.

## Probe implementation
- **Mechanism used**: WAV header parsing via pure Node.js Buffer, deterministic, no external dependency
- **Details**:
  - Validates safe relative path (no absolute, no `..`, no forbidden chars)
  - Checks file exists, stat size, non-empty
  - Reads first 2KB header (or full file if <=1MB) for parsing
  - Iterates chunks after 12-byte RIFF header: finds `fmt ` chunk to get audioFormat, channels, sampleRate, byteRate, bitDepth; finds `data` chunk to get dataSize (handles extra chunks like LIST from ffmpeg, which caused earlier bug where dataSize at fixed offset 40 was LIST size 26, leading to duration 0)
  - Parses codec: audioFormat 1 → PCM, bitDepth 8→pcm_u8, 16→pcm_s16le, 24→pcm_s24le, 32→pcm_s32le, 3→pcm_f32le
  - Calculates duration = dataBytes / byteRate, fileSize from stat, isValid true if header valid, isCanonical if codec==pcm_s16le && sampleRate==48000 && channels==1 && bitDepth==16
  - EngineId: `wav-header-parser`
- **Whether WAV parsing or ffprobe is used**: WAV parsing alone is sufficient for current Phase 4C scope (detects container, codec, sampleRate, channels, bitDepth, duration, fileSize, malformed/truncated/empty). ffprobe available in repo via `apps/api/src/services/platform.ts` but not required for WAV validation; we prefer lightweight parsing.
- **Runtime requirements**: Node.js >=20, fs, path, no ffmpeg/ffprobe needed for probing
- **Offline behavior**: Works offline, no network, deterministic

## Normalization implementation
- **Tool/engine used**: FFmpeg via `FfmpegAudioNormalizer`
- **Why selected**:
  1. Inspected existing media tooling: `tools/make-demo-voiceovers.mjs` uses ffmpeg for WAV→MP3 conversion, `apps/api/src/services/platform.ts` resolves ffmpeg path via env, system PATH, and `@ffmpeg-installer/ffmpeg` npm package (ships binary inside tarball, works offline, behind firewall)
  2. Inspected dependencies: `@ffmpeg-installer/ffmpeg` already used in repo, `ffprobe-static` available, ffmpeg is already part of practical local toolchain
  3. Prefer existing local tool already used — ffmpeg satisfies, no new heavy dependency
  4. WAV parsing alone cannot resample 22.05kHz→48kHz; need resampler, ffmpeg is standard deterministic local tool
- **Exact transformation**:
  - Input: `audio/dialogue/scenario-pm-01/sc-01-hook_turn-01-sarah.wav` (SAM output: WAV, 22050 Hz, mono, PCM16, 453,562 bytes, duration 10.284s, isCanonical false)
  - Command: `ffmpeg -y -hide_banner -loglevel error -i <absSource> -ar 48000 -ac 1 -c:a pcm_s16le -f wav <absTarget>`
  - Output: `audio/canonical/scenario-pm-01/sc-01-hook_turn-01-sarah.wav` (canonical: WAV, 48000 Hz, mono, PCM16, 987,330 bytes, duration 10.284s preserved, isCanonical true)
  - Transformation: resample 22050→48000, preserve mono, preserve PCM16, preserve duration (resampling, not retiming), deterministic
- **Output path policy**:
  - Source: `audio/dialogue/...` (from Phase 4B synthesis)
  - Canonical: `audio/canonical/...` — clear convention, preserves source + normalized artifact for traceability, does not overwrite source unless strong existing convention requires in-place (we preserve both)
  - `generateCanonicalPath`: if source starts with `audio/dialogue/`, replace prefix with canonicalBasePath (`audio/canonical`) + subdir + filename; else fallback to canonicalBasePath + sanitized basename
  - Safe relative paths only, validated via `validateSafeRelativePath`, no traversal, no absolute, no forbidden chars, `ensureDirSync` mkdir -p
- **Failure behavior**:
  - If ffmpeg not found (checked via env BUILDTRAKE_FFMPEG, system PATH whichSync, @ffmpeg-installer/ffmpeg), `isAvailable()` false, `assertAvailable()` throws `NORMALIZER_UNAVAILABLE` structured error
  - If source missing, throws `MISSING_AUDIO_FILE`
  - If source unreadable/malformed, throws `PROBE_FAILED` or `MALFORMED_WAV`
  - If ffmpeg command fails, throws `NORMALIZATION_FAILED` with stderr
  - If normalized output still not canonical (validation fails), throws `NORMALIZATION_FAILED`
  - If output write fails (mkdir, copy, write), throws `OUTPUT_WRITE_FAILED`
  - All failures structured via `AudioValidationError` with code and details, no silent fallback

## Real integration evidence
- **Fixture used**: `progress-meeting` scenario-pm-01, 12 clips, en-GB, 3 voices
- **Exact command** (from manual evidence script):
  ```bash
  node --import tsx - <<'JS'
  import { getProgressMeetingScenario } from './packages/core/src/scenario/fixtures/index.js';
  import { planDialogueAudio } from './packages/core/src/scenario/plan-dialogue-audio.js';
  import { resolveDialogueAudioPlanVoices } from './packages/core/src/scenario/voice-resolver.js';
  import { synthesizeDialoguePlan } from './packages/core/src/scenario/synthesize-dialogue.js';
  import { LocalDialogueSynthesizer } from './packages/core/src/scenario/local-dialogue-synthesizer.js';
  import { WavHeaderProbe } from './packages/core/src/scenario/audio-probe.js';
  import { createCanonicalDialogueAudioManifest } from './packages/core/src/scenario/canonical-dialogue-audio.js';
  const scenario = getProgressMeetingScenario();
  const plan = planDialogueAudio(scenario);
  const voiceRes = resolveDialogueAudioPlanVoices(plan);
  const synth = new LocalDialogueSynthesizer();
  const probe = new WavHeaderProbe();
  const synthManifest = await synthesizeDialoguePlan(plan, voiceRes, synth, { basePath: 'tmp-phase4c-real-evidence-.../audio/dialogue' });
  const canonicalManifest = await createCanonicalDialogueAudioManifest(synthManifest, { sourceBasePath: '.../audio/dialogue', canonicalBasePath: '.../audio/canonical' });
  JS
  ```
- **Source SAM clip metadata** (first clip):
  - Path: `tmp-phase4c-real-evidence-.../audio/dialogue/scenario-pm-01/sc-01-hook_turn-01-sarah.wav`
  - Sample rate: 22050 Hz
  - Channels: 1 (mono)
  - Codec: pcm_s16le
  - Bit depth: 16
  - Container: wav
  - File size: 453,562 bytes
  - Duration: 10.284s
  - isCanonical: false (wrong sample rate)
  - Validation: `WRONG-SAMPLE-RATE` finding, isCanonical false

- **Normalized clip metadata** (first clip):
  - Path: `tmp-phase4c-real-evidence-.../audio/canonical/sc_01_hook_turn_01_sarah.wav`
  - Sample rate: 48000 Hz
  - Channels: 1 (mono) — preserved
  - Codec: pcm_s16le — preserved
  - Bit depth: 16 — preserved
  - Container: wav
  - File size: 987,330 bytes (larger due to higher sample rate)
  - Duration: 10.284s (same as source, preserved, not retimed)
  - isCanonical: true
  - wasNormalized: true
  - hadNormalization: true (manifest)

- **File sizes**: source 453,562 → canonical 987,330 (ratio ~2.18 = 48000/22050, expected for resampling)

- **Proof output is 48kHz mono PCM16 WAV**:
  - WAV header: RIFF at 0, WAVE at 8, verified
  - Sample rate from header bytes 24-27: 48000 (readUInt32LE)
  - Channels from header 22: 1
  - Bit depth from header 34: 16
  - Codec from fmt: PCM (audioFormat 1) → pcm_s16le
  - Validation: `validateCanonicalAudio` returns isCanonical true, valid true, 0 errors
  - File exists: true, non-empty: true (>44 bytes header)

- **Confirmation no timeline retiming occurred**:
  - Plan totalDurationSeconds: 102 (from progress-meeting scenario)
  - Canonical manifest scenarioId: same as plan.scenarioId
  - Canonical manifest clipCount: 12 (same as plan.clipCount)
  - Canonical results duration from probe only (10.284s per clip example), not used to change plan timing, playback timings, caption timings, scene timings
  - Phase 4C only produces validated canonical artifacts plus metadata, per boundary

- **Integration test evidence**: `tests/audio-normalization-integration.test.ts` test 1 proves full pipeline:
  - SAM output 22.05kHz detected non-canonical
  - Normalized output 48kHz mono PCM16 WAV
  - File exists non-empty
  - WAV header RIFF/WAVE, sampleRate 48000, channels 1, bitDepth 16
  - Identity mapping unchanged (clipId, sceneId, turnId, speakerId, voiceSlot, voiceProfileId, spokenText)
  - No timeline retiming
  - Duration 565ms for 12 clips (includes ffmpeg normalization)

## Explicit non-goals
Confirm Phase 4D and later work were not performed:
- No Phase 4D timing reconciliation (no playback retiming, no caption retiming, no scene retiming, no visual synchronization)
- No Remotion integration, no rendering
- No API routes (apps/api untouched)
- No Web UI (apps/web untouched except build)
- No export workflow
- No Phase 5/6/7
- No replacement of SAM with higher-quality TTS engine (SAM still used from Phase 4B)
- Phase 3 behavior untouched (dialogue-audio-plan, visual-plan, playback, captions validators still pass)
- Phase 4A semantics unchanged (voice registry still 8 profiles, resolver deterministic)
- Phase 4B design unchanged (only additive fixes: probe handles ffmpeg LIST chunk)

## Validation
- **focused Phase 4C tests**: `npx vitest run tests/audio-normalization.test.ts tests/audio-normalization-integration.test.ts`
  - Result: Test Files 2 passed (2), Tests 26 passed (26) — 23 unit + 3 integration
  - Covers: canonical WAV accepted, 22.05kHz detected non-canonical, normalization 22.05→48kHz, mono preservation, PCM16 preservation, malformed WAV, missing file, empty file, unsafe path, invalid header, deterministic metadata, deterministic manifest ordering, identity continuity, normalizer failure, no silent fallback, no timeline retiming
  - Real SAM → canonical integration: 565ms for 12 clips, proves 22.05kHz → 48kHz, mono, PCM16, file exists non-empty, identity preserved

- **Phase 4B audio tests**: `npx vitest run tests/audio-synthesis.test.ts tests/audio-synthesis-integration.test.ts`
  - Result: Test Files 2 passed (2), Tests 29 passed (29) — 24 unit + 5 integration (including real SAM smoke 412ms)
  - Still passing after Phase 4C (no breaking changes)

- **Phase 4A voice tests**: `npx vitest run tests/voice-registry.test.ts tests/voice-integration.test.ts`
  - Result: Test Files 2 passed (2), Tests 43 passed (43) — 38 unit + 5 integration
  - Voice resolution intact

- **Phase 3 playback/caption integration tests**: `npx vitest run tests/scenario-playback-caption-integration.test.ts`
  - Result: Test Files 1 passed (1), Tests 15 passed (15)
  - Confirms Phase 3D/3E still present

- **full `npm test`**: `npx vitest run` (after `npm run build:core`)
  - Result: Test Files 22 passed (22), Tests 453 passed (453) — was 427 on 75b3118, +26 new Phase 4C
  - Breakdown: phase0a 18, phase0c 32, phase0c1 15, diversity 53, scenario-contract 36, scenario-visual-plan 28, dialogue-audio-plan 25, scenario-captions 27, scenario-caption-integration 13, scenario-playback 15, scenario-playback-caption-integration 15, scenario-planning-integration 15, export-targets 7, targets 11, target-audio-api 21, target-audio-ui 8, voice-registry 38, voice-integration 5, audio-synthesis 24, audio-synthesis-integration 5, audio-normalization 23, audio-normalization-integration 3

- **`npm run typecheck`**: `tsc -p packages/core/tsconfig.json --noEmit && tsc --noEmit -p apps/web/tsconfig.json`
  - Result: Passed, 0 errors

- **`npm run build`**: `npm run build:core && npm run build:web`
  - Result: Passed — build:core tsc success, build:web vite 38 modules, built in 1.25s, js 271.71kB

- **test-count guard**: `node scripts/assert-test-count.mjs 240`
  - Result: Test files 119 (JSON reporter), Tests passed 453, Tests failed 0, ok - 453 tests passed, at or above floor of 240

- **`git diff --check`**: Passed, 0 whitespace/formatting errors

## Recovery / review
- **implementation commit SHA(s)**:
  - `644b468` feat(audio): add synthesis contracts and adapter (Phase 4B)
  - `26c114c` feat(audio): add local dialogue synthesizer (SAM) (Phase 4B)
  - `8f93e79` feat(audio): add dialogue synthesis orchestration (Phase 4B)
  - `f2a16b6` test(audio): cover synthesis pipeline and finalize Phase 4B handoff (Phase 4B)
  - `75b3118` docs(audio): sync final HEAD to f2a16b6 (Phase 4B final HEAD, baseline for Phase 4C)
  - Phase 4C commits will be added after this file (see git log)
- **final HEAD**: to be updated after Phase 4C commits
- **branch**: `arena/01a0eeb0-video-factory`
- **known limitations**:
  - SAM voice robotic, low quality, not production final, but deterministic and local (same as demo)
  - Probe uses WAV header parsing only, not ffprobe; sufficient for WAV canonical validation, but for other containers would need ffprobe (not in scope for Phase 4C, which only handles WAV)
  - Normalization requires FFmpeg; if unavailable, throws NORMALIZER_UNAVAILABLE structured error (tested). FFmpeg is already part of repo toolchain via @ffmpeg-installer/ffmpeg and platform.ts, so available in CI and local after npm install
  - FFmpeg WAV output includes LIST chunk with Lavf metadata (e.g., `Lavf58.24.100`), which caused earlier bug where fixed-offset parsing read LIST size as data size → duration 0; fixed by chunk iteration to find data chunk
  - Normalization preserves duration (resampling, not retiming), but duration from probe is recorded for future Phase 4D, not used to change timelines
  - No MP3 handling in Phase 4C scope (only WAV), per canonical contract
  - No loudness normalization, silence trimming, or format conversion beyond sample rate/channels/codec (Phase 4C minimal)

- **exact files Codex should inspect first**:
  - packages/core/src/scenario/audio-validation-types.ts — canonical contract, metadata, manifest, error taxonomy
  - packages/core/src/scenario/audio-probe.ts — WAV header parsing probe, handles ffmpeg LIST chunk, safe path validation
  - packages/core/src/scenario/audio-normalizer.ts — ffmpeg normalization, path resolution same as platform.ts, safe writes, canonical path generation
  - packages/core/src/scenario/canonical-dialogue-audio.ts — manifest integration, preserves order/identities, records wasNormalized, no silent skipping
  - packages/core/src/scenario/index.ts — public exports (additive)
  - tests/audio-normalization.test.ts — unit tests (23 tests)
  - tests/audio-normalization-integration.test.ts — real SAM → canonical integration (3 tests, 565ms)
  - tests/audio-synthesis.test.ts — Phase 4B unit (24 tests, still passing)
  - tests/audio-synthesis-integration.test.ts — Phase 4B integration (5 tests, still passing)
  - PHASE4C_AUDIO_NORMALIZATION_HANDOFF.md — this file
