# BuildTrack Video Factory — Phase 4A Voice Registry & Deterministic Voice Resolution Handoff (CORRECTED BASELINE)

## Baseline Correction
- **corrected baseline SHA**: `4be5e2df1365924f547dc751880999201e04e98f` — `fix(scenario): guard Phase 3D/3E integration and export public APIs` — approved Phase 3 closure checkpoint containing Phase 3D playback + Phase 3E captions + integration guards. Confirmed via `git ls-remote` and local `arena/01a0ed0c-video-factory` branch.
- **previous incorrect baseline**: `4816722adcea0002ab4701e764544ec265d5912a` — diverged history, missing Phase 3D/3E playback files (`compile-scenario-playback.ts`, `scenario-playback-types.ts`, `validate-scenario-playback.ts`, `scenario-playback-caption-integration.test.ts`, `scenario-caption-integration.test.ts`, etc.)
- **original Phase 4A implementation source commit**: `c6063296b2d54859a87e0959028b916c946d4d24` — feat(voice) on top of 4816722, preserved and transplanted.
- **new recovery branch**: `arena/01a0eeb0-video-factory-phase4a-corrected` — created exactly from `4be5e2d`, then reapplied Phase 4A changes only.
- **new Phase 4A code commit**: `dad7d60e65c20930628ffd0e1d5e0905dc38f7e3` — feat(voice) on corrected baseline.
- **final HEAD after docs**: will be updated after this file commit (see git log).
- **Arena original branch**: `arena/01a0eeb0-video-factory` still exists at `08d388a` with old baseline, but corrected branch is the valid Phase 4A on approved baseline.

## Scope implemented (relative to 4be5e2d)
Exact files changed (6 files, 1424 insertions):

- `packages/core/src/scenario/voice-types.ts` (new) — canonical VoiceProfile contract, error codes, options, validation report types
- `packages/core/src/scenario/voice-registry.ts` (new) — canonical registry DEFAULT_VOICE_REGISTRY with 8 profiles covering all fixture voiceSlots, plus validateVoiceRegistry() and createVoiceRegistry()
- `packages/core/src/scenario/voice-resolver.ts` (new) — deterministic resolution logic: resolveVoiceSlot(), resolveVoiceSlots(), resolveDialogueAudioPlanVoices(), isLanguageCompatible(), listKnownVoiceSlots(), getVoiceProfileById()
- `tests/voice-registry.test.ts` (new) — 38 comprehensive unit tests covering registry contract, duplicate/malformed detection, deterministic lookup, language compatibility, explicit fallback policy, helpers
- `tests/voice-integration.test.ts` (new) — 5 focused integration tests proving Scenario → DialogueAudioPlan → Voice Resolution for all 3 fixtures, determinism, and public API usability for Phase 4B
- `packages/core/src/scenario/index.ts` (modified) — added public exports for voice-types, voice-registry, voice-resolver (additive, preserves existing Phase 3D/3E exports: playback-types, compile-playback, validate-playback, caption-types, compile-captions, validate-captions)

Purpose:
- voice-types: defines provider-neutral VoiceProfile schema (id, voiceSlot, displayName, description, primaryLanguage, languages[], gender, roleHint, synthesisHints, enabled, version), error taxonomy (VoiceResolutionError with codes UNKNOWN_VOICE_SLOT, MISSING_PROFILE, DUPLICATE_VOICE_ID, DUPLICATE_VOICE_SLOT, INCOMPATIBLE_LANGUAGE, MALFORMED_REGISTRY_ENTRY, REGISTRY_VALIDATION_FAILED, DISABLED_VOICE_PROFILE, INVALID_VOICE_SLOT_FORMAT), resolution options, result types
- voice-registry: holds known profiles matching fixtures (voice_en_female_authority, voice_en_male_practical, voice_en_male_commercial, voice_en_female_legal, voice_en_male_advocate, voice_us_female_analytic, voice_us_male_executive, voice_us_male_field), validates duplicates/malformed entries, ensures primaryLanguage in languages, validates language codes, enabled boolean, etc.; frozen immutable registry
- voice-resolver: deterministic lookup from voiceSlot → VoiceProfile with language compatibility, explicit fallback only via fallbackMap, disabled check, structured errors; integration helper resolveDialogueAudioPlanVoices() for Phase 3C plan
- tests: prove contracts, error handling, determinism, and integration path

## Architecture
### VoiceProfile contract
- stable profile ID (e.g., `vp_en_female_authority_v1`)
- voiceSlot (canonical slot identifier, unique, e.g., `voice_en_female_authority`)
- displayName, description
- language / locale compatibility: primaryLanguage + languages array (must include primary)
- gender (female/male/neutral/unspecified), roleHint (authority, commercial, practical, legal, advocate, analytic, executive, field)
- provider-neutral synthesisHints (rate: slow/medium/fast/number, pitch: low/medium/high/number, style: string, stabilityHint, extra)
- enabled/disabled (boolean), version (string), createdAt (optional)
- No synthesis fields, no provider-specific API keys, no audio data

### Voice Registry
- DEFAULT_VOICE_REGISTRY: array of 8 profiles covering all fixture voiceSlots, frozen
- validateVoiceRegistry(): detects duplicate IDs (VOICE-REG-030), duplicate slots (VOICE-REG-031), malformed entries (missing id/slot/displayName/version, invalid language code, empty languages, primary not in languages, invalid enabled, invalid gender, etc.)
- createVoiceRegistry(): factory that validates and returns immutable copy, throws VoiceResolutionError on failure
- Registry is local, deterministic, no I/O, no network, validated at module load time
- Language codes validated via regex allowing BCP-47-ish forms (en, en-GB, en-US, fr-FR)

### Resolution rules
- trim + exact match on voiceSlot (case-sensitive, safe chars only)
- optional explicit fallbackMap: unknownSlot → knownSlot, only if caller provides it; records fallback usage (usedFallback, fallbackFrom)
- duplicate detection at validation time and resolver time (throws DUPLICATE_VOICE_SLOT)
- disabled profiles rejected unless allowDisabled=true (DISABLED_VOICE_PROFILE)
- deterministic: same input → same output, no randomness, no time dependence, sorted keys for deterministic output
- API: resolveVoiceSlot(slot, options), resolveVoiceSlots(slots, options), resolveDialogueAudioPlanVoices(plan, options)
- getEffectiveRegistry() validates registry on each call for safety

### Language compatibility policy
- isLanguageCompatible(requested, supportedLanguages, strictLanguageMatch):
  - exact case-insensitive match => compatible
  - base language match allowed by default: en-GB compatible with en, en-US compatible with en-GB (both base en), generic en compatible with specific en-GB
  - strictLanguageMatch=true requires exact match only
  - no requested language => always compatible (no check)
  - empty supported => incompatible
- If scenario language incompatible with profile → INCOMPATIBLE_LANGUAGE error with details (requestedLanguage, supportedLanguages, strictMatch)
- No silent substitution across languages; explicit error

### Fallback/error policy
- No implicit fallback: unknown slot → UNKNOWN_VOICE_SLOT error with availableSlots in details
- Missing profile → same code path
- Duplicate IDs/slots → DUPLICATE_VOICE_ID / DUPLICATE_VOICE_SLOT detected in validateVoiceRegistry() and during resolution
- Malformed entry → MALFORMED_REGISTRY_ENTRY or REGISTRY_VALIDATION_FAILED
- Incompatible language → INCOMPATIBLE_LANGUAGE
- Disabled → DISABLED_VOICE_PROFILE
- Invalid slot format → INVALID_VOICE_SLOT_FORMAT
- Explicit fallback only via fallbackMap option, which is logged in result (hadFallback, usedFallback); never substitutes unrelated voice silently
- Fallback target must exist in registry, otherwise UNKNOWN_VOICE_SLOT with fallbackTarget detail
- All errors are structured VoiceResolutionError with code, message, details (never plain Error for known cases)

## Explicit non-goals
- No text-to-speech generation
- No WAV/MP3 generation
- No external TTS providers (ElevenLabs/Azure/Google/OpenAI) — no imports, no network calls
- No FFmpeg
- No audio duration probing
- No playback timing reconciliation
- No Remotion changes
- No rendering
- No API routes (apps/api untouched)
- No Web UI (apps/web untouched except build)
- No export pipeline
- No Phase 5/6/7 work
- Phase 3D/3E contracts untouched (playback and captions preserved)

## Validation (on corrected baseline 4be5e2d + Phase 4A)
- focused Phase 4A tests:
  - `npx vitest run tests/voice-registry.test.ts tests/voice-integration.test.ts`
  - Result: Test Files 2 passed (2), Tests 43 passed (43) — 38 unit + 5 integration
  - Duration ~1s, determinism verified

- full `npm test`:
  - Command: `npx vitest run` (after `npm run build:core`)
  - Result: Test Files 18 passed (18), Tests 398 passed (398) — includes Phase 3D/3E + Phase 4A
  - Breakdown: phase0a 18, phase0c 32, phase0c1 15, diversity 53, scenario-contract 36, scenario-visual-plan 28, dialogue-audio-plan 25, scenario-captions 27, scenario-caption-integration 13, scenario-playback 15, scenario-playback-caption-integration 15, scenario-planning-integration 15, export-targets 7, targets 11, target-audio-api 21, target-audio-ui 8, voice-registry 38, voice-integration 5
  - No failures
  - Confirms Phase 3D/3E still present

- `npm run typecheck`:
  - Command: `tsc -p packages/core/tsconfig.json --noEmit && tsc --noEmit -p apps/web/tsconfig.json`
  - Result: Passed, 0 errors

- `npm run build`:
  - Command: `npm run build` → `build:core` + `build:web`
  - Result: Passed — build:core tsc success, build:web vite 38 modules, 1.36s, js 271.71kB

- test-count guard:
  - Command: `node scripts/assert-test-count.mjs 240`
  - Result: Test files 102 (JSON reporter), Tests passed 398, Tests failed 0, ok - 398 tests passed, at or above floor of 240

- `git diff --check`:
  - Result: Passed, 0 whitespace/formatting errors

- Phase 3D/3E integration guards specifically:
  - `tests/scenario-playback-caption-integration.test.ts` present and passing (15 tests): validates playback, audio, captions each validate against source, same scenario identity, same scene identity/order/boundaries, caption cues tile speech interval exactly, every cue maps to correct turn/clip/speaker/voice/reacting character, stays aligned under custom duration, refuses mismatched plans (different scenario, target-format/language mismatch, reordered scenes, timing disagreements, foreign turn IDs, etc.)
  - Phase 3D/3E public exports still present in `packages/core/src/scenario/index.ts`: `scenario-playback-types`, `compile-scenario-playback`, `validate-scenario-playback`, `scenario-caption-types`, `compile-scenario-captions`, `validate-scenario-captions` plus new voice exports
  - Playback metadata/scene/turn/timing integration guards preserved via existing tests

## Recovery / review
- corrected baseline SHA: `4be5e2df1365924f547dc751880999201e04e98f`
- original Phase 4A source commit: `c6063296b2d54859a87e0959028b916c946d4d24` (on top of 4816722, now transplanted)
- new branch: `arena/01a0eeb0-video-factory-phase4a-corrected`
- new Phase 4A code commit: `dad7d60e65c20930628ffd0e1d5e0905dc38f7e3`
- final HEAD after docs: to be updated in next commit (see git log)
- exact files changed relative to 4be5e2d: 6 files (3 voice impl + 2 tests + index.ts) — see `git diff --name-only 4be5e2d`
- conflicts encountered:
  - `packages/core/src/scenario/index.ts` had divergent content between 4816722-based Phase 4A (which added caption exports that were missing in 4816722) and 4be5e2d baseline (which already contained playback + caption exports). Resolution: kept 4be5e2d's existing playback/caption exports and added only the 3 voice exports (`voice-types`, `voice-registry`, `voice-resolver`). No duplication, no loss of Phase 3D/3E exports. Verified via `git diff` and `npm run typecheck`.
  - No other conflicts; voice files and tests were new files in both baselines, so clean add.
- known limitations:
  - Baseline SHA 4be5e2d confirmed via `git ls-remote origin` as `refs/heads/arena/01a0ed0c-video-factory` and fetched locally.
  - Voice registry 8 profiles matching existing fixtures; extension requires adding to DEFAULT_VOICE_REGISTRY.
  - Language compatibility base match by default, strict mode available.
  - No synthesis/audio generation per Phase 4A non-goals.

- exact files Codex should review first:
  - packages/core/src/scenario/voice-types.ts
  - packages/core/src/scenario/voice-registry.ts
  - packages/core/src/scenario/voice-resolver.ts
  - packages/core/src/scenario/index.ts (now includes playback + captions + voice)
  - tests/voice-registry.test.ts (38 tests)
  - tests/voice-integration.test.ts (5 tests)
  - tests/scenario-playback-caption-integration.test.ts (15 tests, confirms Phase 3D/3E still present)
  - PHASE4A_VOICE_REGISTRY_HANDOFF.md (this file)
