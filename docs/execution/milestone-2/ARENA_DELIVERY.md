# Milestone 2 — Content-led planning and generation (Arena delivery)

Status: **code-level and HTTP-level evidence on fixture data only.** Nothing here is owner acceptance, full factory completion, or approval of creative quality. No owner recording, owner image, approved timing, `data/`, or `output/` was read or changed.

## 1. Identity

| Item | Value |
|---|---|
| Required base | `3178561a36d9b1cc85f6eb58e1698a8f4890205d` (`factory/m1-integrated-handoff-2026-10-13`, descends from `1609c1a`) |
| Session branch | `arena/890ccb82-video-factory` (fixed by the session; not renamed) |
| Remote session head before this delivery | `1609c1a3154f7bfe12ab605de4c05ff174840c93` |
| Delivered commit (local) | Recorded in the chat report with `git rev-parse HEAD` in worktree `/home/user/m2-work` |
| Push | `git push origin HEAD:refs/heads/arena/890ccb82-video-factory` (fast-forward; no force) |

**Blocker, reported not hidden:** the main checkout `/home/user/Video-Factory` is at `b235b00` on `arena/890ccb82-video-factory` with 53 modified and 132 untracked files. It was preserved untouched (backup: `/home/user/backups/video-factory-dirty-b235b00-20261013T142419Z.tar.gz`). Its local branch ref was **not** updated. The work lives in the clean detached worktree `/home/user/m2-work` and is pushed by explicit refspec.

## 2. What was built

### Endpoints (new, `apps/api/src/routes/factory.ts`)

| Method and path | Result |
|---|---|
| `GET /api/factory/capabilities` | `{version:1, text, speech, image, transcription, storyboardImport}` plus additive `speech.languages` (en/ar separately) and `speech.engines` |
| `POST /api/factory/drafts` | `201` envelope, or `422` with `{code,error}` |
| `GET /api/factory/drafts/:draftId` | `200` same envelope; `404 FACTORY_DRAFT_NOT_FOUND` |
| `PATCH /api/factory/drafts/:draftId` | `200` envelope; `409 FACTORY_REVISION_CONFLICT` with `currentRevision`; `423 FACTORY_SCENE_LOCKED`; `422` validation |
| `POST /api/factory/drafts/:draftId/apply` | `201 {projectId, targetId:"long", editorRevision}`; `422 FACTORY_INPUTS_REQUIRED` with `missing`; `409` on wrong revision |

Errors are `{code, error}` (plus `missing` or `currentRevision` where the contract requires them). No stack, no filesystem path. A generic `FACTORY_INTERNAL` is returned for unexpected failures, with the detail logged server-side only.

### Core (`packages/core/src/factory/`, exported from the core barrel)

- `contract.ts`: types, constants, stable error codes, `FactoryError`.
- `planning.ts`: sentence-unit splitting that keeps supplied words exact; role classification; **three treatments per profile**.
- `validation.ts`: strict request parsing (unknown scene fields rejected); `reconcileSelection` enforces narration equality, every-unit-exactly-once, asset eligibility, server-owned fields, locked rows (423), and treatment switches blocked while a lock is present.
- `draft-plan.ts`: units, treatments, speakers, missing items, warnings, status.
- `editor-mapping.ts`: timing plan (three labelled sources) and the canonical editor document builder, validated by the existing `assertValidEditorDocument`.

### API services

- `services/factory-speech.ts`: capability probes. Only the local `sam-js` synthesizer is reported available, and only after it loads. Kokoro and Chatterbox are reported unavailable with the reason (their provisioning markers are absent; nothing was downloaded or installed).
- `services/factory-service.ts`: persisted revisioned drafts under `DATA_DIR/factory/drafts/`, in-process draft locks (409 `FACTORY_DRAFT_BUSY`), source identity (SHA-256 of script and storyboard, audio asset id and sha, visual ids, reference project id), speech reuse keyed by voice and text, and the apply path with rollback.

### Behaviour

- **Treatments are local rules, not semantic AI.** `text.mode` is `local_rules` and every envelope carries the warning. No text provider is configured in this workspace (no provider keys or engines were found), so none was called.
- **Religious** (`reflection`/`passage` roles from quotation marks, ﴿﴾, or speech markers such as قال / يقول / تعالى). Three alternatives: reading sequence (reader voice over held frames); reflection first with the passage as anchor; reflection framing a central passage. Religious drafts never bind a BuildTrack identity. `channelBrandId: "buildtrack"` is refused with `422 FACTORY_IDENTITY_REFUSED`. No quotation or wording is added; the code only slices and reorders supplied text.
- **Educational** (`problem`/`example`/`action`/`explanation`). Three alternatives: problem → example → action; question-led walkthrough (question, steps, example, recap action); worked example first. Speaker roles and visual intents differ between them.
- **Promotional**. Three alternatives: problem, proof, CTA; demo first; proof first. The CTA is last in the first alternative.
- **Speakers** resolve only to configured voices (`sam-reader`, `sam-narrator`, `sam-host`). Unassigned speakers take free voices; if voices run out, they share one and a warning says voice diversity is not complete.
- **Arabic speech** is unavailable. Arabic narration with no supplied audio is `blocked` with a speech item per scene. English speech is available only through the synthetic local voices.
- **Transcription** is unavailable. A draft with audio but no reviewed text is `blocked` (`transcription`).
- **Images**: scenes without an assigned asset take supplied, then licensed library images (not logos, icons, fonts, SVGs, or blocked assets). If none exist, the scene is reported missing (`image`). No image engine is configured.
- **Timing** is never invented. Three sources, each labelled: `measured_synthesis` (real length of the WAV the local engine wrote); `supplied` (contiguous storyboard times that cover the supplied audio); `estimated_text_length` (a labelled proportional split of supplied full audio). Alignment stays `not_requested` in every case.
- **Apply** creates a new derived project each time. It never writes `referenceProjectId`. Order: validate everything, synthesize only missing speech (reusing unchanged speech), build the document through the canonical builder, save the project, write editor state, update the library index, then update the draft record. Any failure removes the derived project, generated files, and index changes. Supplied scene times are refused (`422 FACTORY_INPUTS_REQUIRED`) when speech would have to be generated, because generated speech would change approved times.
- **Locks and speaker change**: a changed speaker or text gets a new speech key, so only that scene's generated speech is regenerated. Unchanged scenes keep their asset ids.

## 3. Changed files (against `3178561`)

```
apps/api/src/server.ts                                  (+2: import and register factory routes)
apps/api/src/routes/factory.ts                          (new)
apps/api/src/services/factory-service.ts                (new)
apps/api/src/services/factory-speech.ts                 (new)
packages/core/src/index.ts                              (+1: export factory barrel)
packages/core/src/factory/index.ts                      (new)
packages/core/src/factory/contract.ts                   (new)
packages/core/src/factory/planning.ts                   (new)
packages/core/src/factory/validation.ts                 (new)
packages/core/src/factory/draft-plan.ts                 (new)
packages/core/src/factory/editor-mapping.ts             (new)
tests/factory-planning.test.ts                          (new)
tests/factory-api.test.ts                               (new)
docs/execution/milestone-2/ARENA_DELIVERY.md            (this file)
docs/execution/milestone-2/LOCAL_VERIFY_STEPS.txt       (new)
docs/execution/milestone-2/evidence/*.json              (new: recorded responses and derived-editor summaries)
```

Not changed: `apps/web`, frontend tests, `packages/video`, `package.json`, any lockfile or manifest, `data/`, `output/`, the editor modules, the approved recordings, and the 16 timings. `apps/api/src/services/byte-range.ts` was not written or touched.

## 4. Commands and results (all run in `/home/user/m2-work`)

| Command | Result |
|---|---|
| `npm ci --ignore-scripts --no-audit --no-fund` | exit 0. Reproduced the lockfile only. No lockfile change. |
| `npm run build:core` (final) | exit 0 |
| `npx tsc --noEmit -p apps/api/tsconfig.json` (final) | exit 0 |
| `npx vitest run tests/factory-planning.test.ts tests/factory-api.test.ts` | exit 0. **2 files, 46/46 tests passed** (22 core, 24 HTTP) |
| `npx vitest run tests/editor-api.test.ts` (regression: routes and core exports changed) | exit 0. **22/22** |
| `node --import tsx .stills/m2-samples/make-samples.ts` (sample run, isolated data under `.stills/`) | exit 0. 13 real HTTP steps; statuses listed in §5 |

Not run: the full suite, browser or Remotion renders, owner-host checks, and any frontend build. The renderer inputs did not change, so no fixture render was needed.

## 5. Recorded contract examples

`evidence/contract-examples.json` records each request and its real response. Status sequence, in order:

`200` capabilities · `201` educational draft · `201` religious draft with supplied audio · `201` Arabic religious draft, no audio (status `blocked`) · `422` BuildTrack identity refused · `422` storyboard version 2 · `422` unknown visual asset · `200` GET draft · `409` stale revision · `422` apply of a blocked draft · `200` PATCH with a speaker change (revision 0→1) · `201` apply educational · `201` apply religious

Treatment summaries (`evidence/treatments-*.json`) and the derived editor summaries (`evidence/derived-editor-*.json`) are generated from the same run.

Observed structures, from those files:

- **Religious** (sample has one quoted passage): reading sequence `passage_reading > reflection × 4`; reflection first `reflection_opening × 4 > passage_anchor`; central passage `reflection_frame > passage_centre > reflection_frame × 3`.
- **Educational**: problem, example, action, action (speakers learner, instructor, instructor, instructor); question-led `question > walkthrough_step > walkthrough_example > walkthrough_step` (learner, instructor, learner, instructor); worked example first `worked_example > problem_context > action > action` (learner, instructor, learner, learner).
- **Derived educational editor** (speech measured by the local engine, speaker changed on u03 to `host`): 4 visual clips at 0, 5.848, 10.859, 14.787 s; audio clips by speaker; `alignment.status: not_requested`; `channelBrandId: null`; duration 18.977 s.
- **Derived religious editor** (supplied 6-second audio): one full-narration audio clip, 0–6 s, `speakerId: null`; visual clips estimated by text length; `alignment.status: not_requested`; RTL captions; `channelBrandId: null`.

The "reader" structure is shown by one quoted passage. Richer scriptural sequences need more passages in real input.

## 6. Conformance report

Key: **Met** = verified by a test or a recorded HTTP response (fixture data). **Code** = implemented, not directly tested. **Not met** = not delivered in M2.

| Requirement | Status | Evidence / note |
|---|---|---|
| Capabilities endpoint shape; only verified engines available; local rules labelled | Met | HTTP test; `make-samples` step 1 |
| Drafts endpoint: 201 envelope, validation before write | Met | HTTP tests for create, 422 cases |
| GET draft returns the same envelope | Met | HTTP test (`toEqual`) |
| PATCH: stale revision → 409 with `currentRevision`; no write | Met | HTTP test (state equal before and after) |
| PATCH: edited narration, dropped unit, added narration, unknown treatment, ineligible asset, server-owned change, bad timing, unknown voice → 422; no write | Met | HTTP test (seven cases, state unchanged) |
| Locked rows: change → 423; unchanged → byte-for-byte; treatment switch with lock → 423 | Met | HTTP test and core test |
| Apply: 201 `{projectId,targetId,editorRevision}`; new derived project | Met | HTTP test; sample step 12 |
| Apply: unresolved inputs → 422 `FACTORY_INPUTS_REQUIRED` with `missing`; no project created | Met | HTTP test (project directory list unchanged) |
| Apply: wrong revision → 409; no project | Met | HTTP test |
| `referenceProjectId` never overwritten | Met | HTTP test (SHA of its `project.json` before and after) |
| Source identity and provenance persisted | Met | HTTP test (stored hash, reference id); `factory-provenance.json` |
| Three substantive treatments per profile, with different order, speakers, beats, and visuals | Met | Core tests; `treatments-*.json` |
| Supplied words, facts, and scripture preserved; no invented quotations | Met for the code path | Narration equality checks in tests. The rules only slice and reorder. The editorial quality is not reviewed. |
| Educational problem/example/action demonstrated, not headings | Met (rule-based) | Core test; beats and visual intents. Classification is a keyword heuristic. |
| Script + assets, audio + known script, storyboard v1 | Met | HTTP tests |
| Unknown audio text → blocked unless a transcription engine runs | Met | HTTP test (`transcription`) |
| Timing labelled; no text-length claim as acoustic proof | Met | Core tests; apply tests check `timingSource` and `alignment.not_requested` |
| Missing imagery fulfilled from library or reported missing | Code | Library fallback is exercised by HTTP tests. The missing-image report path has no dedicated test. |
| Speakers resolve only to configured voices; Arabic and English reported separately | Met | HTTP test (`voiceId` 422); capabilities `speech.languages` |
| Synthesize only missing, unapproved speech; reuse approved bytes | Met | HTTP test: an unchanged scene keeps its asset id; the changed speaker's scene gets a new one |
| No speech engine: exposed as unavailable; external-audio import still works | Met for exposure; import Code | Capabilities test. The existing external-audio import tests were not re-run beyond `editor-api`. |
| Apply maps reviewed scenes, assets, captions, audio into the canonical editor | Met | HTTP test: `assertValidEditorDocument`, caption text exact, speaker per clip |
| No half-applied project on failure | Partly | Refusals before writing are tested. The rollback after a mid-write failure is **code-only** and not forced in a test. |
| Storyboard version other than 1 → 422 | Met | HTTP test |
| Religious content never inherits BuildTrack identity | Met | HTTP test (refused); draft stored with `channelBrandId: null` |
| Frontend, `data/`, `output/`, approved timing untouched | Met | Git status; the sample and test runs used `.stills/` |
| Two-subject demonstration with visibly different structures | Met (fixture, rule-based) | Evidence files §5 |
| At most two 8–12 s renders, only if renderer inputs changed | Not applicable | Renderer inputs unchanged; no render run |
| Real synthesis evidence only if an engine is configured | Met for `sam-js` | Local WAVs were written by the engine during apply tests and the sample run; durations are measured. Kokoro and Chatterbox untested and unavailable. |
| Arabic speech | Not met | No runnable Arabic engine |
| Text provider, transcription, image engine | Not met | None configured; reported unavailable |
| Storyboard file importer | Not met | Inline storyboard only; reported as such |
| Voice diversity complete | Not met | Three synthetic local voices only; labelled |

## 7. Known limits and unresolved items

1. **Main checkout** dirty at `b235b00`; local branch ref not updated (see §1).
2. **Engines.** Only `sam-js` runs (synthetic, robotic, English). Kokoro and Chatterbox were not provisioned and were not downloaded. No text provider, transcription, or image engine is configured. Arabic speech is unavailable.
3. **ffmpeg and ffprobe are not installed** in this sandbox. Upload measurement and any render through ffmpeg cannot be verified here. M2 does not need them for its tested paths.
4. **Portrait apply** is refused (`422 FACTORY_FORMAT_UNSUPPORTED`). The editor's `long` target is landscape-only; portrait needs the short targets, which M2 does not map.
5. **Owner-host checks** were not run. Owner media, owner recordings, and owner approvals were not used.
6. **Frames not inspected.** No renders were run, so no frame review was done. Audio mapping was checked through the editor JSON and the measured WAV durations.
7. **Rollback test gap.** The rollback path after a mid-write failure is code-only. A forced-failure test should be added before this is relied on.
8. **Generated speech is registered in the library index** of the running data directory on apply (`factory-speech-*` entries, `sfx` kind, labelled as generated). In production that writes under the owner's `data/assets/`. That is the designed behaviour of apply, but it is a real side effect to review.
9. **Driving the speech adapter** needs the data directory under the working directory, because the existing synthesizer writes relative to it. Otherwise apply returns `503 FACTORY_SPEECH_FAILED` and changes nothing.
10. **Treatment quality** is rule-based and unreviewed creatively. This is not owner or editorial approval.

## 8. Patches

- Incremental patch (against `3178561`, UTF-8, excluding the baseline): `/home/user/delivery/milestone-2/m2-incremental.patch`
- Cumulative patch against the verified integrated start: the same file, since M2 is a single commit on `3178561`.
- Neither patch is committed to Git. They are kept outside the repository.
