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

What did **not** happen at this point: no live provider call, no listening, no render. The UI wiring, draft integration and partial-apply retry were added later; see §12. Live gates remain in §5 and §12.

## 2. Provider documentation checked (13 October 2026)

| Topic | Source | Result used |
|---|---|---|
| Speech, REST, unary | `ai.google.dev/gemini-api/docs/generate-content/speech-generation` | `models/{model}:generateContent`; `generationConfig.responseModalities: ["AUDIO"]`; `speechConfig.voiceConfig.voice` (single speaker); `parts[].text` is the verbatim transcript; `parts[].speech_metadata.style` carries delivery. |
| Speech, audio output | same page, "Audio output formats" | Unary requests return a complete **WAV (RIFF), 24 kHz, mono, 16-bit PCM**. Streaming returns headerless L16 and is **not used**. Raw PCM is never wrapped by this code. |
| Speech, voices | same page, "Prebuilt voices" | 30 prebuilt voices (for example `Kore`, `Puck`). Only these are accepted. |
| Speech, languages | same page, "Supported languages" | Standard Arabic (Arab script) is listed for both 3.8 TTS models. **Per-voice language support is not published here. Arabic output quality is unverified.** |
| Speech, models | same page, "Supported models" | `gemini-3.8-flash-tts` and `gemini-3.8-flash-lite-tts` both support single and multi-speaker. |
| Structured output (superseded by §12) | `ai.google.dev/gemini-api/docs/generate-content/structured-output` | Go and JavaScript examples use `responseMimeType` and `responseJsonSchema`. **The REST example on the same page uses `generationConfig.responseFormat.text`.** The two are not reconciled by the docs. **This code uses `responseMimeType` + `responseJsonSchema`. This is an open live gate (§5).** |
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
| Structured-output field naming | **Sent per the primary reference** (§12) | The request uses `generationConfig.responseFormat.text` with `mimeType: APPLICATION_JSON` and `schema`. Live acceptance is not yet observed. Spelling variants are not tried against the provider. |
| Single-speaker voice field | **Open** | The REST sample uses `voiceConfig.voice`. The multi-speaker sample uses `prebuiltVoiceConfig.voiceName`. The first live speech run decides it. |
| Free-tier terms for TTS | **Open** | No TTS-specific free allowance is published. Check AI Studio. |
| Windows run of `tools/gemini-verify.mjs` | **Not run** | Owner step. See `LOCAL_VERIFY_STEPS.txt`. |

Per the M3 rules, no generation runs without the owner's confirmation and the two server flags. No paid fallback exists. Live results will be recorded by the script in the verification file, and the app will raise the capability state only from that record.

## 6. Not built in M3 (explicit)

- **UI.** Superseded by §12: `ContentPlan` now has the Gemini workflow. Browser verification was not run (§12.5).
- **Draft and storyboard integration.** Built at the API level in §11 and wired into the UI in §12.
- **Speech in the apply/render path.** Built at the API level in §11: Gemini per-turn clips in `applyDraft`, with confirmed call count, budget gate, and clip reuse. `factory-speech.ts` (SAM) is unchanged and still used only for the SAM path.
- **Multi-speaker TTS.** The adapter sends one speaker per request. Two-speaker dialogue is not implemented.
- **Visuals.** Shot list and prompts for missing images exist at the API level (§11). Import and binding of supplied results is not built.
- **Approved-script immutability and derived rewrite.** Not built.
- **Product mention in the UI.** `GeminiPlanPanel` has the opt-in checkbox (default off, disabled for religious) and the supplied-facts textarea. DOM test: `tests/web/gemini-plan-flow.test.tsx`. Insertion into the draft is built (see §14 and `tests/factory-product-mention.test.ts`, 8 tests). Not checked in a rendered video.
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

- **Web UI.** Superseded by §12. The offline `local_rules` mode is now an explicit choice next to Gemini. No browser test has been run. **The owner cannot yet test the Gemini flow from the UI.**
- **Asset import and binding of supplied results.** Not built. Missing assets are listed with prompts only.
- **Two derived previews (Arabic religious and English educational).** Not run. They need a live key and an integrated UI flow.
- **Approved-script immutability and derived rewrite.** Not built.

### Known limits (carried into this continuation)

- (Superseded by §12.3.) A partial apply no longer re-spends: validated per-turn clips are kept in a private source-identity cache, and a retry reuses them.
- A failed or late provider attempt is counted by the app's ledger. Deleting the QA folder resets the ledger. Keep one folder per session.
- (Superseded by §12.4.) After a real successful call the app records bound evidence itself. Labelled doubles never write it.
- `createDraftFromPlanJob` marks the draft `blocked` at creation. Readiness is recomputed by `refreshStatus` and the chosen speakers.
- The structured-output field naming is sent per the primary reference (§12). Live acceptance is still a gate.

The factory is **not** declared complete.

## 12. Continuation 2: owner workflow in ContentPlan, retry-safe apply, shot lists

Status by item. "Fixture" means a labelled provider double answered the Google endpoint. No live Google call was made in this continuation.

| Item | Status | Evidence |
|---|---|---|
| Explicit choice of `local_rules` or Gemini on the planning page | Built | `tests/web/gemini-plan-flow.test.tsx` (DOM, real API routes) |
| Gemini panel: status, gate reasons, brief, references, free-tier tick, Generate | Built | DOM suite; `tests/web/gemini-client-contract.test.ts` (gate) |
| Job progress, Cancel, late result never adopted | Built | DOM suite (cancelled plan, late provider answer, no draft, no success) |
| Three semantic treatments kept as alternatives | Built | `tests/factory-gemini-flow.test.ts` (API), DOM adoption |
| Generated (unapproved) narration editing, one revision-checked save | Built | DOM suite; `tests/factory-gemini-flow.test.ts` |
| Stale draft edit refused, typed text kept, nothing on the server | Built | DOM suite (conflict, reopen) |
| Voices and style, short speaker preview, save voices | Built | DOM suite (one preview, one voice saved, no extra call) |
| Shot list rows, JSON and Markdown export, prompts for missing images | Built | DOM suite (rows and export links); `tests/factory-gemini-flow.test.ts` |
| Asset binding through the existing draft PATCH, blockers stop Apply | Built | DOM suite (blockers, disabled Apply, saved selection) |
| Apply: count shown before confirmation, bound to revision, re-confirm on change | Built | DOM suite (count equals provider calls made); `tests/factory-gemini-flow.test.ts` |
| Re-apply of an unchanged revision: no call, same project | Built | DOM suite and `tests/factory-turn-cache.test.ts` |
| Partial-apply retry with no second spend for a validated turn | Built | `tests/factory-turn-cache.test.ts` (8 of 8) |
| Bound verification evidence written by the app after a real success | Built, not exercised live | `recordLiveEvidence` in `gemini-service.ts`; labelled doubles are excluded |
| Browser gate | **Not run** (§12.5) | |

### 12.1 Owner path (ContentPlan)

1. Choose **Offline rules (labelled)** or **Gemini (explicit)**. Offline rules never call AI. Gemini never runs on page load.
2. Gemini: the panel reads `GET /api/factory/ai/status` (no provider call). Generate stays disabled with the exact reason until: a key exists, both server flags are on, the session text budget is not spent, no plan is running, there are no unsaved draft edits, the brief is written, and the free-tier box is ticked.
3. Generate starts one plan job. The job id is kept in `localStorage` (`vf.gemini.activePlanJob`) and resumed by a status read only. Cancel is shown while running.
4. A succeeded job becomes a draft (`POST …/draft`, idempotent). The draft id is kept in the address bar, so reopening restores it.
5. The scene table shows generated narration in editable fields. **Save narration edits** sends only changed rows. Selection save and treatment switch are refused while narration edits are unsaved.
6. Pictures: each scene has a library picture select (existing route). Library upload asks for source and licence first.
7. Voices: pick a voice and style per speaker. **Preview this voice** starts one short preview job (budget shown). **Save voices and style** sends voice and style only.
8. Apply: the page shows the planned speech-call count and the remaining production turns before any confirmation. Confirm reads that count back to the server. A count change returns `422` with the new count and calls nothing.

### 12.2 Exact payloads (what the page sends)

| Method and path | Body | Notes |
|---|---|---|
| `GET /api/factory/ai/status` | none | Read only. |
| `POST /api/factory/ai/plans` | `{profile, format, brief, references?:[{id,text}], productFacts?:[{id,text}], productMentionRequested?, idempotencyKey?}` | `productMentionRequested` is sent false for religious profiles. |
| `GET /api/factory/ai/jobs/:jobId` | none | Poll. |
| `POST /api/factory/ai/jobs/:jobId/cancel` | none | |
| `POST /api/factory/ai/plans/:jobId/draft` | `{format}` | Idempotent. |
| `PATCH /api/factory/drafts/:draftId/generated` (narration) | `{expectedRevision, edits:[{unitId, narration}]}` | `unitId` is the source unit id, never a scene id. |
| `PATCH /api/factory/drafts/:draftId/generated` (speakers) | `{expectedRevision, speakers:[{id, voice?, style?}]}` | Delivery style is kept apart from narration text. |
| `POST /api/factory/ai/speech-previews` | `{text, voice, language:'ar'\|'en', style?, idempotencyKey?}` | Text at most 350 characters. |
| `GET /api/factory/ai/jobs/:jobId/audio` | none | Same-origin WAV for a succeeded preview. |
| `GET /api/factory/drafts/:draftId/apply-preview` | none | Read only. Returns `{draftId, revision, canApply, reused, blockers[], speechCalls, sceneIds[], budget:{cap,used,remaining}}`. |
| `POST /api/factory/drafts/:draftId/apply` | `{expectedRevision, confirmSpeechCalls}` | `confirmSpeechCalls` must equal the count the owner saw. Absent means the safe refusal. |
| `GET /api/factory/drafts/:draftId/shot-list` | none | JSON. |
| `GET /api/factory/drafts/:draftId/shot-list?format=md` | none | Markdown, same data. |
| `PATCH /api/factory/drafts/:draftId` (ordinary) | scenes may carry `shot`, returned unchanged | `shot` is server-owned and preserved across ordinary patches. |

`speechGenerated` in the apply result counts the speech assets in the new project, **including reused turns**. The provider spend is the ledger delta (see §12.3 tests), not that number.

### 12.3 Partial apply: no second spend for a validated turn

- Each successful, validated unary turn is stored by its source identity in a private turn cache (`DATA_DIR/factory/ai/turns/`, with an index). Entries are `approved:false`. They are not project assets and are not visible in the library until adoption.
- Reuse needs an index entry, an exact byte length, a matching SHA-256, and a WAV duration within 0.01 s. Anything else is treated as missing and requested again.
- The project transaction is still atomic. An incomplete project or a library publication rolls back as before. Unrelated assets survive. The cache is independent of the project transaction, so a rollback does not erase validated turns.
- A provider failure before valid audio still counts as an attempt. It is never presented as a cached success. Charged attempts are never decremented or erased.
- `tests/factory-turn-cache.test.ts` (8 of 8, labelled provider double, real server):
  - forced failure after the **first** validated turn: one call spent, one turn saved, nothing published;
  - the apply preview is read-only and reports two remaining calls;
  - a simulated restart, meaning a new app instance on the same data directory (not an OS process restart): the saved turn and the ledger survive;
  - a provider 401 during retry counts as an attempt, publishes nothing, keeps the saved turn;
  - the retry reuses the saved turn and requests only the two missing turns;
  - two concurrent duplicate applies produce exactly one project and make no provider call.

### 12.4 Evidence rules

- `recordLiveEvidence` runs only after a real successful provider result. It binds the record to the endpoint, both model names and a credential fingerprint (a keyed HMAC-SHA-256 truncated to 16 hex characters; never the key). A record for another key or model is replaced, not inherited.
- Labelled doubles (`isLabelledDouble`) never write evidence. The test suites therefore do not change any real-provider readiness.
- Speech duration is not word alignment. Measured duration is labelled as such.

### 12.5 Verification run in this continuation

| Check | Command | Result |
|---|---|---|
| Partial-apply and restart | `npx vitest run tests/factory-turn-cache.test.ts` | 8 of 8 |
| API flow, Gemini provider, contract, routes, transport, planning, timing, factory api | `npx vitest run` on those nine files | 195 of 195 |
| Web DOM, real API routes, labelled provider double and labelled fake error client | `npx vitest run tests/web/gemini-plan-flow.test.tsx` | 11 of 11 |
| Web typed client and pure helpers | `npx vitest run tests/web/gemini-client-contract.test.ts` | 33 of 33 |
| Offline ContentPlan and factory model | `npx vitest run tests/web/content-plan.test.tsx tests/web/factory-model.test.ts` | 40 of 40 |
| API typecheck | `npx tsc --noEmit -p apps/api/tsconfig.json` | exit 0 |
| Web typecheck | `npx tsc --noEmit -p apps/web/tsconfig.json` | exit 0 |
| Core and web build | `npm run build` | exit 0 |
| Verification script, no key | `node --import tsx tools/gemini-verify.mjs --qa-root <dir> --preflight` | STOP before any call |

- **Browser gate: blocked, not run.** `puppeteer-core` is present as a dependency, but no Chromium binary is installed in this sandbox. Downloading a browser is outside this continuation's allowed actions. The DOM suite (happy-dom) and the HTTP integration cover the path instead. A browser pass on the owner's machine is still needed.
- **Fixture vs live.** Every result above used labelled doubles. The DOM suite used a labelled Google double behind the real routes, plus a labelled fake client only for the 401/403/429/timeout display.
- **Budget.** Test runs use their own temporary data directories. They do not touch the QA session ledger. The verification budget stays at 2 text and 2 short previews. Nothing resets it.

### 12.6 Still unproven (honest remaining gates)

- **Live Google acceptance.** No `GEMINI_API_KEY` exists in this sandbox, and no live call was made. The structured-output shape (`responseFormat.text`, `APPLICATION_JSON`) and the single-speaker voice field are not yet accepted by the live API. The first owner-run text generation decides it. Spelling variants are not tried.
- **Arabic and English speech quality.** Separate evidence states. Neither is proven live. Arabic diacritics are preserved in the data path, but nothing has been listened to.
- **Listening review and owner approval.** Separate steps. None has happened. Generated audio is unapproved.
- **Owner-host checks.** Not run. The owner's F app stays on `1b55176`. No F update, no deploy, no publication.
- **Browser walkthrough** on the owner's machine (§12.5). Blocked here: no Chromium binary.
- **Religious content.** Suitability of any screen-recording or product content is a reviewed content decision, not something the code decides.
- **Explicit derived rewrite of an approved script** (a separate proposal that never overwrites the source): **not built**. Supplied approved scripts stay immutable, and the generated route refuses them.
- **Supplied image or video results** are imported through the existing library upload (source and licence required). No new import flow was added, and no paid image or video generation exists.
- **Multi-speaker single call.** Not used. Each line is its own unary turn.

The factory is **not** declared complete.

## 13. Synchronization evidence (sync work order)

Full report, evidence counts, blocked gates, and the integration overlap analysis are in
`SYNC_EVIDENCE_REPORT.md`. Summary:

- A narration is `exact_scene_timing` only when its sidecar declares the sha256 and duration of the
  audio on disk and the text matches. A same-text sidecar for other audio is an estimate.
- Forced alignment alone is `unverified`. `verified` needs an independent transcript that agrees with
  the supplied text. The current runner produces no transcript, so real alignments stay `unverified`.
- A transcript `discrepancy` is refused by accept and nothing is applied. Audio trim or replacement
  clears the stored verdict, and that state survives reload.
- Translation captions link to their spoken cue by `cueOf`. They share its timing and refuse direct
  timing edits. A translation UI is not built yet.
- Browser gate: blocked here (no Chromium, no ffmpeg). Not run and not downloaded.

## 14. Workflow checkpoint (derive, caption language, transcript provenance, sidecar binding, Gemini apply workflow)

Full detail, the six-input capability matrix, the integration-overlap report, and the changed-file list:
`docs/execution/milestone-3/CLOSURE_REPORT.md`.

- Built and fixture-tested: derived rewrite (`POST /api/factory/drafts/:id/derive`, `POST .../review`), caption
  language (one selection rule shared by preview and export), alignment transcript provenance, sidecar timing
  binding for shorts, and a video-with-narration HTTP path.
- Verified by targeted runs only: core, web, and API typechecks; `build:core`; `build:web`; 39 targeted files,
  661 tests passed, 1 skipped (earlier run). Latest run: 43 files, 685 tests passed, 1 skipped.
- Not proven: live Gemini (no call made), real alignment on the owner recording (runner not executed),
  browser acceptance (no Chromium), boundary-frame inspection (no ffmpeg), listening review, owner acceptance.
- Closed in the latest continuation (fixture and route-tested, see `CLOSURE_REPORT.md` §1): exact apply count
  and server recount, separate per-speaker style and voice, per-draft bound-file hashes with `missing`,
  `blocked`, `changed` and `incompatible` statuses, shot-list JSON and Markdown, and product-mention refusals.
- Product mention: an enabled mention now becomes one unapproved product scene per treatment (`sourceUnitId` `pm-<factId>`, shot `productFactId`, `image_needed`), placed after the closing line. Route-tested (`tests/factory-product-mention.test.ts`, 8 tests). Not checked in the rendered video.
- Still open: storyboard standalone
  evidence; boundary-frame inspection; Arabic speech engine; live Gemini; owner-host acceptance.
- The factory is NOT declared complete.

## 15. Shot stills: local route (closeout order, replaces the paid Gemini image route)

**The Gemini image route is removed.** No Google or cloud image generation, no paid-image activation, no
`gemini-3.1-flash-image` call. The earlier §15 text (paid route, `GEMINI_IMAGE_*` flags, `generate-still`) is void.

Route: stable-diffusion.cpp (`sd-cli`, MIT) on the owner's Windows PC, one job at a time, CPU baseline. Setup, pins,
hashes and licences: `LOCAL_IMAGE_SETUP.md`. Setup script: `scripts/windows/Setup-LocalGeneration.ps1`. With no switch it is preflight only. Downloads need `-Download -AcceptModelLicence`. It verifies size and SHA-256 before keeping a file, checks the flags `sd-cli -h` prints, and writes the configuration. Nothing has been downloaded, installed, or run in this sandbox, and `pwsh` is not available here, so the script has not been executed.

- Status (no generation): `GET /api/local-images/status` → `{ready, state, missing[], flagsMissing[], backend, model:{sha256Matches}, googleUsed:false, paidSpend:false, busy}`.
- Shot prompt (no generation): `GET /api/factory/drafts/{draftId}/scenes/{sceneId}/still-request` → `{prompt, aspect, revision, boundAssetId}`. Recording shots return 409.
- Start one job: `POST /api/local-images/jobs` with `{"draftId":"dft_…","sceneId":"…","expectedRevision":7,"seed":1234}` (`seed` optional). The prompt is built on the server, not sent by the client. Returns 202 with the queued job. A stale revision returns 409 `FACTORY_REVISION_CONFLICT`; a second start while one runs returns 409 `LOCAL_IMAGE_BUSY`; a missing runtime or model returns 503 `LOCAL_IMAGE_SETUP_REQUIRED` with `missing`.
- Poll: `GET /api/local-images/jobs/{jobId}` → `{state: queued|running|succeeded|failed|cancelled|timed_out|interrupted, progress, seed, width, height, provenance, error:{code,message}}`.
- Preview: `GET /api/local-images/jobs/{jobId}/image` (PNG, only for a succeeded job whose file decodes again).
- Cancel: `POST /api/local-images/jobs/{jobId}/cancel` (kills the runner; nothing saved).
- Approve (registers in the library once, with source, licence and provenance): `POST /api/local-images/jobs/{jobId}/approve` → `{assetId}`.
- Bind to the shot at the reviewed revision: `POST /api/factory/drafts/{draftId}/bind-image` with `{"expectedRevision":7,"sceneId":"…","assetId":"loc_…"}`. Replaces any earlier still on that shot. Refuses recording shots and unlicensed or inactive assets.
- Validation before anything is kept: full PNG decode (signature, every chunk CRC, IHDR, inflated scanline length, IEND) and the requested size.
- Provenance kept on the asset: release, model name and SHA-256 (from the owner's pin), licence, prompt SHA-256, seed, size, steps, backend, output SHA-256, time.
- Web: `LocalImagePanel` (in ContentPlan, under the shot list). Setup state, Generate, progress, Cancel, preview, Approve, Bind. One job, no polling after a terminal state, a cancelled job never shows a preview.

Evidence (fixture and code level only; labelled):
- `tests/local-image.test.ts` (33 tests, real server; the last 5 cover prompt correction, `tests/fixtures/fake-sd-cli.mjs` as a labelled stand-in runner, test model bytes with a computed pin). Covers PNG validation, status and setup, flag probe, Vulkan refusal, still request and revision, a full job with provenance, approve and bind (including stale revision and recording refusal), cancel, timeout, corrupt output, runner failure, interrupted restart, and unknown ids.
- `tests/web/local-image-panel.test.tsx` (12 tests, happy-dom, labelled client double): setup state, recording shot has no generate control, progress and preview only on success, approve then bind with revision, cancel with late success ignored, timeout/failure, busy, stale-revision bind, transport failure, and prompt correction (exact prompt and negative shown; save disabled while unchanged; revision conflict keeps the typed text).

Not proven: real `sd-cli.exe` output, the flag names as printed by the installed build (the nine flags are verified only against upstream source at `1d0a58a`), the SD 1.5 weight hash of the owner's download (the upstream LFS digest is recorded from metadata), latency on the owner's CPU, browser behaviour, and any owner-host run. Local generation is **not** declared complete.

## 16. Semantic planning: local route (replaces Gemini text planning)

Owner rule: Google is used only for optional speech. The plan route no longer calls Gemini.

- Route: a loopback OpenAI-compatible chat endpoint (`llama-server`, MIT, `POST {LOCAL_LLM_URL}/v1/chat/completions`, `stream:false`, `response_format:{type:"json_object"}`). Loopback only: `127.0.0.1`, `localhost` or `::1`, http, no credentials.
- Enabled only with `LOCAL_LLM_ENABLED=1`, `LOCAL_LLM_URL`, `LOCAL_LLM_MODEL` (label) and `LOCAL_LLM_MODEL_LICENSE` (the owner's record of the licence of that exact model file). The code records the licence; it does not verify it.
- Unavailable → `POST /api/factory/ai/plans` returns 412 `FACTORY_PROVIDER_DISABLED` with the reason, and no call is made. The labelled offline mode is `local_rules` (deterministic, not semantic AI); it is never a hidden fallback. `GET /api/factory/capabilities` → `text.mode` is `local_llm` only when the planner is configured.
- Errors: connection refused or a 5xx → `FACTORY_PROVIDER_UNAVAILABLE` (503). No answer in time → `FACTORY_PROVIDER_TIMEOUT` (504). Cancel and late results are discarded as before. Blocked or empty output → no repair. Invalid output → one repair, then a safe failure. None of these spend the Google budget.
- Plan records: `evidence: "local_llm_unverified_plan"`, `route: "local_llm"`, `model` = the configured label.
- Speech keeps its Google gates and the voice budget. 401, 403, 429, 500 and timeout are still mapped and tested on the speech path.
- The text budget (`GEMINI_BUDGET_TEXT`) no longer applies to planning.

Evidence: `tests/gemini-provider.test.ts` (36 tests in the file; the plan and speech-error blocks were rewritten against a labelled loopback double, including non-loopback refusal, no Google header, repair, blocked/empty, timeout, cancel race, idempotency; speech 401/403/429/500 and 429→quota state), `tests/gemini-routes.test.ts` (plan 412 is `FACTORY_PROVIDER_DISABLED` when no planner), and the nine migrated files (`factory-binding`, `factory-gemini-flow`, `factory-product-mention`, `factory-spend-speakers`, `factory-turn-cache`, `gemini-transport-evidence`, `gemini-plan-flow`, `gemini-routes`, `gemini-provider`), all now on the local loopback double. All pass.

Planner unit evidence (CODE and FIXTURE, no network): `tests/local-planner.test.ts` (15 of 15): loopback-only URL refusal, not-ready 412 with no call, `finish_reason` `length` mapped to `MAX_TOKENS`, Gemini-shaped candidate, typed 503/504/409 failures, prompt return on a silent server during timeout and cancel. The llama.cpp runtime pin is `b11429` (Windows x64 CPU zip, 19,398,918 bytes, sha256 `1283323272b04cd07905816a597a0da810918102de958f4ff6f7bbaa70ed2efe`), recorded in `LOCAL_IMAGE_SETUP.md` §2. The `--rng` flag was removed from the image adapter because it is not in the upstream source at `1d0a58a`. The planner's `response_format: {"type":"json_object"}` on `/v1/chat/completions` is confirmed in the `b11429` server README. The planner's readiness is not exposed by any HTTP route; it is only checked when a plan starts (412 when not ready).

Not proven: a real local model producing a valid plan; the licence of any chosen model; the owner's `llama-server` run. The planner is **unverified** until that run.

## 17. Verification summary for this closeout turn

Ran (targeted, no full suite):
- `npm run build:core`, `tsc --noEmit` for `apps/api` and `apps/web`, `tsc -p packages/core` (all exit 0).
- `npm run build:web` (exit 0).
- `npx vitest run` on 18 affected files: local image (API), local image panel (DOM), factory API, binding, Gemini flow, product mention, spend/speakers, turn cache, Gemini provider, Gemini routes, Gemini transport evidence, ContentPlan, derived rewrite panel, editor timing status, factory model, Gemini client contract, Gemini plan flow, shot-list panel: 292 passed.

Labels: code (typecheck, build), fixture (fake runner, test model bytes, planner double), HTTP-only (the server injected in tests), DOM (happy-dom). **Browser: blocked** (no Chromium in the sandbox; not downloaded). **Render: not run** (no ffmpeg). **Live: none** (no Google or local model call; no keys used). **Owner host: not run**.

Blocked gates (named): browser acceptance of the panel; `sd-cli.exe` real output and flags; SD 1.5 weight hash; local planner model and licence; owner-host run of `LOCAL_IMAGE_SETUP.md` §7.

## 18. Visual quality of local stills (visual-quality order, on top of §15)

Scope: the words the local planner writes for each image shot, the prompt the local runner receives, and the one
correction path a reviewer can use before generating. Google is not used. Planning stays on the loopback planner
(§16). No runner, model, or weight was run or downloaded here, so **no generated image has been seen**.

### 18.1 What changed (code)

- **Planner output (labelled parts).** The plan prompt (`packages/core/src/factory/gemini-contract.ts`) asks for each
  image shot's `visualRequirement` as labelled parts separated by semicolons: `Subject`, `Environment`, `Lighting`,
  `Composition`, `Shot`, and optional `Exclude`. The scene validator calls `validateVisualDescription`, so a vague
  description goes through the existing single repair, then fails safely. Rule: each of the first five parts has a
  phrase of at least two words (`Shot` needs one shot name, for example `wide`, `medium`, `close-up`).
- **Composer (deterministic, no model)**: `packages/core/src/factory/still-prompt.ts`, exported from `factory/index.ts`.
  Positive prompt order: subject, environment, lighting, composition, shot, the aspect framing token (`16:9 frame`
  landscape, `9:16 frame` portrait, never both), then the profile style. Negative prompt: base text terms for every
  still, plus, for religious shots only, `scripture, quotation, calligraphy, arabic script, brand name`. **No global
  people ban**: `people` appears in a negative only when that shot's own `Exclude` part names it. Religious prompts
  never name BuildTrack.
- **Shot list** (`factory-service.ts`, `shotListFor`): image shots carry `imagePrompt`, `negativePrompt`,
  `promptWarnings`, and `visualDescription`. `prompt` is set only for a missing binding. Recording shots have null
  prompt fields (a still is never a recording).
- **Runner input**: `startLocalJob` requires `negativePrompt` (1–1000 characters) and passes it to `sd-cli -n`. The
  built-in negative constant is removed. Provenance records `negativePromptSha256` next to `promptSha256`.
  The route takes the prompt and negative from the server's revision-checked shot. The client sends only
  `{draftId, sceneId, expectedRevision[, seed]}`, so the prompt a reviewer sees is the prompt generated.
- **Smallest correction** (`correctStillPrompt`, `factory-service.ts`): changes `visualIntent` only, at the reviewed
  revision. It does not call `patchDraft`, so server-owned shot fields (binding, status, asset ids) are untouched.
  Refusals: revision conflict (409 `FACTORY_REVISION_CONFLICT`, `currentRevision`), recording shot (409
  `FACTORY_VALIDATION`), vague or unlabelled text (422 `FACTORY_VALIDATION`, with the validator's messages), text
  over 600 characters (422).
- **Limit raised**: the scene `visualIntent` cap is 600 characters (was 300). A labelled description needs more room.
  This also covers the correction.

### 18.2 Exact payloads

```text
GET  /api/factory/drafts/{draftId}/scenes/{sceneId}/still-request
     → { prompt, negativePrompt, warnings, aspect, revision, boundAssetId }     (409 for a recording shot)

POST /api/factory/drafts/{draftId}/scenes/{sceneId}/still-prompt
     body: { "expectedRevision": 7, "visualDescription": "Subject: …; Environment: …; Lighting: …; Composition: …; Shot: …; Exclude: …" }
     → 200 envelope, revision 8 (only visualIntent changed)
     → 409 FACTORY_REVISION_CONFLICT { currentRevision }   (stale)
     → 409 FACTORY_VALIDATION                              (recording shot)
     → 422 FACTORY_VALIDATION                              (vague text, or over 600 characters)

POST /api/local-images/jobs
     body: { "draftId": "dft_…", "sceneId": "…", "expectedRevision": 8, "seed": 1234 }   (seed optional)
     → 202 queued job; the runner receives the server's prompt and negative (-p, -n)
```

Web (`LocalImagePanel`, inside ContentPlan, under the shot list): each image shot shows the exact `imagePrompt`,
the shot's `Excluded in this image` line, and any `promptWarnings`. A text area holds the visual description. "Save
prompt correction" is disabled while busy or running, and when the text is unchanged. Success shows a neutral
notice and discards any earlier preview, because that preview was made from the old prompt. Nothing is bound.
A revision conflict keeps the typed text.

### 18.3 The two acceptance prompt pairs (exact composed text, code output)

These are the inputs for visual acceptance. They are not images. Each was composed by `composeStillPrompt`
with `aspect: landscape`.

Pair A, religious still life (no people, no lettering, no brand):

- Description: `Subject: a closed plain leather book and a brass oil lamp on a low table; Environment: an empty warm room, plain white walls, a woven rug; Lighting: soft warm lamp light from the left; Composition: book and lamp on the right third, empty wall on the left; Shot: still life; Exclude: people, text`
- Positive: `a closed plain leather book and a brass oil lamp on a low table, an empty warm room, plain white walls, a woven rug, soft warm lamp light from the left, book and lamp on the right third, empty wall on the left, still life, 16:9 frame, quiet, reverent, realistic photograph, soft warm light, uncluttered` (55 words, no warning)
- Negative: `text, letters, words, numbers, caption, watermark, logo, signature, blurry, low quality, deformed, duplicate objects, scripture, quotation, calligraphy, arabic script, brand name, people`

Pair B, educational illustration (no product mention, no religious terms):

- Description: `Subject: a delivery truck beside a stack of three cardboard boxes, a green tick floating above them; Environment: a plain warm-grey site yard with a gravel edge; Lighting: flat even daylight, no hard shadows; Composition: truck on the left, boxes on the right, empty sky across the top; Shot: wide; Exclude: none`
- Positive: `a delivery truck beside a stack of three cardboard boxes, a green tick floating above them, a plain warm-grey site yard with a gravel edge, flat even daylight, no hard shadows, truck on the left, boxes on the right, empty sky across the top, wide, 16:9 frame, clean editorial illustration, flat colours, clear simple shapes` (55 words, no warning)
- Negative: `text, letters, words, numbers, caption, watermark, logo, signature, blurry, low quality, deformed, duplicate objects`

The two pairs differ in subject, room, light, style, and negative (only pair A carries the religious terms and `people`).

### 18.4 Evidence (labelled)

- **Code**: `packages/core` build, `tsc` for `apps/api` and `apps/web`, `npm run build:web`. All exit 0.
- **Fixture, before the freshness repair (superseded by §18.7 counts)**: `tests/still-prompt.test.ts` (12 of 12, pure: validator, aspect token,
  per-shot exclusion with no global ban, no BuildTrack in religious text, the two prompt pairs);
  `tests/local-image.test.ts` (33 of 33, real server with the labelled fake runner: the composed prompt and per-shot
  negative reach `-p`/`-n`, provenance hash, correction refusals and success, the correction keeps server-owned fields,
  and an old revision cannot start a job after a correction).
- **DOM** (happy-dom, labelled client double, not browser acceptance): `tests/web/local-image-panel.test.tsx`
  (12 of 12, ran three times with no flake), including the correction controls.
- **API regression**: 17 targeted files, 288 of 288. **Web regression**: 7 targeted files, 104 of 104.
- **HTTP-only, browser, render, live**: none for visual quality. Browser tooling is unavailable in the sandbox, so
  panel behaviour is DOM evidence only.

### 18.5 Visual quality: UNPROVEN

No real local generation has run (no `sd-cli.exe`, no SD 1.5 weight, no owner host). The fake runner's PNGs are not
acceptance, and a successful job is not acceptable visual quality. To verify on the owner's machine (not run here):

1. Complete `LOCAL_IMAGE_SETUP.md` (pinned runtime and weight from F:, flags confirmed with `sd-cli -h`).
2. Open ContentPlan for a draft from a real brief. Check that each image shot's prompt matches its plan text, that
   people appear only where the shot does not exclude them, and that religious shots show no text, lettering, or brand.
3. For each of Pair A and Pair B (§18.3), enter the description as the shot's visual description, save the
   correction, generate once, and inspect the preview. Record the seed, the output hash, and your judgement: keep,
   correct and regenerate (one more job at the new revision), or reject.
4. Approve and bind only a preview you accept. Nothing is bound by generation or by correction.

Not claimed: prompt quality, image quality, latency on the owner's CPU, Vulkan behaviour, or any owner acceptance.
Practical walkthroughs still need real screen recordings (§12, §15).

### 18.6 Owner overlaps and risks (visual-quality slice)

- Not verified: `de545d0` and `f045e6d` (owner-local) are not on origin. This slice changes
  `packages/core/src/factory/gemini-contract.ts` (plan prompt and scene validation), `factory-service.ts`, `local-image.ts`,
  `routes/local-images.ts`, `routes/factory.ts`, and `LocalImagePanel.tsx`. If the owner has local edits to any of these
  they will conflict. Speech code (`gemini-service.ts`, `gemini-store.ts`) is not touched by this slice.
- Test files changed: `tests/gemini/helpers.ts` (fixture `visualRequirement` strings rewritten in labelled form),
  `tests/factory-binding.test.ts`, `tests/local-image.test.ts`, `tests/web/local-image-panel.test.tsx`,
  `tests/still-prompt.test.ts` (new). The owner dry-merge overlaps (`tests/gemini-provider.test.ts`,
  `tests/web/gemini-plan-flow.test.tsx`) are not edited by this slice.

### 18.7 Repair: candidate freshness and religious refusal (on the visual-quality slice)

Scope: only server-enforced candidate freshness and religious branding, lettering and scripture refusal, on the actual
input, before any save or generation. Preserved unchanged: exact-prompt review, the revision-conflict text
preservation, the recording refusal, manual approval, and replacement of a bound still. No speech, approved timing,
owner recording, `data/`, `output/`, dependency, weight or engine setup was changed. No download, model call, Google
text or image call, or render was run. A negative prompt is still not a refusal.

**What changed (code)**

- **Plan boundary** (`packages/core/src/factory/gemini-contract.ts`): `validateGeneratedPlan` passes the plan's profile
  to `validateVisualDescription`, so a religious plan whose shot asks for a brand, lettering or scripture is refused
  when the plan is validated, before a draft exists. Refusal text names the term, the part, and the scene.
- **Composer** (`still-prompt.ts`): the result carries `refusals` from `religiousRefusals(parts, profile)`. The shot list
  exposes it as `promptRefusals`. Generation refuses a non-empty list (no job, no save).
- **Local-rules intents** (`planning.ts`, lines 130, 143, 162): reworded so the offline religious intents do not
  contain the overlay words the refusal rule now catches. The rule was not weakened.
- **Shot-less bind** (`factory-service.ts`, `bindLocalImage`): a script-only (local-rules) image scene has no `shot`
  record. Binding a still set `assetId`, and `sceneNeedOf` then read the scene as an existing library asset, so
  every later still correction was refused (409). The bind now records the need it has just verified
  (`shot: { type: 'image', assetNeed: 'image_needed', … }`) only when the record is missing. Visible effect: the shot
  list's `shotType` for such a bound scene is `image` instead of `null`.
- **Approve re-stamp** (`local-image.ts`, `approveLocalJob`): identical bytes are one asset. If the asset already exists
  under another candidate identity (same picture for the same or another shot), the latest approval re-stamps its
  `localCandidate`, so the bind checks the current shot's fingerprint. Without this, a current candidate could be
  refused as stale.
- **Web** (`apps/web/src/lib/factory-api.ts`, `LocalImagePanel.tsx`): `promptRefusals` on each shot; generate is
  disabled and the reason is shown while it is non-empty. A job view's `candidate.current === false` shows the
  server's message and disables Approve. The server still decides on approve and bind.

**Changed test expectations (none weakened)**

- `tests/still-prompt.test.ts`: 4 new plan-boundary cases (12 → 16).
- `tests/web/local-image-panel.test.tsx`: 3 new cases (refused shot, stale candidate, current candidate) (12 → 15).
  The shot-list fixture gained `promptRefusals: []`.
- `tests/local-image-freshness.test.ts` (new, 12 cases). The religious case reads the draft revision from the draft
  envelope when restoring the description. The still-request read is refused for a tampered draft by design.
- No assertion about `shotType` for a bound shot-less scene existed. The change is covered by the 307-test run below.

**Evidence (labelled; all fixture, code and DOM; none is browser, render or live)**

- Code: `npm run build:core` exit 0; `tsc --noEmit -p apps/api/tsconfig.json` exit 0; `tsc --noEmit -p apps/web/tsconfig.json`
  exit 0; `npm run build:web` exit 0.
- Fixture, API (real server, labelled fake runner): `tests/local-image-freshness.test.ts` 12 of 12. The re-stamp test
  fails when the re-stamp is disabled, and passes with it. `tests/still-prompt.test.ts` 16 of 16. `tests/local-image.test.ts` 33 of 33.
- Fixture, API regression: 19 targeted files (`factory-api`, `factory-binding`, `factory-derive`,
  `factory-gemini-flow`, `factory-planning`, `factory-product-mention`, `factory-spend-speakers`,
  `factory-timing-provenance`, `factory-turn-cache`, `factory-video-narration`, `gemini-provider`, `gemini-routes`,
  `gemini-transport-evidence`, `local-image`, `local-image-freshness`, `still-prompt`, `generated-asset-slots`,
  `generated-asset-slot-api-contract`, `gemini-contract`): 307 of 307.
- DOM (happy-dom, labelled client double, not browser acceptance): `tests/web/local-image-panel.test.tsx` 15 of 15.
  Web regression: 7 targeted files (`derived-rewrite-panel`, `editor-timing-status`, `factory-model`,
  `gemini-client-contract`, `gemini-plan-flow`, `local-image-panel`, `shot-list-panel`): 90 of 90.
- Browser: blocked. Chromium is not installed and was not downloaded. No DOM test replaces browser acceptance.
- Visual quality: still UNPROVEN (§18.5). No runner or weight exists on this sandbox. Fixture PNGs are not acceptance.

**Owner overlaps (unverified here)**: `de545d0` and `f045e6d` are owner-local and not on origin. This repair touches
`factory-service.ts`, `local-image.ts`, `gemini-contract.ts`, `planning.ts`, `still-prompt.ts`, `contract.ts`,
`routes/local-images.ts`, `apps/web/src/lib/factory-api.ts` and `LocalImagePanel.tsx`. The owner dry-merge conflicts
(`tests/gemini-provider.test.ts`, `tests/web/gemini-plan-flow.test.tsx`) are not edited here.
