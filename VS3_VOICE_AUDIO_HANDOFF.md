# VS3 — Voice & Audio (engine availability · voice reference · preview · render gate)

**Work order:** VS3 — connect the VS1 voice-reference contracts and the VS2 Chatterbox
adapter to the application's API and UI, *inside the existing app*.

| | |
|---|---|
| Baseline branch | `arena/c4cc1417-video-factory` |
| Baseline commit (parent) | `07a0105ec3c4fef6f91b582099d7d7359a5fd526` (VS2 close-out) |
| Final branch | `arena/c4cc1417-video-factory` (no other branch was created, pushed or merged) |
| Final commit | the single VS3 commit on that branch — the commit that adds this document. Its SHA is the pushed remote HEAD; verify with `git rev-parse HEAD` and `git ls-remote origin arena/c4cc1417-video-factory` after delivery (the verified SHA is reported in the delivery message and recorded in the out-of-repo recovery artifact). |
| Parent of the final commit | `07a0105ec3c4fef6f91b582099d7d7359a5fd526` |
| Diffstat | 20 files changed before this document (+6201 / −3); the document and the `REVIEW_HANDOFF.md` § VS3 section are added by the same commit |

Nothing was force-pushed, no `main` merge, no history rewrite, no `workflow_dispatch`,
no run-once marker edit, no unrelated CI change.

---

## 1. What was delivered

A compact **“Voice & Audio”** section inside the existing project workflow (the
Captions page and the Production/Storyboard page), backed by project-scoped API
routes and pure core contracts. No replacement app, no parallel voice-reference
database, no second synthesizer: the shipped VS1 publication gate, the VS2
Chatterbox adapter and the existing approval/error/path-safety contracts are reused.

### A. Engine availability (truthful, with the remedy)

`GET /api/projects/:id/voice-audio` reports, per engine, a state from
`available | not_provisioned | device_unsupported | blocked_by_approval | generation_failed`
plus `detail`, `remedy`, `selectable`, `generatable`, `unverifiedPath`, `lastFailure`,
`provisioned`, `deviceSatisfied`, `cpuRequiresOptIn`, `provisionRemedy`, `notes`,
`modelId`, `modelRevision`, `runtimeInstalled`, `approvalBlockedCodes`.

* `available` means provisioned **and** the device policy is satisfied — never “might work”.
* `not_provisioned` answers with the exact command: `npm run provision:voice-clone -- --apply`.
* `device_unsupported` states the device truth and that CPU is an explicit opt-in that is
  **not** verified as performant.
* `blocked_by_approval` is produced by consent/approval codes, not by provisioning.
* `generation_failed` carries the recorded failure code and message.
* Kokoro stays a separate explicit choice: a selected cloned voice is never silently
  replaced by Kokoro, another engine or a default voice. An engine that cannot run blocks
  the request (409) with its remedy instead of substituting anything.

### B. Voice reference (three separate facts)

1. **Upload** `POST …/references` — multipart, validated by **content** (ffprobe must find
   a real audio stream with real metrics), not by extension. Extension/container
   disagreement is refused (`.wav` carrying MP3), as are unsupported extensions, obviously
   non-audio MIME types, empty files and files above 64 MB or 120 s. Upload grants
   **nothing**: the response states `authorized: false`, `approved: false` and the two
   next steps. No filesystem path, stored file name or full hash is ever returned
   (`sha256Prefix` is 12 characters).
2. **Authorization** `POST …/references/:refId/authorize` — requires the literal boolean
   `ownerConfirmed: true` and a ≥10-character statement, and writes an auditable consent
   artifact (`references/<refId>.consent.json`) that the VS1 gate requires. It is never
   pre-checked or implied by the upload.
3. **Approval** `POST …/references/:refId/approve` — decided by the **shipped VS1 gate**
   (`evaluateVoicePublicationGate`). Rights evidence belongs to this request; silence is
   never permission. A blocked approval answers 422 with `blockedCodes` and structured
   findings.
4. **Removal** `DELETE …/references/:refId` — deliberate: 409 unless the speaker is
   reassigned or `clearAssignments=true` is passed explicitly; the private file is then
   really deleted and the record is kept for audit.

### C. Audio preview

* `PUT …/assignments` — speaker → engine (+ approved reference / Kokoro preset).
  A cloned assignment for a reference that is not approved is refused (422).
  Two different speaker names never imply two different voices.
* `POST …/previews` — starts a **background job** (no synthesis inside a blocking
  request) and answers 202 with `jobId`/`previewId`. `GET …/jobs/:jobId` reports
  progress, a bounded log and the sanitized failure.
* Generation synthesizes the **complete** narration/dialogue turn per speaker, measures
  each segment with ffprobe, concatenates them without re-timing into
  `previews/<prv_…>/preview.wav`, records the real duration and deletes the per-segment
  intermediates. Planning is strict: a speaker with no assignment raises
  `VoiceAudioPlanningError` (`VOICE-AUDIO-010-ASSIGNMENT-MISSING-REFERENCE`); no default
  voice is ever lent and no word is dropped.
* `GET …/previews/:previewId/audio` streams **only the current preview of that project**
  (`no-store`). `POST …/previews/:previewId/approval` records the decision bound to the
  identity digest **and** the artifact SHA-256.

### D. Before rendering (cloned audio only)

`GET …/render-gate` and the export/build entry points consult the same gate:
valid authorization + approved reference + successful generation + explicit approval of
the **current** artifact + matching script, speaker assignment, reference identity,
engine/model and settings. Any identity-bearing change invalidates the stale
generation/approval through the existing digest mechanisms. `POST /api/projects/:id/export`
(final), the production build and the production export answer
409 `{ error, clonedAudioGate, blockReason }` when blocked; projects without a cloned
voice are `notApplicable` and behave exactly as before.

**Documented blocking integration point (not silently worked around):** per-scene timing
alignment is not connected yet, so `VOICE-AUDIO-060-TIMING-ALIGNMENT-PENDING` keeps cloned
audio blocked. The exact integration points are
`apps/api/src/services/store.ts#generateStoryboard({ audioDuration, shortAudioDurations, shortSceneTimings })`
and `apps/api/src/services/targets.ts#readTiming(<name>.timing.json)`; previews carry
`timing.mode = 'full_duration_preserved'`, `perSceneAlignment: false` and the measured
duration. Narration is never trimmed to fit old timings, no fixed-duration slicing drops
words, and no time-stretch is applied.

---

## 2. Changed files

**New — API**

* `apps/api/src/routes/voice-audio.ts` — 11 routes, job registry, generation internals,
  `planSegments`, `projectSpeakers`, `identityDigestForSegments`, `currentIdentityDigest`,
  `buildRenderGate`, `approvalBlockedCodesFor`, `VoiceAudioPlanningError`.
* `apps/api/src/services/voice-audio-state.ts` — layout, id/path safety (traversal +
  symlink rejection), atomic state, reference/preview file operations.
* `apps/api/src/services/voice-audio-engine.ts` — `probeEngines`, `engineFacts`,
  `buildSynthesizer`, `segmentRequest`, `sanitizeEngineError`, approved storage roots
  derived from `DATA_DIR`/`OUTPUT_DIR`.
* `apps/api/src/services/voice-audio-gate.ts` — `clonedAudioRenderGate(videoId)` shared by
  every render entry point.

**New — core**

* `packages/core/src/scenario/voice-audio-approval.ts` — pure VS3 contracts (engine
  statuses, reference checks, the VS1 bridge, identity digest, artifact-bound approval,
  render gate, public projection, `voiceAudioTiming`).
* `packages/core/src/scenario/node-adapters.ts` + `packages/core/package.json` — the
  `@buildtrack/core/node` subpath (Node-only synthesizers; the main barrel stays
  browser-safe).

**New — web**

* `apps/web/src/components/VoiceAudioPanel.tsx` — the panel (mounted in
  `apps/web/src/pages/Captions.tsx` and `apps/web/src/pages/ProductionStoryboard.tsx`).

**Modified**

* `apps/api/src/server.ts` (route registration), `routes/projects.ts` and
  `routes/production.ts` (render gate), `services/plan-package.ts`
  (`PRIVATE_VOICE_AUDIO_MARKERS` guard so private voice assets can never enter a
  delivery package), `apps/web/src/lib/api.ts` (+10 methods),
  `packages/core/src/scenario/index.ts` (barrel export),
  `tests/helpers/chatterbox-worker-fixtures.ts` (optional `seconds` for the synthetic
  reference WAV; the VS2 default is byte-identical).

**New — tests**

* `tests/voice-audio-api.test.ts` (30), `tests/voice-audio-core.test.ts` (28),
  `tests/voice-audio-ui.test.ts` (10).

---

## 3. API surface and UI entry point

| Method | Route |
|---|---|
| GET | `/api/projects/:id/voice-audio` — engines, references, assignments, speakers, preview, approval, render gate |
| POST | `/api/projects/:id/voice-audio/references` — upload + content validation |
| POST | `/api/projects/:id/voice-audio/references/:refId/authorize` — explicit authorization + consent artifact |
| POST | `/api/projects/:id/voice-audio/references/:refId/approve` — VS1 gate decision |
| DELETE | `/api/projects/:id/voice-audio/references/:refId?clearAssignments=true` — deliberate removal |
| PUT | `/api/projects/:id/voice-audio/assignments` — speaker → engine/voice |
| POST | `/api/projects/:id/voice-audio/previews` — start generation (202 + job) |
| GET | `/api/projects/:id/voice-audio/jobs/:jobId` — progress / failure |
| GET | `/api/projects/:id/voice-audio/previews/:previewId/audio` — current artifact only |
| POST | `/api/projects/:id/voice-audio/previews/:previewId/approval` — approve/reject that artifact |
| GET | `/api/projects/:id/voice-audio/render-gate` — 200 `notApplicable` / 409 blocked |

**UI entry point:** the “Voice & Audio” panel (`VoiceAudioPanel`) inside the existing
project pages — `apps/web/src/pages/Captions.tsx` (after the target-audio panel) and
`apps/web/src/pages/ProductionStoryboard.tsx`. One command still runs everything:
`npm start` (API + built UI on one port).

---

## 4. Tests and verification results

| Check | Result |
|---|---|
| New VS3 suites | `voice-audio-api` 30 ✓, `voice-audio-core` 28 ✓, `voice-audio-ui` 10 ✓ (**68 new**) |
| Targeted + affected suites (17 files) | **417 passed, 0 failed** (VS1 gate, migration, acoustic identity, Chatterbox synthesizer/reuse/provisioning-doctor, audio normalization/synthesis, timing reconciliation, dialogue plan, target-audio API+UI, voice integration/registry) |
| Full **non-render** suite (the three real-render files excluded) | **84 files, 1423 passed, 5 skipped, 0 failed** (VS2 baseline: 81 files / 1355 passed → exactly +3 files and +68 tests) |
| CI count guard `node scripts/assert-test-count.mjs 300` | `ok - 1425 tests passed, at or above the floor of 300` (floor unchanged) |
| Strict typechecks | `packages/core`, `apps/web`, `apps/api`, `scripts` — all clean |
| Production build | `npm run build` (core + web) clean |
| `git diff --check` | clean |
| Doctor | default run: Chatterbox reported **optional** (“not selected … nothing was downloaded”); the only hard failures are the pre-existing unprovisioned `.browser/` Chromium items. `--require-chatterbox` reports the missing env/marker/GPU/reference directory as blocking. Doctor created and downloaded nothing. |
| Bounded UI/API smoke (real HTTP server) | health 200; project created; `GET …/voice-audio` truthful `not_provisioned` states with remedies; upload → `authorized:false, approved:false`, content-validated; authorize without the literal confirmation → 400; approve without rights → 422 with codes; approve with rights → 200; assign → 200; generate → 409 with the provisioning remedy and **no** Kokoro substitution; final export → 409 with `clonedAudioGate`; built UI bundle contains the panel. |

### The one failing test in the full suite (reported, not hidden)

`tests/phase6d-real-package.test.ts > rendered a real Long and Short through the approved
renderer` — `expected 'error' to be 'ok'` (9 skipped). It is **pre-existing and unrelated to
VS3**: it was already failing on the VS1 and VS2 baselines in this sandbox with the same
assertion, it performs a real render through the approved renderer, and this sandbox has no
provisioned local Chromium (`chromePath()` throws “No headless browser found. Run
`npm run provision` first.”, and doctor reports Local Chromium as FAIL). Evidence that VS3
is not the cause: the renderer (`packages/video`, `apps/video`) and the test file are
untouched by this change (`git diff --name-only 07a0105… -- packages/video apps/video` is
empty), and the full non-render suite — which contains every production, timing, dialogue
and audio suite — passes 1423/1423.

### Required test coverage (all present, none weakened)

existing project compatibility; missing engine/model/device; unauthorized and unapproved
references; invalid/oversized/misleading uploads; traversal, symlink and cross-project
access attempts; upload alone cannot grant approval; generation + error-state propagation;
full text reaches the synthesizer unchanged (byte-identical planning + request text);
preview playback uses the correct project artifact; explicit approval bound to the exact
artifact; script/reference/speaker/engine/settings changes invalidate approval; no silent
fallback; private references excluded from exports; failed-generation cleanup preserves
source recordings; reloading the project restores valid state; Kokoro workflow unchanged;
cloned-audio render gate rejects stale or unapproved audio.

The fake worker is **TEST/FIXTURE only** (`tests/fixtures/chatterbox-fake-worker.py` behind
`BUILDTRAKE_CHATTERBOX_TEST_WORKER=1`, labelled in every suite header, never enabled in
normal operation). No test downloads weights, creates a model environment or provisions
anything.

---

## 5. Two real defects the new tests found (fixed, not worked around)

1. **Reference upload deadlock.** The route kept a reference to the multipart file part and
   kept iterating; `@fastify/multipart` only advances once a part's stream is consumed, so
   every upload hung until the client timed out. The recording is now streamed to its
   staging file as it arrives (bounded memory, order-independent fields), and the size
   limit is handed to the parser itself so an oversized body is truncated and discarded
   instead of aborting a half-read request.
2. **A reference could never be approved.** The VS1 bridge authored a bare publication
   record where the gate expects a `VoiceProfile` (id + voiceSlot + publication), so every
   approval was refused as malformed and the whole workflow was unreachable. It now authors
   a real profile — including `consent.evidencePath` pointing at the recorded consent
   artifact — and the gate decides, exactly as designed.

Both were found by the new suites and fixed in the product, not by relaxing an assertion.

---

## 6. Approval / invalidation behaviour

* Three separate records: `authorization` (legal), reference `approval` (audition, VS1
  gate), preview `approval` (artifact).
* A preview approval stores `identityDigest` **and** `artifactSha256`. The digest is
  computed by one shared function (`identityDigestForSegments`) from the *planned*
  segments, so generation and every later evaluation agree; a change to the script, a
  speaker, a turn, the reference identity, the engine, the model revision or the synthesis
  settings changes the plan and therefore the digest → the approval becomes stale
  (`APPROVAL-STALE-IDENTITY`) and the render gate blocks.
* A different artifact on disk (`APPROVAL-ARTIFACT-MISMATCH`), a missing artifact
  (`PREVIEW-ARTIFACT-MISSING`), a running/failed/missing preview, a missing or rejected
  approval, an unapproved or removed reference, an unprovisioned engine or an unsupported
  device all block. Nothing is ever “warned about and then allowed”.
* If the plan itself becomes impossible (a speaker without an assignment), the current
  identity is deliberately not reproducible, so an approval can never stay bound.

## 7. Privacy

* Reference recordings live under the project's own `voice-audio/references/` and are
  projected publicly without paths or full hashes.
* `services/plan-package.ts` refuses to package private voice assets
  (`PRIVATE_VOICE_AUDIO_MARKERS`), so a delivery package can never contain a source
  recording; `privacy: { referenceRecordingsCommitted: false, exportedInDeliverables: false }`
  is reported with the state.
* Sanitized errors: no absolute paths, no repository paths, no source file names.

## 8. Screenshots

**None.** This sandbox has no provisioned browser (`chromePath()` fails, doctor reports
Local Chromium FAIL), so no screenshot could be captured truthfully. The UI is covered
instead by the happy-dom suite that renders and operates the real `VoiceAudioPanel`
(unavailable-engine state, upload/validation, consent + approval controls, speaker
assignment, preview and approval states, stale approval, failure state).

## 9. Explicit statement about real Chatterbox generation

**Real Chatterbox voice cloning was NOT executed and NOT tested in this phase.** No model
weights were downloaded, no model environment was created, no real inference was run, and
nothing here claims otherwise. Every synthesis exercised in the tests is the deterministic
**fake worker** fixture (`tests/fixtures/chatterbox-fake-worker.py`, stdlib only, no torch,
no model), clearly labelled TEST/FIXTURE, and its output is not cloned speech. The
watermark claim (Resemble AI's Perth neural watermark on every generated file) is
documented from upstream sources and is **not** verified here, because no real generation
happened.

## 10. Remaining requirements for the first real voice-clone run

1. **Provision explicitly** on the target machine:
   `npm run provision:voice-clone -- --apply` (a separate, deliberate user action; the app
   never provisions on startup, upload, project load or preview). Record the resolved
   model revision the provisioning reports — upstream uses the floating `main` revision,
   and it must never be invented.
2. **Device decision.** With an NVIDIA GPU, run on CUDA. CPU execution is opt-in
   (`CHATTERBOX_ALLOW_CPU=1`) and must be treated as unverified: measure it, and do not
   present it as performant.
3. **A real reference recording** of the speaker's own voice (~10 s WAV), uploaded through
   the panel, authorized in the user's own words and approved with first-party rights
   evidence. The gate will refuse anything else.
4. **Generate a preview and listen to it.** Approve the exact artifact only after
   listening; the approval is bound to those bytes.
5. **Connect the timing integration point** before any render: feed the measured preview
   duration and identity into `generateStoryboard`/`readTiming` and set
   `perSceneTimingAligned` from real evidence. Until then the render gate stays blocked by
   `VOICE-AUDIO-060-TIMING-ALIGNMENT-PENDING` — this is deliberate.
6. **Verify the watermark and the audio quality** on the real output, then run a real
   render with an audible-output acceptance step (a separate hardware/provisioning task,
   out of scope here).
