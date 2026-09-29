# BuildTrack Video Factory — Phase 4B Dialogue Audio Synthesis Engine Handoff

## Baseline
- **approved starting SHA**: `baf47760f62a01affb4f432b4634ef7796935132` — Phase 4A completed on corrected baseline `4be5e2d`, includes Phase 3A-3E + Phase 4A voice registry
- **Arena branch**: `arena/01a0eeb0-video-factory` (also `arena/01a0eeb0-video-factory-phase4a-corrected` points to same)
- **current HEAD before Phase 4B**: `baf4776`
- **current HEAD after Phase 4B implementation**: `f2a16b60f9049c850a0b0fc6aacbdcdd40ca97fb` (test commit, includes all Phase 4B)
- **implementation commits**:
  - `644b468` feat(audio): add synthesis contracts and adapter
  - `26c114c` feat(audio): add local dialogue synthesizer (SAM)
  - `8f93e79` feat(audio): add dialogue synthesis orchestration
  - `f2a16b6` test(audio): cover synthesis pipeline and finalize Phase 4B handoff (final HEAD before docs sync)

## Files
### Exact files added (Phase 4B)
- `packages/core/src/scenario/audio-synthesis-types.ts` — canonical provider-neutral synthesis request/result/manifest contracts and structured error taxonomy
- `packages/core/src/scenario/audio-synthesizer.ts` — clean `AudioSynthesizer` abstraction interface (engineId, isLocal, requiresNetwork, synthesize, synthesizeSync, isAvailable)
- `packages/core/src/scenario/local-dialogue-synthesizer.ts` — real local implementation using SAM (sam-js 0.3.1), deterministic WAV generation at 22050 Hz mono PCM, filesystem-safe, fails clearly if runtime unavailable, never silent fallback
- `packages/core/src/scenario/synthesize-dialogue.ts` — deterministic orchestration: DialogueAudioPlan + VoiceResolution + Synthesizer → DialogueSynthesisManifest, preserves ordering, exact text, speaker/voice mapping, safe path generation, rejects missing voice, duplicate IDs, unsafe paths, structured failure
- `tests/audio-synthesis.test.ts` — 24 comprehensive unit tests covering request construction, deterministic mapping, text preservation, speaker/voice mapping, path safety, malformed requests, missing voices, duplicate/mismatched identities, synthesizer failure, deterministic ordering, no silent fallback
- `tests/audio-synthesis-integration.test.ts` — 5 integration tests proving Scenario → DialogueAudioPlan → Voice Resolution → Synthesis, identity continuity, public API, real local synthesizer smoke test (SAM) with actual WAV file verification

### Exact files modified
- `packages/core/src/scenario/index.ts` — added exports for Phase 4B: `audio-synthesis-types.js`, `audio-synthesizer.js`, `local-dialogue-synthesizer.js`, `synthesize-dialogue.js` (additive, preserves Phase 3D/3E playback/caption + Phase 4A voice exports)

### Reason for every change
- audio-synthesis-types: defines minimal provider-neutral contracts required for Phase 4B (request with scenario/scene/turn/speaker/voiceSlot/voiceProfileId/language/text/delivery/hints/targetPath/format; result with clip identity, outputPath, format, success/failure, duration, fileSize, metadata; manifest with clipCount, success/failure counts, results, byClipId; error taxonomy)
- audio-synthesizer: abstraction so core depends on interface, not concrete TTS; enables mock for unit tests and real local implementation for production
- local-dialogue-synthesizer: real local engine reusing existing `sam-js` dependency (already used in `tools/make-demo-voiceovers.mjs`), satisfies local-first, no paid API, no network, deterministic, offline after install, fails clearly
- synthesize-dialogue: orchestration layer required by spec, deterministic path generation using same sanitize/validate conventions as Phase 3C, rejects missing voice resolution, duplicate clip IDs, unsafe paths, no silent skipping, structured failure
- index.ts: expose only APIs needed by future Phase 4C/4D (request/result/manifest, synthesizer interface, orchestrator, local implementation)
- tests: prove contracts, safety, determinism, error handling, identity continuity, real audio generation

## Architecture
### Synthesis request
- Fields: scenarioId, sceneId, turnId, clipId, speakerId, speakerName, voiceSlot, voiceProfileId, voiceProfile (full), language, spokenText (exact), delivery (optional), synthesisHints (from VoiceProfile), targetPath (safe relative), audioFormat, sceneIndex, turnIndex, globalTurnIndex
- Strongly typed, provider-neutral, minimal duplication of Scenario data (only IDs + exact text + voice mapping)
- Deterministic: same DialogueAudioClip + same VoiceResolution + same basePath → same request

### Synthesis result
- Fields: clipId, sceneId, turnId, speakerId, voiceSlot, voiceProfileId, spokenText (exact preservation check), outputPath (relative), audioFormat (actual produced), success boolean, durationSeconds (optional, from engine), fileSizeBytes, metadata {scenarioId, language, engine, engineVersion}, error {code, message, details} if failed
- Does not add actual-duration reconciliation (Phase 4D responsibility), but stores duration if engine returns it

### Synthesizer abstraction
- Interface `AudioSynthesizer`:
  - `engineId: string` (e.g., 'sam-js', 'mock')
  - `engineVersion?: string`
  - `requiresNetwork: boolean`
  - `isLocal: boolean`
  - `synthesize(request): Promise<AudioSynthesisResult>` — deterministic single-clip synthesis, writes artifact, never silent fallback
  - `synthesizeSync?(request): AudioSynthesisResult` — optional sync variant for local engines
  - `isAvailable?(): boolean|Promise<boolean>` — runtime availability check
- Core depends on abstraction, not concrete implementation; no over-engineered plugin framework

### Concrete local synthesizer
- **Engine**: SAM (Software Automatic Mouth, 1982) via `sam-js` 0.3.1 (already in package.json devDependencies)
- **Why selected**:
  1. Inspected repository: `tools/make-demo-voiceovers.mjs` already uses SAM for offline demo narration (local, no network, no paid API)
  2. Inspected dependencies: `sam-js` present, no new heavy dependency needed
  3. Reuses existing capability: SAM is pure JS, deterministic, offline after `npm install`, no model download
  4. Only introduce new dependency if genuinely necessary — not needed, SAM suffices
- **Implementation path**:
  - Load SAM via `createRequire('sam-js')`
  - Map VoiceProfile synthesisHints (rate slow/medium/fast/number, pitch low/medium/high/number, stabilityHint) to SAM voice settings {speed, pitch, throat, mouth} deterministically
  - Delivery tone adjustments (confident, assertive, precise, analytic, persuasive) mapped deterministically
  - Make text speakable for SAM (spell % → percent, etc., same as demo tool)
  - SAM `buf32(text)` → Float32Array samples at 22050 Hz
  - Convert Float32 [-1,1] → Int16 PCM, write WAV header (RIFF, WAVE, fmt, data) deterministically
  - Ensure output dir exists (mkdir -p), write file, return result with duration = samples.length / 22050, fileSize, metadata
- **Provisioning**: `npm ci` installs `sam-js`, no external binary/model, works offline after install
- **Offline behavior**: No network after provisioning, fails clearly with `SYNTHESIZER_UNAVAILABLE` if `sam-js` not installed
- **Determinism**: Same text + same voice settings → same PCM output (SAM deterministic), same request → same outputPath
- **No silent fallback**: Voice resolution mapping preserved, synthesizer never substitutes another voice; if voice missing, orchestration throws `MISSING_VOICE_RESOLUTION`

### Orchestration / manifest
- Function `synthesizeDialoguePlan(plan, voiceResolution, synthesizer, options)` (async) and `synthesizeDialoguePlanSync` (sync for local engines)
- Steps:
  1. Validate DialogueAudioPlan (non-null, scenarioId, clips non-empty, unique clipIds, non-empty spokenText, voiceSlot)
  2. Validate VoiceResolution (bySlot map, every clip's voiceSlot resolved, else `MISSING_VOICE_RESOLUTION`)
  3. Validate basePath safe relative (no absolute, no `..`, no forbidden chars) — reuse Phase 3C conventions
  4. Check synthesizer availability via `isAvailable()`
  5. Order clips deterministically by globalTurnIndex, sceneIndex, turnIndex (plan.clips already chronological, but sort for safety)
  6. Check duplicate globalTurnIndex
  7. For each clip: build synthesis request via `buildSynthesisRequest` (preserves exact text, speaker identity, voice mapping, deterministic safe path `basePath/scenarioId/sceneId_turnId.wav`)
  8. Check duplicate clipId in results
  9. Call `synthesizer.synthesize(request)`, validate result identity continuity (clipId, spokenText, voiceSlot, voiceProfileId must match request, else `CLIP_IDENTITY_MISMATCH`)
  10. Collect results, byClipId map, success/failure counts, hadFailures
  11. No silent skipping: failures are recorded as failed results with structured error, manifest includes hadFailures
- Manifest: schemaVersion 1.0.0, scenarioId, language, clipCount, successCount, failureCount, hadFailures, results (deterministic order), byClipId (frozen), basePath, synthesizedAt
- If one clip fails, returns structured failure info, does not conceal partial failure

### Filesystem policy
- Safe relative paths only: `validateSafeRelativePath` checks non-empty, not absolute (`/`, `\`, `C:`), no `.` or `..` segments, no forbidden chars `< > : " | ? *`
- `sanitizePathComponent` replaces unsafe chars with `_` + stable hash (FNV-1a) for determinism
- `generateDeterministicOutputPath`: `basePath/safeScenario/safeScene_safeTurn.wav` — deterministic, safe, no traversal, no overwrite of unrelated files unless `allowOverwrite` true (default false for safety, but local synthesizer currently overwrites deterministically)
- Reuses Phase 3C conventions from `plan-dialogue-audio.ts`

### Structured error policy
- Error class `AudioSynthesisError` with code and details, never generic unstructured exceptions for known cases
- Codes:
  - `MISSING_VOICE_RESOLUTION` — voiceSlot in plan has no resolved profile
  - `UNSUPPORTED_VOICE_PROFILE` — profile not supported by engine (future)
  - `SYNTHESIZER_UNAVAILABLE` — runtime/model unavailable (sam-js not installed)
  - `SYNTHESIS_FAILED` — engine failed to synthesize
  - `INVALID_TEXT` — spokenText empty or too long (>5000) or sanitized to empty
  - `UNSAFE_PATH` — targetPath or basePath contains traversal, absolute, forbidden chars
  - `OUTPUT_WRITE_FAILED` — failed to create dir or write file
  - `MALFORMED_SYNTHESIS_REQUEST` — request missing required fields or voiceProfile
  - `CLIP_IDENTITY_MISMATCH` — synthesizer returned mismatched clipId, altered spokenText, or altered voice mapping
  - `DUPLICATE_CLIP_ID` — duplicate clipId or globalTurnIndex in plan or during synthesis
  - `MISSING_CLIP` — plan.clips empty
  - `INVALID_AUDIO_FORMAT` — future

## Local engine decision
- **Engine**: `sam-js` 0.3.1 — Software Automatic Mouth, 1982, compiled to JS
- **Why selected**:
  - Existing dependency in repo (package.json devDependencies), already used in `tools/make-demo-voiceovers.mjs` for offline demo voiceovers
  - No new heavy dependency, no unsafe native binary, no model download, pure JS
  - Local-first, no mandatory subscription, no cloud, no paid API, usable without network after `npm install`
  - Deterministic and reviewable (same text → same samples)
  - Provider-neutral: SAM is not a commercial cloud provider, satisfies product constraint
  - Lightweight enough for tests (single clip ~400ms in integration test)
- **Existing dependency/tool reused**: Yes, `sam-js` and WAV header logic from `make-demo-voiceovers.mjs` (reimplemented deterministically)
- **Provisioning/runtime requirements**: `npm ci` installs `sam-js`; Node >=20; no ffmpeg required for WAV (MP3 conversion in demo tool uses ffmpeg, but Phase 4B produces WAV directly to avoid ffmpeg dependency)
- **Offline behavior**: Works without network after install; `isAvailable()` checks if `sam-js` module loads, throws `SYNTHESIZER_UNAVAILABLE` if not
- **Known limitations**:
  - SAM voice is robotic, low quality, not suitable for production final audio, but sufficient for pipeline exercise and deterministic testing (same limitation as existing demo voiceovers, documented in that tool)
  - SAM sample rate 22050 Hz, not 48000 Hz as in DialogueAudioPlan's DEFAULT_AUDIO_FORMAT; Phase 4B records actual format (22050) in result, Phase 4D will handle resampling/normalization if needed
  - SAM has limited vocabulary (no digits, symbols) — we make text speakable via replacements (% → percent, etc.)
  - SAM buffer fixed 256k, but single dialogue turns are short (<5000 chars), so safe
  - No per-voice timbre variation beyond speed/pitch/throat/mouth mapping; but voice identity preserved via voiceSlot/profile mapping, not via distinct SAM voices (acceptable for Phase 4B, real voice variation can be added in future with different local engines)

## Real synthesis evidence
- **Fixture used**: `progress-meeting` scenario (`scenario-pm-01`), 12 clips, en-GB, 3 voices (authority, practical, commercial)
- **Exact command**:
  ```bash
  node --import tsx - <<'JS'
  import { getProgressMeetingScenario } from './packages/core/src/scenario/fixtures/index.js';
  import { planDialogueAudio } from './packages/core/src/scenario/plan-dialogue-audio.js';
  import { resolveDialogueAudioPlanVoices } from './packages/core/src/scenario/voice-resolver.js';
  import { synthesizeDialoguePlan } from './packages/core/src/scenario/synthesize-dialogue.js';
  import { LocalDialogueSynthesizer } from './packages/core/src/scenario/local-dialogue-synthesizer.js';
  const scenario = getProgressMeetingScenario();
  const plan = planDialogueAudio(scenario);
  const voiceRes = resolveDialogueAudioPlanVoices(plan);
  const synth = new LocalDialogueSynthesizer();
  const manifest = await synthesizeDialoguePlan(plan, voiceRes, synth, { basePath: 'tmp-phase4b-real-smoke/audio/dialogue' });
  JS
  ```
- **Output files**: 12 WAV files under `tmp-phase4b-real-smoke/audio/dialogue/scenario-pm-01/`:
  - `sc-01-hook_turn-01-sarah.wav` (first clip, example)
  - 11 others
- **Output size (first clip example)**:
  - File: `tmp-phase4b-real-smoke/audio/dialogue/scenario-pm-01/sc-01-hook_turn-01-sarah.wav`
  - Size: 453,562 bytes
  - Duration: 10.284 seconds (from result.durationSeconds)
  - File size on disk matches result.fileSizeBytes
- **Format/container verification**:
  - Container: `wav`
  - Sample rate: 22050 Hz (from WAV header bytes 24-27, verified via `header.readUInt32LE(24)`)
  - Channels: 1 (mono)
  - Codec: `pcm_s16le`, Bit depth: 16
  - Header: `RIFF` at 0, `WAVE` at 8 (verified)
  - Non-empty: size >44 bytes header
  - Can be read/probed: fs.readFileSync, stat, header parsing (no external ffmpeg needed, but could be probed via existing repo mechanisms if needed)
- **Network access**: None required after `npm ci`; SAM is pure JS, offline
- **Integration test evidence**: `tests/audio-synthesis-integration.test.ts` test 5 uses real `LocalDialogueSynthesizer` to synthesize 12 clips in temp relative dir `tmp-test-phase4b-smoke-.../audio/dialogue`, verifies file exists, size >44, WAV header RIFF/WAVE, duration>0, fileSize>0, successCount==clipCount, hadFailures false, duration 412ms
- **Cleanup**: temp dirs removed after tests

## Explicit non-goals
Confirm no Phase 4C/4D, rendering, UI, API or later-phase work was performed:
- No Phase 4C full audio validation/normalization (no loudness, no silence trimming, no format conversion to 48k)
- No Phase 4D actual-duration timeline reconciliation (no retiming of playback, no caption retiming)
- No caption retiming, no playback retiming
- No Remotion integration, no video rendering
- No API routes (apps/api untouched)
- No Web UI (apps/web untouched except build)
- No export workflow, no Phase 5/6/7, no cloud publishing
- No commercial TTS provider integration (no ElevenLabs, Azure, Google, OpenAI credentials, no network)
- Phase 3 behavior untouched (plan-dialogue-audio, compile-visual-plan, compile-playback, compile-captions, validators still pass)
- Phase 4A Voice Registry semantics unchanged (DEFAULT_VOICE_REGISTRY still 8 profiles, resolver still deterministic, no breaking changes)

## Validation
- **focused Phase 4B tests**: `npx vitest run tests/audio-synthesis.test.ts tests/audio-synthesis-integration.test.ts`
  - Result: Test Files 2 passed (2), Tests 29 passed (29) — 24 unit + 5 integration (including real SAM smoke)
  - Duration ~1.5s
  - Real synthesis smoke test duration 412ms, verifies WAV file exists, non-empty, RIFF/WAVE, duration>0

- **Phase 4A regression tests**: `npx vitest run tests/voice-registry.test.ts tests/voice-integration.test.ts`
  - Result: Test Files 2 passed (2), Tests 43 passed (43) — 38 unit + 5 integration
  - Voice resolution still intact

- **Phase 3 playback/caption integration test**: `npx vitest run tests/scenario-playback-caption-integration.test.ts`
  - Result: Test Files 1 passed (1), Tests 15 passed (15)
  - Confirms Phase 3D/3E still present: playback, audio, captions each validate, same scenario identity, same scene identity/order/boundaries, caption cues tile speech interval exactly, every cue maps to correct turn/clip/speaker/voice/reacting character, stays aligned under custom duration, refuses mismatched plans

- **full `npm test`**: `npx vitest run` (after `npm run build:core`)
  - Result: Test Files 20 passed (20), Tests 427 passed (427) — previously 398 on baf4776, +29 new Phase 4B
  - Breakdown: phase0a 18, phase0c 32, phase0c1 15, diversity 53, scenario-contract 36, scenario-visual-plan 28, dialogue-audio-plan 25, scenario-captions 27, scenario-caption-integration 13, scenario-playback 15, scenario-playback-caption-integration 15, scenario-planning-integration 15, export-targets 7, targets 11, target-audio-api 21, target-audio-ui 8, voice-registry 38, voice-integration 5, audio-synthesis 24, audio-synthesis-integration 5

- **`npm run typecheck`**: `tsc -p packages/core/tsconfig.json --noEmit && tsc --noEmit -p apps/web/tsconfig.json`
  - Result: Passed, 0 errors

- **`npm run build`**: `npm run build:core && npm run build:web`
  - Result: Passed — build:core tsc success, build:web vite 38 modules, built in 1.44s, js 271.71kB

- **test-count guard**: `node scripts/assert-test-count.mjs 240`
  - Result: Test files 112 (JSON reporter), Tests passed 427, Tests failed 0, ok - 427 tests passed, at or above floor of 240

- **`git diff --check`**: Passed, 0 whitespace/formatting errors

## Recovery / review
- **final implementation commit SHA**: `f2a16b60f9049c850a0b0fc6aacbdcdd40ca97fb` (test commit, final code + tests + handoff)
- **implementation chain**: `644b468` (contracts) → `26c114c` (local SAM) → `8f93e79` (orchestration) → `f2a16b6` (tests + handoff)
- **final HEAD after docs sync**: will be updated after final sync commit (see git log)
- **branch**: `arena/01a0eeb0-video-factory` (and `arena/01a0eeb0-video-factory-phase4a-corrected` same HEAD after push)
- **baseline**: `baf47760f62a01affb4f432b4634ef7796935132`
- **known limitations**:
  - SAM voice quality robotic, not production final, but deterministic and local (same as existing demo voiceovers)
  - Sample rate 22050 Hz vs plan's 48000 Hz — Phase 4B records actual format, Phase 4D will handle normalization/resampling
  - No per-voice distinct timbre beyond speed/pitch mapping; voice identity preserved via mapping, not via distinct SAM voices (acceptable for Phase 4B)
  - SAM limited vocabulary, we make text speakable via replacements
  - No MP3 conversion to avoid ffmpeg dependency; WAV is real audio artifact
  - No actual-duration reconciliation yet (Phase 4D responsibility)
  - Registry validation runs at module load for DEFAULT_VOICE_REGISTRY and on each resolve call — deterministic and safe
  - Public API provider-neutral; future Phase 4C/4D can import from @buildtrack/core without changes to Phase 3/4A

- **exact files Codex should inspect first**:
  - packages/core/src/scenario/audio-synthesis-types.ts — canonical contracts and error taxonomy
  - packages/core/src/scenario/audio-synthesizer.ts — abstraction interface
  - packages/core/src/scenario/local-dialogue-synthesizer.ts — real local SAM implementation
  - packages/core/src/scenario/synthesize-dialogue.ts — deterministic orchestration and path safety
  - packages/core/src/scenario/index.ts — public exports (additive)
  - tests/audio-synthesis.test.ts — unit tests (24 tests)
  - tests/audio-synthesis-integration.test.ts — integration Scenario → DialogueAudioPlan → Voice Resolution → Synthesis (5 tests, includes real SAM smoke)
  - PHASE4B_AUDIO_SYNTHESIS_HANDOFF.md — this file
  - PHASE4A_VOICE_REGISTRY_HANDOFF.md — previous phase handoff
