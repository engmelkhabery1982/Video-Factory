# Milestone 2 — Content-led planning and generation (Arena delivery, round 2)

**Status: partial. Code-level, HTTP-level, and DOM-test evidence on fixture data only.** Nothing here is owner acceptance, approval of creative quality, or completion of the generative factory. No browser run, render, frame review, or owner-host check was performed (Chrome is not available in this sandbox). No owner recording, owner image, approved timing, `data/`, or `output/` was read or changed.

Companion files: `FREEBUFF_DELIVERY.md` (requirement-by-requirement status and open questions), `LOCAL_VERIFY_STEPS.txt` (reproduction steps), `evidence/` (recorded responses and scripts).

---

## 1. Identity and SHAs

| Item | Value |
|---|---|
| Session branch | `arena/890ccb82-video-factory` (fixed by the session; not renamed) |
| Milestone 1 base | `3178561a36d9b1cc85f6eb58e1698a8f4890205d` (descends from `1609c1a`) |
| Remote session head before this push | `2a4083a406602bc93b104a0388c709fb498ecaa5` (Milestone 2 round 1). Confirmed with `git ls-remote`. |
| Correction | Earlier notes named `1609c1a` as the remote session head. That was incorrect. `1609c1a` is an ancestor of `2a4083a`. |
| Round 2 review-fix commit | `d413a6d` |
| Round 2 frontend commit | `cf2d6d6` |
| Docs commit (this file, `FREEBUFF_DELIVERY.md`, `LOCAL_VERIFY_STEPS.txt`, evidence) | The commit after `cf2d6d6`. SHA reported in the chat report. |
| Push | `git push origin HEAD:refs/heads/arena/890ccb82-video-factory`. Fast-forward from `2a4083a`; no force. Remote SHA verified after push. |
| Working tree | Clean detached worktree `/home/user/m2-work`. |
| Main checkout | `/home/user/Video-Factory` untouched. Read-only check: branch `arena/890ccb82-video-factory`, HEAD `b235b00`, 185 dirty entries (same as round 1). Not reset, stashed, or overwritten. |

The blocker recorded in round 1 still applies: the main checkout remains dirty and was preserved as it was. It is not part of this delivery.

---

## 2. Corrections to round 1

The round-1 version of this document had these errors. They are fixed here.

| Round 1 said | Now |
|---|---|
| Portrait apply is refused (`422 FACTORY_FORMAT_UNSUPPORTED`) | **Portrait apply works.** The requested format is kept on the draft, the document, provenance, and the apply response. `targetId` stays `long`. The render path maps `format` to `ShortVideo` (code only; not rendered). |
| Rollback after a mid-write failure is code-only and untested | **Tested.** Forced failures at `after-project`, `after-index`, and `before-draft` leave no project, no output, no media, no index change, and an unchanged draft file. A concurrent upload survives. |
| `apps/web` and frontend tests not changed | **Changed.** Typed client, planning page, editor audio actions, header entry, and 45 new tests. |
| Test totals: 46 (planning and API) | **Now 64 for planning and API** (25 planning, 39 API) and 277 across the 15 focused files. |
| `ffmpeg` not installed | The bundled `ffmpeg` from `node_modules/@ffmpeg-installer` runs. No system `ffmpeg` is on PATH. The browser is still missing, so no render is possible. |
| Driving the speech adapter needs a data directory under the working directory | Still true, and now observed. A `/tmp` data dir returned `503 FACTORY_SPEECH_FAILED` with no changes. Use a directory under the working tree (see §7). |
| Patches at `/home/user/delivery/milestone-2/m2-incremental.patch` | Round-2 patches are in `/home/user/delivery/milestone-2/round2/`. The round-1 path does not exist in this sandbox. |

---

## 3. What the system does now

### 3.1 Endpoints (`apps/api/src/routes/factory.ts`)

| Method and path | Result |
|---|---|
| `GET /api/factory/capabilities` | `200` `{version, text, speech, image, transcription, storyboardImport}`. `speech.languages` gives English and Arabic separately. `speech.engines` lists each engine's status. |
| `POST /api/factory/drafts` | `201` envelope (status `review_required` or `blocked`), or `422` with `{code, error}` |
| `GET /api/factory/drafts/:draftId` | `200` the same envelope. `404 FACTORY_DRAFT_NOT_FOUND`. |
| `PATCH /api/factory/drafts/:draftId` | `200` envelope. `409 FACTORY_REVISION_CONFLICT` with `currentRevision`. `423 FACTORY_SCENE_LOCKED`. `422` validation. |
| `POST /api/factory/drafts/:draftId/apply` | `201 {projectId, targetId:"long", format, editorRevision, timingSource, speechGenerated}`. `422 FACTORY_INPUTS_REQUIRED` with `missing`. `409` on a stale revision. `503 FACTORY_SPEECH_FAILED` when the local engine cannot write. |

Errors are `{code, error}`, plus `missing` or `currentRevision` where the contract needs them. No stack and no filesystem path appear in responses. Unexpected failures return `500 FACTORY_INTERNAL`, with the detail logged on the server only.

### 3.2 Envelope (round 2 additions are marked)

```json
{
  "draftId": "dft_eed29ae9e30b3bc9",
  "revision": 0,
  "status": "review_required",
  "generationMode": "local_rules",
  "speechOrderLocked": false,
  "selectedTreatmentId": "edu-problem-example-action",
  "treatments": [ { "id": "edu-problem-example-action", "title": "Problem, example, action",
      "orderLocked": false, "structure": ["problem","example","action","action"],
      "scenes": [ { "id": "u01", "narration": "Many sites lose a day when a crane waits for a delivery nobody confirmed.",
        "speakerId": "learner", "visualIntent": "Show the failing condition on the owner image…",
        "assetId": "img-a-2d840057", "startSec": null, "endSec": null, "locked": false,
        "sourceUnitId": "u01", "beat": "problem", "language": "en", "assetOrigin": "supplied",
        "timingSource": "unknown",
        "visualDecision": { "framing": "full", "motion": "none", "unexecuted": [] } } ] } ],
  "speakers": [ { "id": "learner", "voiceId": "sam-reader", "available": true } ],
  "missing": [], "warnings": ["…"],
  "appliedProjects": [],                                                     
  "profile": { "contentProfile": "educational", "format": "landscape", "channelBrandId": null },
  "inputs": { "audioAssetId": null, "audioDurationSec": null,
              "visualAssetIds": ["img-a-2d840057","img-b-9d142f84"],
              "scriptSupplied": true, "storyboardSupplied": false }
}
```

`appliedProjects`, `profile`, and `inputs` are additive (round 2). Everything else keeps its round-1 shape. The sample is trimmed from `evidence/contract-samples-round2.json`. The `_treatmentsShown` key that appears there is added by the sample script, not by the API.

### 3.3 Core (`packages/core/src/factory/`)

- `contract.ts`: types, constants, stable error codes, `FactoryError`, and the additive envelope types.
- `planning.ts`: sentence-unit splitting that keeps supplied words exact, role classification, and three treatments per profile. Visual decisions are part of each scene.
- `validation.ts`: strict request parsing. `reconcileSelection` enforces narration equality, each unit exactly once, asset eligibility, server-owned fields (including `visualDecision`), locked rows, the locked order (422 on reorder), and times that belong to the source unit.
- `draft-plan.ts`: units, treatments, speakers, missing items, warnings, status.
- `editor-mapping.ts`: timing plan (three labelled sources), visual decisions mapped to clip crop and still motion, and the canonical editor document builder, validated by `assertValidEditorDocument`.

### 3.4 Visual intent: what executes and what is reported

| Treatment decision | Editor result | Reported when not executed |
|---|---|---|
| `framing: tight` | Centred 80% crop (`x:0.1, y:0.1, w:0.8, h:0.8`) | — |
| `motion: slow_push`, `pan_left`, `pan_right` | Still-image motion on the clip | Footage with motion: "the renderer applies motion to stills only; the clip plays as supplied" |
| Screen recording requested | Still image shown | "screen recording: a still image is shown, not a recording. Supply footage for this scene." |
| Card requested (question, checklist, CTA) | No card | "question card (text card is not rendered…)" and similar |
| Split view | Not rendered | "side-by-side comparison (split view is not rendered)" |
| Transitions | Every clip is `cut`. No transition can be requested. | — (dissolve is out of scope; amendment A1 pending) |

These are editor-document results. None of them has been checked in a rendered frame.

### 3.5 Speech, timing, and honesty

- **Voices.** Three local sam-js voices, labelled `Robotic English sample voice (sam-js, … preset)`. Arabic speech is unavailable. Kokoro and Chatterbox are reported unavailable with their reasons. Nothing was downloaded or installed.
- **Text.** `text.mode: local_rules`. No text model is called. A brief alone is `blocked` until reviewed text or a storyboard is supplied.
- **Images.** Library images only. No image engine is configured.
- **Transcription.** Not available. Audio is never transcribed, and audio alone is refused.
- **Timing.** Three labelled sources: `measured_synthesis` (the WAV the local engine wrote), `supplied` (storyboard times that cover supplied audio), and `estimated_text_length` (a proportional split of supplied full audio). Alignment is `not_requested` in every case.
- **Approval.** Apply never approves audio. Supplied recordings and generated clips are both `approved: false`.

### 3.6 Apply: order, atomicity, and assets

Order: validate everything; synthesize only missing speech, reusing speech that passes validation; build the document with the canonical builder; save the project; write editor state; write provenance; add generated assets to the library index by id; update the draft record.

Any failure removes what this apply created (project directory, output directory, created files, and the generated asset ids). The library index is never restored from a snapshot, so concurrent uploads survive.

**Speech reuse** requires all of: an active asset tagged `generated-speech`; a matching sha256 of the file bytes; a duration that matches both the index and the WAV header within 0.01 s; and an eligible, configured voice. Otherwise the scene is synthesized again under a new asset id, unapproved.

**Provenance** (`factory-provenance.json` in the project directory): draft id and revision, format, content profile, reference project id, source identity, timing source, speech policy (`supplied_full_audio` or `generated_per_scene_unapproved`), generated assets with sha256, and visual decisions per scene.

**Reference project** (`referenceProjectId`) is never written.

---

## 4. Frontend integration (`apps/web`)

| Piece | What it does |
|---|---|
| `src/lib/factory-api.ts` | Typed client for the five routes. `FactoryApiError` carries `answered`, `code`, `missing`, `currentRevision`. A transport failure has `answered: false`. |
| `src/lib/factory-model.ts` | Pure rules: input checks, identity options, speaker and capability rows, timing and material labels, scene move locks, apply blockers, and `errorView()`. |
| `src/pages/ContentPlan.tsx` | Planning page. Inputs; draft status; treatments with rationale, order, visual intent, and speakers; scene table with speaker, picture, lock, and order decisions; voices; review-gated apply. Injected `PlanDeps`. Production uses the real client. |
| `src/lib/audio-track-ops.ts` | Pure ADD and REPLACE builders for `audioClips`. |
| `src/components/editor/AudioTrackActions.tsx` | ADD AUDIO and REPLACE SELECTED AUDIO as separate sections. Mounted after `EditorNarrationPanel`. Uses the page's `stage`, so operations go through `save` and `commitOperations`. |
| `src/App.tsx` | `plan` step and header button `open-content-plan`. `?draft=` reopens a draft. The button reads the current draft from the address bar, so "Start a new plan" is not undone by a stale reopen. |
| `vite.config.ts` | `server.allowedHosts` adds `.e2b.app`. Vite returned `403` for the sandbox preview host without it. |

### 4.1 Behaviour

- **Input modes.** Brief only (blocked until reviewed text), reviewed script, ready audio with its script (audio used as supplied), and storyboard v1 (checked before sending).
- **Identity.** Religious content cannot select BuildTrack (disabled in the form; `422 FACTORY_IDENTITY_REFUSED` on the server). Educational content allows an explicit identity or none.
- **Treatments.** Three per profile, each with rationale, scene order, beats, speakers, and visual intent. Only the selected treatment shows its scene table. Switching treatment is refused while scene edits are unsaved.
- **Voices.** Options come from capability results per speaker and language. Arabic shows "Generation unavailable for Arabic" and points to imported approved audio.
- **Apply.** Disabled until the review checkbox is ticked and there are no unsaved edits. Success opens the project in the existing Editor. On a transport failure, the page re-reads the draft and reports only what the server lists. It never claims completion without a reply.
- **Errors.** Form and scene edits stay on screen. A revision conflict offers "Reload draft" and keeps unsaved edits.
- **Reopen.** `?draft=dft_…` restores the revision, the selected treatment, and the speaker decisions from the server.
- **Editor audio.** REPLACE needs the track selected, the replacement file chosen, a per-track review checkbox, and the track id typed. It changes `sourceAssetId`, `sourceInSec`, and `sourceOutSec`, and sets `approved: false`. The previous file stays in the library.

### 4.2 Test doubles (labelled)

`tests/web/fixtures.ts` holds TEST DOUBLES for the factory client, used by the DOM tests only. They are not production code, and nothing in `apps/` imports them. DOM tests run in happy-dom. Their results are DOM-level evidence against test doubles, not evidence of the live API or a browser.

---

## 5. Commands and results

All run in `/home/user/m2-work` on the final code.

| Command | Result |
|---|---|
| `npm run build:core` | exit 0 |
| `npx tsc --noEmit -p apps/api/tsconfig.json` | exit 0 |
| `npx tsc -p packages/core/tsconfig.json --noEmit` | exit 0 |
| `npx tsc --noEmit -p apps/web/tsconfig.json` | exit 0 |
| `npx tsc` on a temporary strict config that adds `tests/web/*` (outside the repo) | exit 0 |
| `npm run build:web` | exit 0 |
| `npx vitest run` on the 15 focused files (factory, editor, and `tests/web`) | exit 0. **277 tests passed.** |
| `evidence/http-check-live.mjs` against a live API on isolated data | **17 of 17 passed** |
| Vite dev server on `0.0.0.0:5178` proxying to that API | starts with no host warning; `/` 200; `/api/factory/capabilities` and `POST /api/factory/drafts` through the proxy return the same results as direct calls |

Not run: the full suite, any render, any browser test, owner-host checks, owner data.

No dependency, manifest, or lockfile changed in this round.

---

## 6. Recorded contract samples

Files in `evidence/`:

- `contract-samples-round2.json`: trimmed real responses. Keys: `createEducationalLandscape`, `staleRevisionApply`, `applyLandscape`, `editorDocumentLandscapeExcerpt`, `applyPortrait`, `religiousBuildTrackRefused`, `briefOnlyDraft`, `briefOnlyApply`, `unknownDraft`, `unknownVisualAsset`.
- `http-check-live-round2.json`: 17 checks with recorded responses.
- `http-check-live.mjs` and `contract-samples-round2.mjs`: the scripts that produced them. Both read `API_BASE` and `FIXTURE_IDS`.
- `fixture-asset-ids.json`: the fixture library ids from that run. Synthetic media only.

Key results (abbreviated):

| Request | Status | Body (abbreviated) |
|---|---|---|
| Educational landscape draft, script + 2 pictures | 201 | `status: review_required`, 3 treatments, `speakers` with `sam-reader` and `sam-narrator` |
| Apply after a revision bump, stale revision | 409 | `{"code":"FACTORY_REVISION_CONFLICT","currentRevision":1}` |
| Apply landscape | 201 | `{"projectId":"Factory_b748578cb633","targetId":"long","format":"landscape","editorRevision":0,"timingSource":"measured_synthesis","speechGenerated":4}` |
| Apply portrait | 201 | `{"projectId":"Factory_f4c6030b559e","targetId":"long","format":"portrait","editorRevision":0,"timingSource":"measured_synthesis","speechGenerated":4}` |
| Editor document (landscape) | 200 | `format: landscape`, `targetId: long`, `alignment.status: not_requested`, audio clips `approved: false`, crops `full` or `tight` by treatment |
| Religious with `channelBrandId: buildtrack` | 422 | `{"code":"FACTORY_IDENTITY_REFUSED","error":"BuildTrack was not substituted…"}` |
| Brief only | 201 | `status: blocked`, `missing: [{kind:"script"}]` |
| Brief-only apply | 422 | `{"code":"FACTORY_INPUTS_REQUIRED","missing":[…]}`. No project. |
| Unknown visual asset | 422 | `FACTORY_ASSET_INVALID`. No draft saved. |
| Unknown draft | 404 | `{"code":"FACTORY_DRAFT_NOT_FOUND","error":"Draft not found."}` |

Round-1 recordings (`contract-examples.json`, `treatments-*.json`, `derived-editor-*.json`) are kept as recorded. Where they say portrait is refused, they are superseded by the portrait results above.

---

## 7. Local constraints and operational notes

- **Data directory.** The local sam-js engine writes relative to the working directory. Put `BUILDTRAKE_DATA` and `BUILDTRAKE_OUTPUT` under the repository (for example under the git-ignored `.stills/`). A directory outside it gives `503 FACTORY_SPEECH_FAILED`, and nothing changes.
- **Library side effect.** Apply adds generated speech to the library index of the running data directory (`factory-speech-*`, `sfx`, tagged `generated-speech`). That is the designed behaviour, and it is a real write. Review it before running against owner data.
- **Ports.** The sandbox preview uses Vite on `5178`. The API defaults to `3000`, and `BUILDTRAKE_API` points the proxy at it.

---

## 8. Conformance and limits

The full requirement-by-requirement table is in `FREEBUFF_DELIVERY.md` §2. Summary:

**Met with evidence (fixture data):** portrait apply; speech order lock; supplied-time attachment; approval never implied; atomic apply with forced failures; cache validation; pre-write refusal of missing or blocked imagery; crop and still motion in the editor document; gap reporting; robotic-voice labelling; brief-only blocking; religious identity refusal; distinct ADD and REPLACE; conflict and transport-failure handling; reopen restore; web build and typecheck; HTTP behaviour (17 of 17).

**Code only:** the format-to-composition mapping in rendering; apply opening the Editor in a browser.

**Not met:**

1. Educational contextual product mention, separate from the promotional CTA. Not built (open question Q2). The profile copy was corrected so it no longer claims it.
2. A dedicated edit flow for generated, unapproved narration, with dependent audio and timing invalidated (Q3).
3. Browser verification of any page. No Chrome is available.
4. Render verification, frame review, and the two synthetic previews.
5. Owner-host checks.

**Known behaviour to decide (Q1):** applying the same unchanged draft twice creates two derived projects. Both are recorded in `appliedProjects`. The UI disables Apply while a request is in flight, and navigates to the project on success.

**Engines and content limits:**

- Only sam-js runs: robotic English samples, not natural speech.
- Arabic speech, semantic text planning, image generation, and transcription are unavailable.
- Treatment quality comes from fixed local rules and is not editorially reviewed.
- Rollback is tested on fixture data with three forced stages. Other interruption points are not tested.

**Not complete:** the generative factory. Milestone 2 does not claim it.

---

## 9. Patches and files

- Incremental, `2a4083a..HEAD`: `/home/user/delivery/milestone-2/round2/m2-round2-incremental.patch`
- Cumulative, `3178561..HEAD`: `/home/user/delivery/milestone-2/round2/m2-cumulative.patch`

Both are UTF-8 `git diff --binary` output kept outside Git. Their SHA-256 values are in the chat report.

Round-2 changed files (`2a4083a..HEAD`):

```
apps/api/src/services/factory-service.ts        envelope fields only
apps/web/src/App.tsx                            plan step, header button, reopen
apps/web/src/pages/Editor.tsx                   AudioTrackActions mount (+2 lines)
apps/web/src/pages/ContentPlan.tsx              new
apps/web/src/lib/factory-api.ts                 new
apps/web/src/lib/factory-model.ts               new
apps/web/src/lib/audio-track-ops.ts             new
apps/web/src/components/editor/AudioTrackActions.tsx   new
apps/web/vite.config.ts                         allowedHosts
packages/core/src/factory/contract.ts           envelope types
vitest.config.ts                                include .tsx, automatic JSX
tests/web/fixtures.ts                           new (TEST DOUBLES)
tests/web/factory-model.test.ts                 new
tests/web/audio-track-ops.test.ts               new
tests/web/content-plan.test.tsx                 new
tests/web/audio-track-actions.test.tsx          new
docs/execution/milestone-2/FREEBUFF_DELIVERY.md         new
docs/execution/milestone-2/ARENA_DELIVERY.md            rewritten
docs/execution/milestone-2/LOCAL_VERIFY_STEPS.txt       rewritten
docs/execution/milestone-2/evidence/*                   new (round-2 evidence)
```

Round-2 review fixes in `d413a6d` (also in `2a4083a..HEAD`): `packages/core/src/factory/{contract,planning,draft-plan,validation,editor-mapping}.ts`, `apps/api/src/services/{factory-service,factory-speech}.ts`, `tests/factory-api.test.ts`, `tests/factory-planning.test.ts`.

Not changed: `package.json`, any lockfile, any manifest, `data/`, `output/`, the editor modules other than the mount point, approved recordings, the 16 timings, and `apps/api/src/services/byte-range.ts` (not written).
