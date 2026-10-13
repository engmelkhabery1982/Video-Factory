# Milestone 3 — Arena delivery (Gemini provider adapter, planning and speech previews)

Base: `1b55176` (M2 round 3), branch `arena/890ccb82-video-factory`. M1 and M2 were not restarted or rebased.
This is an **incremental foundation**, not the complete M3 factory. Read §6 before relying on it.

## 1. Summary

What now exists, all in code and tests:

- A **Gemini REST adapter** (`generateContent` only) with API-key header auth, redacted errors, timeouts, cancellation, and no automatic fallback.
- **Strict plan validation** for structured text output. Malformed, blocked, or empty output fails safely. One schema repair is allowed inside the session budget.
- A **plan contract** with three treatments per profile (educational, religious, promotional). The validator enforces distinct methods, distinct shot sequences, full line coverage, supplied-only sources, and religious and product-mention rules.
- A **speech-preview contract**: one verbatim turn with the delivery style kept separate, a prebuilt voice, WAV validation, a 20-second limit, SHA-256 and provenance, and `approved: false`.
- **Persisted jobs** with idempotent keys, budget reservations, cancellation, restart handling (running becomes `interrupted`, never `succeeded`), and a late-result guard.
- **Capability states** computed without any network call.
- **Additive HTTP routes** under `/api/factory/ai/*`. The M2 routes are unchanged.
- A **Windows verification script** (`tools/gemini-verify.mjs`) with a catalog-only preflight, explicit free-tier confirmation, a budget ledger, one preview per profile, and redacted evidence.

What did **not** happen: no live provider call, no listening, no render, no UI wiring, no draft integration. See §5 and §6.

## 2. Provider documentation checked (13 October 2026)

| Topic | Source | Result used |
|---|---|---|
| Speech, REST, unary | `ai.google.dev/gemini-api/docs/generate-content/speech-generation` | `models/{model}:generateContent`; `generationConfig.responseModalities: ["AUDIO"]`; `speechConfig.voiceConfig.voice` (single speaker); `parts[].text` is the verbatim transcript; `parts[].speech_metadata.style` carries delivery. |
| Speech, audio output | same page, "Audio output formats" | Unary requests return a complete **WAV (RIFF), 24 kHz, mono, 16-bit PCM**. Streaming returns headerless L16 and is **not used**. Raw PCM is never wrapped by this code. |
| Speech, voices | same page, "Prebuilt voices" | 30 prebuilt voices (for example `Kore`, `Puck`). Only these are accepted. |
| Speech, languages | same page, "Supported languages" | Standard Arabic (Arab script) is listed for both 3.8 TTS models. **Per-voice language support is not published here. Arabic output quality is unverified.** |
| Speech, models | same page, "Supported models" | `gemini-3.8-flash-tts` and `gemini-3.8-flash-lite-tts` both support single and multi-speaker. |
| Structured output | `ai.google.dev/gemini-api/docs/generate-content/structured-output` | Go and JavaScript examples use `responseMimeType` and `responseJsonSchema`. **The REST example on the same page uses `generationConfig.responseFormat.text`.** The two are not reconciled by the docs. **This code uses `responseMimeType` + `responseJsonSchema`. This is an open live gate (§5).** |
| Interactions API | `ai.google.dev/gemini-api/docs/speech-generation`, `…/structured-output` | Not used. Its payloads are not interchangeable with generateContent. |
| Rate limits | `ai.google.dev/gemini-api/docs/rate-limits` | Limits are per project, not per key. RPM, TPM, and RPD apply. **Free tier: no spend-based limit.** RPD resets at midnight Pacific. A 429 `RESOURCE_EXHAUSTED` is the signal to stop. |
| Pricing | `ai.google.dev/gemini-api/docs/pricing` (page read in part), plus two secondary sources | Secondary sources state that the 3.8 Flash TTS models are listed as free of charge in the free-tier column, with **no published TTS-specific free allowance**. Paid rates change. **Confirm the current free-tier terms in AI Studio before enabling generation.** |

## 3. API additions (documented before any UI wiring)

All routes are additive. Responses never contain the key. The M2 routes are unchanged.

| Method and path | Purpose | Notes |
|---|---|---|
| `GET /api/factory/ai/status` | Capability state, budget usage, per-language speech evidence | No network call. Safe on page load. |
| `POST /api/factory/ai/plans` | Start a plan job | Body: `profile` (`educational`/`religious`/`promotional`), `format` (`landscape`/`portrait`), `brief` (10–4000 chars), optional `references` (≤10, `{id,text}`), optional `productFacts`, `productMentionRequested` (default false; refused for religious), optional `idempotencyKey`. Returns **202** with the job, or **200** if the same job already finished. |
| `POST /api/factory/ai/speech-previews` | Start one speech preview | Body: `text` (≤350 chars, no `<` or `>`), `style` (≤200 chars, optional), `voice` (one of the 30 prebuilt names), `language` (`ar`/`en`; Arabic must contain Arabic letters), optional `idempotencyKey`. Returns 202 or 200. |
| `GET /api/factory/ai/jobs/:id` | Poll a job | 404 for unknown or malformed ids. |
| `POST /api/factory/ai/jobs/:id/cancel` | Cancel a running job | A late provider result is discarded. |
| `GET /api/factory/ai/jobs/:id/audio` | Fetch a finished preview (`audio/wav`) | Only for succeeded speech-preview jobs. `Cache-Control: no-store`. |

Error body: `{ code, error }`. Codes added to `FACTORY_ERROR_CODES`: `FACTORY_PROVIDER_DISABLED` (403), `FACTORY_PROVIDER_CREDENTIALS_MISSING` (412), `FACTORY_PROVIDER_AUTH` (401), `FACTORY_PROVIDER_QUOTA` (429), `FACTORY_PROVIDER_TIMEOUT` (504), `FACTORY_PROVIDER_UNAVAILABLE` (503), `FACTORY_AI_INVALID_OUTPUT` (422), `FACTORY_BUDGET_EXHAUSTED` (429), `FACTORY_JOB_NOT_FOUND` (404), `FACTORY_JOB_CANCELLED` (409), `FACTORY_AUDIO_INVALID` (422).

Gates, in order, before any provider call: input validation → credentials present → `GEMINI_GENERATION_ENABLED=1` **and** `GEMINI_FREE_TIER_CONFIRMED=1` → idempotency lookup → budget reservation → call.

Environment (server side only): `GEMINI_API_KEY`, `GEMINI_TEXT_MODEL` (default `gemini-2.5-flash`), `GEMINI_TTS_MODEL` (default `gemini-3.8-flash-tts`), `GEMINI_GENERATION_ENABLED`, `GEMINI_FREE_TIER_CONFIRMED`, `GEMINI_SESSION_ID`, `GEMINI_BUDGET_TEXT` (≤2), `GEMINI_BUDGET_VOICE` (≤2), `GEMINI_TIMEOUT_MS` (5 000–120 000), `GEMINI_VERIFICATION_FILE`.

## 4. Verification run in this delivery

Environment: Node v22.22.3, `npm ci --ignore-scripts` in a clean worktree at `1b55176`. **Disclosure:** that install is a lockfile-only reproduction. No manifest or lockfile was changed.

| Check | Command | Result |
|---|---|---|
| Core build | `npm run build:core` | exit 0 |
| Web build | `npm run build:web` | exit 0 |
| API typecheck | `npx tsc --noEmit -p apps/api/tsconfig.json` | exit 0 |
| Web typecheck | `npx tsc --noEmit -p apps/web/tsconfig.json` | exit 0 |
| Affected tests | `npx vitest run tests/gemini-contract.test.ts tests/gemini-provider.test.ts tests/gemini-routes.test.ts tests/factory-api.test.ts tests/factory-planning.test.ts tests/factory-timing-provenance.test.ts` | **6 files, 152 tests passed** (contract 22, provider 34, routes 6, M2 factory-api 56, M2 planning 25, M2 timing 9) |
| Script gates | `node tools/gemini-verify.mjs` with no key, with a dummy key, and without flags | Each STOP happened before any call. The dummy key appeared in **no** output or evidence file. The preflight reported a network error (this sandbox cannot reach Google). |

Test doubles are labelled in code (`TEST DOUBLE` and `FIXTURE`). `tests/gemini/helpers.ts` holds them. No test reaches Google. `tests/gemini-routes.test.ts` stubs `globalThis.fetch` with a spy that fails the test if it is called.

These are **fixture and code-level** results. They are not live evidence.

## 5. LIVE gates: blocked in this sandbox

| Gate | Status | Why |
|---|---|---|
| Catalog reachable from the owner's machine | **Not checked** | This sandbox has no route to `generativelanguage.googleapis.com` (HTTP 000). |
| Text generation (structured plan) | **Blocked** | No `GEMINI_API_KEY` in the sandbox. Owner confirmation of a free-tier key is also required. |
| Speech generation, English | **Blocked** | As above. |
| Speech generation, Arabic | **Blocked** | As above. Arabic quality is also unverified by the docs. |
| Structured-output field naming | **Open** | The docs disagree (`responseMimeType`/`responseJsonSchema` vs `responseFormat.text`). The first live text run decides it. |
| Single-speaker voice field | **Open** | The REST sample uses `voiceConfig.voice`. The multi-speaker sample uses `prebuiltVoiceConfig.voiceName`. The first live speech run decides it. |
| Free-tier terms for TTS | **Open** | No TTS-specific free allowance is published. Check AI Studio. |
| Windows run of `tools/gemini-verify.mjs` | **Not run** | Owner step. See `LOCAL_VERIFY_STEPS.txt`. |

Per the M3 rules, no generation runs without the owner's confirmation and the two server flags. No paid fallback exists. Live results will be recorded by the script in the verification file, and the app will raise the capability state only from that record.

## 6. Not built in M3 (explicit)

- **UI.** `ContentPlan` and `Editor` do not call the new routes. No browser verification was run. The capability state is not shown anywhere in the UI yet.
- **Draft and storyboard integration.** Built at the API level in §11 (plan to draft, generated-draft edits, shot list). Not wired into the UI.
- **Speech in the apply/render path.** Built at the API level in §11: Gemini per-turn clips in `applyDraft`, with confirmed call count, budget gate, and clip reuse. `factory-speech.ts` (SAM) is unchanged and still used only for the SAM path.
- **Multi-speaker TTS.** The adapter sends one speaker per request. Two-speaker dialogue is not implemented.
- **Visuals.** Shot list and prompts for missing images exist at the API level (§11). Import and binding of supplied results is not built.
- **Approved-script immutability and derived rewrite.** Not built.
- **Product mention in the UI.** The validator enforces default-off and refuses religious mentions. There is no UI path.
- **Listening review.** No generated audio has been listened to. **Duration is not word alignment.**
- **Owner-host checks.** None.
- **Full-suite runs.** Not run, per the owner's instruction. Targeted tests only.

The factory is **not** declared complete.

## 7. Identity, budgets, and caching: what is actually guaranteed

- **Plan identity** = sha256 of `{profile, format, brief, references, productFacts, productMentionRequested, model}`, unless the caller passes its own `idempotencyKey`. A changed reference is a new job.
- **Speech identity** = sha256 of `{language, voice, text, style, model}`. Editing one line changes only that line's identity. Unchanged lines reuse their finished job with no new reservation and no new call.
- **Budgets.** Text ≤ 2 and voice ≤ 2 per session, enforced in code and capped by the constants. A reservation is made before the call and is **never refunded**. A failed attempt counts. This is conservative on purpose.
- **Restart.** Any job still `running` on startup becomes `interrupted` with a message. Nothing is reported as succeeded after a restart.
- **Cancellation.** The in-flight request is aborted and the transport is raced against the abort. A late success is not adopted; the job stays `cancelled`.

## 8. Known limits

- The job store is file-based and single-process. Concurrent processes are not coordinated.
- Speech identity is checked at the preview level only. It is not connected to the draft pipeline.
- The plan validator checks **structure**. It cannot judge whether a treatment changes the storytelling well, or whether a religious passage is handled faithfully. Those judgements need owner review.
- `GEMINI_BUDGET_*` values can lower the caps, never raise them. The script keeps its own ledger in `output/gemini-verify/budget.json`. The app's ledger is separate and lives under the data directory.
- M2 known limits still apply (see the M2 delivery documents).

## 9. Patch artifacts

Written after the commit and recorded in the handoff: see the final report. Patches are not committed to Git.

## 10. Files

Source: `packages/core/src/factory/gemini-contract.ts` (new), `contract.ts` (error codes, additive), `index.ts` (export); `apps/api/src/services/gemini-client.ts`, `gemini-store.ts`, `gemini-service.ts` (new); `apps/api/src/routes/factory-ai.ts` (new); `apps/api/src/server.ts` (one registration line).
Tooling: `tools/gemini-verify.mjs` (new).
Tests: `tests/gemini-contract.test.ts`, `tests/gemini-provider.test.ts`, `tests/gemini-routes.test.ts`, `tests/gemini/helpers.ts`.
Docs: `ARENA_DELIVERY.md` (this file), `PROVIDER_SETUP_AR.md`, `LOCAL_VERIFY_STEPS.txt`, `EVIDENCE_INVENTORY.md`.

## 11. Continuation: generated-draft flow at the API level (fixture-tested)

What is implemented and exercised by labelled doubles (no live provider call):

- `POST /api/factory/ai/plans/:jobId/draft` converts a succeeded plan job into the existing persisted draft model, with `generationMode: gemini_plan`. The three treatments are kept as semantic alternatives. Repeating the call returns `200` with the same draft.
- `PATCH /api/factory/drafts/:draftId/generated` edits unapproved narration (`edits[]` by `unitId`) and speaker choices (`speakers[]`). It uses `expectedRevision`. An edited line changes in every treatment. Supplied (approved) narration returns `FACTORY_SCRIPT_APPROVED` (409). A stale revision returns `409`. A draft that did not come from Gemini returns `FACTORY_NOT_GENERATED`. Asset bindings still use the existing `PATCH /api/factory/drafts/:id`, which reconciles the selected treatment.
- `GET /api/factory/drafts/:draftId/shot-list` returns the scene list, with prompts for missing images. `?format=md` returns the markdown package.
- `POST /api/factory/drafts/:draftId/apply` for a generated draft:
  - Refuses without `confirmSpeechCalls` when speech is needed, and makes no provider call. The count must equal the planned count. A wrong count returns `422` with the planned count in `speechCalls`.
  - Refuses before any call when the production budget cannot cover the planned calls (`429 FACTORY_BUDGET_EXHAUSTED`, with `remaining`). Nothing is truncated.
  - Makes one unary TTS call per line that has no cached clip. Stores real WAV assets with SHA-256, duration, and provenance, tagged unapproved.
  - Reuses clips by source unit when the treatment changes. An unchanged apply makes no provider call.
  - Rolls back the project, output, and index entries on failure.
- Fixes found by the end-to-end test:
  - `shot` is a server-owned scene field. It is preserved across patches and rejected if the client changes it.
  - Narration is looked up by `sourceUnitId`, not by scene id. Generated treatments have one scene per line per treatment.
  - Unit coverage counts source units, not scene ids.

Test evidence: `tests/factory-gemini-flow.test.ts` (16 of 16, real server via `buildServerApp`, labelled provider double). The affected set (`gemini-contract`, `gemini-provider`, `gemini-routes`, `gemini-transport-evidence`, `factory-gemini-flow`, `factory-api`, `factory-planning`, `factory-timing-provenance`) is 187 of 187. The core build and the API and web typechecks exit 0.

`tools/gemini-verify.mjs` now loads the real API in-process and calls the same routes (plan, draft, speech preview, job, audio). It requires `--qa-root` outside the repository. Its only direct provider call is the read-only `GET models` in `--preflight`. Offline checks run: every refusal gate, a redacted preflight failure with a placeholder key, and text and speech jobs that fail cleanly with a redacted code. No live generation has run.

### Not built in this continuation (explicit)

- **Web UI.** `ContentPlan.tsx` still hard-codes the offline `local_rules` mode, and it has no Generate, status, cancel, review, speaker preview, Apply-with-count, shot-list export, or asset-binding controls. `factory-api.ts` has only type changes. No browser test has been run. **The owner cannot yet test the Gemini flow from the UI.**
- **Asset import and binding of supplied results.** Not built. Missing assets are listed with prompts only.
- **Two derived previews (Arabic religious and English educational).** Not run. They need a live key and an integrated UI flow.
- **Approved-script immutability and derived rewrite.** Not built.

### Known limits (carried into this continuation)

- If a generated apply fails after some turns succeed, the rollback removes those clips and the draft speech cache is not saved. A retry will spend the production budget again.
- A failed or late provider attempt is counted by the app's ledger. Deleting the QA folder resets the ledger. Keep one folder per session.
- The service only reads verification records. The verification record is written by `tools/gemini-verify.mjs` after a real successful call. The app does not write it.
- `createDraftFromPlanJob` marks the draft `blocked` at creation. Readiness is recomputed by `refreshStatus` and the chosen speakers.
- The structured-output field naming (`responseFormat.text` with `APPLICATION_JSON`) is a live gate. The docs disagree on the literal, and the first live text run decides it.

The factory is **not** declared complete.

