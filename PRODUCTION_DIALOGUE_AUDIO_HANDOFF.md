# Production Dialogue Audio Handoff — Workstream B (Final Production Integration)

**Branch**: `freebuff/production-dialogue-audio`
**Baseline SHA**: `05b02616d633eb931faaa875076d28d4a9e83d91` (`ci(phase6e): bootstrap one-time full production run`)
**Nature**: closes ONLY the production-quality synthesizer gap in Phase 4. No Phase 4 redesign, no renderer/API/UI/video changes, no full video render.
**Parallel workstream**: Arena owns `packages/core/src/scenario/index.ts` (untouched by this branch) and Content Engine phases 5/6.

---

## 1. What was added

### Production synthesizer
- `packages/core/src/scenario/kokoro-dialogue-synthesizer.ts`
  - `KokoroDialogueSynthesizer implements AudioSynthesizer` — `engineId: 'kokoro-js'`, `engineVersion: '1.2.1'`, `requiresNetwork: false` (synthesis is cache-only), `isLocal: true`.
  - Preserves exact `spokenText` (verbatim), `clipId`, `speakerId`, `voiceSlot`, `voiceProfileId`; writes **one physical WAV per clip** to the orchestrator's deterministic `targetPath` (24 kHz, mono, PCM16, 44-byte header — same writer pattern as the SAM adapter).
  - Deterministic voice mapping (`resolveKokoroVoice` + `KOKORO_VOICE_BY_SLOT`): 8 default registry slots → 8 **distinct** Kokoro voices (see §4). Unknown slots fall back deterministically by `voiceProfile.gender` (`female → af_heart`, `male → am_michael`), neutral/unspecified → `af_heart`. No character identity is inferred; voice assignment stays owned by the Phase 4A registry/resolver.
  - Constructor takes injectable `{ cacheDir?, modelId?, dtype? }` for tests.
  - Cache-only contract: sets transformers.js `env.cacheDir/localModelPath = <cacheDir>`, `allowRemoteModels = false`, `allowLocalModels = true`, `useBrowserCache = false`, `useFSCache = true`. Missing cache → structured `AudioSynthesisError('SYNTHESIZER_UNAVAILABLE', ...)` with the actionable message `Run 'npm run provision:tts' ...`. **Never falls back to SAM, never downloads silently.**
  - All failures are structured (`AudioSynthesisError` codes: `SYNTHESIZER_UNAVAILABLE`, `SYNTHESIS_FAILED`, `INVALID_TEXT`, `UNSAFE_PATH`, `OUTPUT_WRITE_FAILED`, `MALFORMED_SYNTHESIS_REQUEST`).
- `LocalDialogueSynthesizer` (SAM) untouched — remains default/reference engine.

### Production mode selection (backward compatible)
- `packages/core/src/scenario/dialogue-production-types.ts`: `DialogueProductionOptions.synthesizer` is now typed `AudioSynthesizer` (the `any` is gone); new `synthesisMode?: 'reference' | 'production'` (exported type `DialogueSynthesisMode`).
- `packages/core/src/scenario/dialogue-production-pipeline.ts`: selection rule —
  - explicit `options.synthesizer` **ALWAYS wins**;
  - `synthesisMode: 'production'` → `new KokoroDialogueSynthesizer()`;
  - default / `'reference'` → `new LocalDialogueSynthesizer()` (old tests unaffected).
  - Later Product Integration calls `buildDialogueProductionPlan(scenario, { synthesisMode: 'production', ... })`.

### Provisioning / cache
- `tools/provision-tts.mjs` + `npm run provision:tts` (bounded, idempotent, network used exactly once):
  1. verifies `kokoro-js` is installed;
  2. no-ops when `.tts-cache/.kokoro-model.ok` matches model/dtype/kokoro-js version;
  3. pre-verifies the pinned model repo files via the HF API before touching the cache;
  4. downloads through the **same transformers.js code path used at synthesis** into `.tts-cache/models/`;
  5. proves real 2-voice synthesis (`af_heart`, `bm_george`) before writing the success marker.
  - No destructive directory operations, no symlink-unsafe cleanup, never deletes user directories; only the repo-local `.tts-cache/` (gitignored in `.gitignore`) is managed.
- Proven in this environment: 89 MB cache (config.json, tokenizer.json, tokenizer_config.json, `onnx/model_quantized.onnx`), re-run reports `already provisioned`.

### Tests (dedicated)
- `tests/production-dialogue-audio.test.ts` — 15 gates: interface compliance, production selection, explicit-override precedence, reference-mode backward compat, no-silent-SAM-fallback (missing cache → structured `SYNTHESIZER_UNAVAILABLE`, no `sam-js` engine anywhere), 8 distinct voice mapping incl. gender prefix checks, per-turn output paths, safe relative paths, missing-cache structured failure, exact `spokenText` preservation, **real** multi-voice synthesis artifacts (non-empty, 24 kHz mono PCM16), canonical normalization to **48 kHz mono PCM16** via the unchanged ffmpeg pipeline, full `buildDialogueProductionPlan(..., { synthesisMode: 'production' })` identity/duration proof, no `tests/fixtures/render/dialogue.wav` usage, no network/API-key requirements.
- `tests/fixtures/scenarios/novel-production-audio.json` — short novel 2-scene/4-turn en-GB dialogue with 3 voice slots, used only by the proof (no shared fixture reuse).
- Real-synthesis gates auto-skip only if the cache marker is absent; all other gates always run.

---

## 2. Exact dependency / model identity

| Item | Value | License |
|---|---|---|
| npm package | `kokoro-js@1.2.1` (exact pin, devDependency — same tier as `sam-js`) | Apache-2.0 |
| Runtime dep | `@huggingface/transformers` 3.8.1 (pulled transitively) | Apache-2.0 |
| Model | `onnx-community/Kokoro-82M-v1.0-ONNX`, file `onnx/model_quantized.onnx` (`dtype: 'q8'`), CPU/WASM (`device: null`) | Apache-2.0 (verified via HF API tag `license:apache-2.0`) |
| Voices | 28 shipped in the npm package (`node_modules/kokoro-js/voices/*.bin`), loaded via fs in Node | Apache-2.0 |
| Normalization | unchanged `FfmpegAudioNormalizer` → `ffmpeg -ar 48000 -ac 1 -c:a pcm_s16le -f wav` | (unchanged Phase 4C) |

No paid API, no API keys, no voice cloning.

---

## 3. Cache strategy (summary)

- Repo-local `.tts-cache/models/` (transformers.js FS cache; also `env.localModelPath`).
- Provision once via `npm run provision:tts` (network ONCE). Normal production synthesis runs `env.allowRemoteModels = false` → zero network.
- Missing cache → structured `SYNTHESIZER_UNAVAILABLE` naming the fix command. No silent download, no SAM fallback.
- `.tts-cache/` added to `.gitignore` (not in the ownership list — flagged here as the only ignore-rule change).

---

## 4. Production voice mapping (deterministic, 8 distinct)

| voiceSlot (Phase 4A registry) | Kokoro voice | Note |
|---|---|---|
| `voice_en_female_authority` | `af_heart` | female, en-US, grade A |
| `voice_en_female_legal` | `bf_emma` | female, en-GB |
| `voice_us_female_analytic` | `af_nova` | female, en-US |
| `voice_en_male_practical` | `bm_george` | male, en-GB |
| `voice_en_male_commercial` | `am_michael` | male, en-US |
| `voice_en_male_advocate` | `bm_fable` | male, en-GB |
| `voice_us_male_executive` | `am_onyx` | male, en-US |
| `voice_us_male_field` | `am_adam` | male, en-US |

All 8 default slots map to 8 **distinct** voices; gender prefixes (`af/bf` female, `am/bm` male) match registry genders; fixture en-GB scenarios get stable British voices where available.

---

## 5. Real proof results (this environment)

- Provisioning: model downloaded + post-download 2-voice synthesis proof OK (7,020 ms, 24 kHz mono).
- Real synthesis of the novel scenario (`novel-production-audio.json`, 4 clips): all 4 succeed, engine `kokoro-js`, non-empty WAVs (24 kHz mono PCM16), voices used = {`af_heart`, `bm_george`, `am_michael`} (3 distinct), real durations > 0.2 s.
- Canonical stage (unchanged Phase 4C): 24 kHz sources normalized → 48 kHz / mono / `pcm_s16le` / 16-bit, `hadNormalization = true`, one canonical artifact per clip.
- Full pipeline in production mode: `success: true`, synthesis/canonical manifests aligned to plan clip count, `spokenText`/voice identity preserved end-to-end, reconciled actual durations match probed file durations.
- Per-turn artifacts: every dialogue turn has its **own physical file** (synthesis `outputPath` unique per clip; canonical path mirrored). No shared WAV, no `tests/fixtures/render/dialogue.wav`.
- No-SAM guarantee: production results report engine `kokoro-js` only; missing-cache runs fail structurally with no artifacts.

---

## 6. Validation results

| Check | Result |
|---|---|
| `tests/production-dialogue-audio.test.ts` (15 gates, incl. real synthesis) | 15/15 pass (~122 s) |
| audio-synthesis(.integration), audio-normalization(.integration), dialogue-production-integration, dialogue-production-negative | 64/64 pass |
| voice-registry, voice-integration, dialogue-audio-plan, timing-reconciliation(.integration), phase4-regression | 108/108 pass |
| Full suite (per-file, sandbox 180 s command ceiling; real-render files excluded) | 619/619 pass across 42 files run |
| Excluded per task constraints | `phase6b-real-render`, `phase6d-real-package`, `phase6c-real-short-render` (skip/real-render only; need gitignored `.browser/` Chromium = full video render), `phase6d-delivery-package` (real media packaging, > 180 s) |
| `node scripts/assert-test-count.mjs` | runs full suite internally; exceeds 180 s ceiling in sandbox. Summed per-file count **619 ≥ 300 floor** (was 604 → now 619 with the 15 new gates) |
| `npx tsc -p packages/core/tsconfig.json --noEmit` | OK |
| `npm run typecheck` (core + web) | OK |
| `npm run build` | OK (also refreshed stale gitignored `packages/core/dist`; fixes Track A test imports of `@buildtrack/core`) |
| `git diff --check` | clean |

Note: `tests/production-asset-resolution.test.ts` failed at baseline-clone state with `resolveProductionAssets is not a function` because the gitignored `dist/` predates Track A's src changes; after `npm run build` it passes 28/28 with **zero code changes** on our side.

---

## 7. Changed files (complete)

**Added**
- `packages/core/src/scenario/kokoro-dialogue-synthesizer.ts`
- `tools/provision-tts.mjs`
- `tests/production-dialogue-audio.test.ts`
- `tests/fixtures/scenarios/novel-production-audio.json`
- `PRODUCTION_DIALOGUE_AUDIO_HANDOFF.md` (this file)

**Modified**
- `packages/core/src/scenario/dialogue-production-pipeline.ts` (production-mode synthesizer selection)
- `packages/core/src/scenario/dialogue-production-types.ts` (typed `synthesizer`, added `synthesisMode`)
- `package.json` (devDep `kokoro-js@1.2.1` exact; script `provision:tts`)
- `package-lock.json` (kokoro-js subtree)
- `.gitignore` (`.tts-cache/`)

**NOT touched (ownership respected)**: `packages/core/src/scenario/index.ts`, scenario generation, `types.ts`, `apps/api/**`, `apps/web/**` source, `packages/video/**`, Phase 5/6 production code, `.github/**`, `scripts/phase6e-full-production-evidence.ts`, legacy storyboard pipeline, `LocalDialogueSynthesizer`, voice-registry/resolver (no changes needed).

---

## 8. For Product Integration

```ts
const result = await buildDialogueProductionPlan(scenario, {
  synthesisMode: 'production',            // KokoroDialogueSynthesizer
  synthesisBasePath: 'audio/dialogue',
  canonicalBasePath: 'audio/canonical',
  // synthesizer: custom AudioSynthesizer, // optional explicit override (always wins)
});
```
Prerequisite on a fresh machine: `npm install` then `npm run provision:tts` (once, with network). After that, production synthesis is fully offline; missing cache fails with a structured, actionable error instead of degrading.
