# Milestone 2, round 2 — integrated delivery report (Freebuff)

**Status: partial, by design.** Verified: code-level tests, web typecheck and build, and HTTP checks against a live API process on isolated fixture data. **Not verified: any browser run, any render, any frame, any owner-host check.** Chrome is not runnable in this sandbox, so every browser or render gate is blocked, not passed. This is not owner acceptance, not creative approval, and not completion of the generative factory.

Companion documents: `ARENA_DELIVERY.md` (full contract, identity, limits) and `LOCAL_VERIFY_STEPS.txt` (how to reproduce).

---

## 1. Identity

| Item | Value |
|---|---|
| Session branch | `arena/890ccb82-video-factory` (fixed by the session; not renamed, no other branch used) |
| Remote session head **before** this push | `2a4083a406602bc93b104a0388c709fb498ecaa5` (Milestone 2 round 1, owner-authored commit). Verified with `git ls-remote`. |
| Note on a previous record | An earlier note named `1609c1a…` as the remote head. That was wrong for this moment. `1609c1a` is an ancestor of `2a4083a`, and the remote head was `2a4083a`. The push below is a fast-forward from `2a4083a`. |
| Round 2 review-fix commit | `d413a6d` (portrait apply, speech order lock, atomic apply, visual decisions, honesty; core, API, tests) |
| Round 2 frontend commit | `cf2d6d6` (content-planning UI, editor audio ADD/REPLACE, envelope fields, dev host allow-list, tests) |
| Docs and evidence commit | `36c6412` (adds this file, `ARENA_DELIVERY.md`, `LOCAL_VERIFY_STEPS.txt`, `evidence/`) |
| Educational copy correction | `ed16755` (`factory-model.ts` profile note; no behaviour change) |
| Final head | `ed16755`, or a later documentation-only commit. The chat report gives the final SHA, checked against the remote after push. |
| Working tree | `/home/user/m2-work`, a clean detached worktree created for round 2. Not the main checkout. |
| Main checkout | `/home/user/Video-Factory` was **not** touched. Read-only check at the end of the round: branch `arena/890ccb82-video-factory`, HEAD `b235b00`, 185 dirty entries (unchanged from round 1). Not reset, stashed, or overwritten. |
| Owner files | `data/`, `output/`, approved recordings, and the 16 timings were not read or written. |
| Dependencies | No change to any `package.json`, lockfile, or manifest. No install was run in this round. No model, provider, or binary was downloaded. |

---

## 2. Review fixes: status against the requirements

Key: **Met** = verified by a test or a recorded HTTP response (fixture data). **Code** = implemented, not tested end to end. **Not met** = not delivered.

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Portrait is not forced to landscape. Requested format kept in draft, document, provenance, and apply response | **Met** | `tests/factory-api.test.ts` "portrait apply keeps the requested format"; live HTTP check "portrait apply keeps format portrait (targetId long)"; `contract-samples-round2.json` `applyPortrait` |
| 1 | Format maps to composition through the existing mapping | **Code** | `apps/api/src/services/editor-render.ts` L192–221: `doc.format` selects `LongVideo` or `ShortVideo` and checks composition dimensions. Not rendered here (no Chrome). |
| 1 | `targetId` stays `long` | **Met** | Apply response and editor document in the HTTP checks. No schema constraint was found that forbids it. |
| 2 | Supplied full audio keeps its narration order; treatments cannot reorder speech | **Met** | `tests/factory-planning.test.ts` (order-lock block, 3 tests); live check "supplied audio + script: speech order locked" |
| 2 | Reorder of speech refused when order is locked (real mismatch case) | **Met** | Core test "a reorder is refused"; API `reconcileSelection` returns 422 |
| 2 | Supplied times stay attached to their source unit across visual edits | **Met** | API test "refuses a changed scene time: times belong to the source unit" |
| 2 | Timing uncertainty persists in the document, provenance, and UI | **Met** | `timingSource` in apply response and `factory-provenance.json`; UI label from `timingLabel()`; tests in `tests/web/factory-model.test.ts` |
| 2 | Apply never implies approval | **Met** | Live check: supplied recording `ac_full_narration` is `approved: false`; generated clips are `approved: false` |
| 2 | Arabic reflection and quoted passage are not interchangeable | **Met (round 1 tests, unchanged)** | `tests/factory-planning.test.ts` religious roles |
| 3 | Forced mid-write failure leaves no half project, no leaked media, no changed draft or cache | **Met** | `it.each` over `after-project`, `after-index`, `before-draft` in "atomic apply (review fix 3)": exact before/after snapshots of projects, outputs, assets dir, index ids, and the draft file |
| 3 | No restore of an old library index over an unrelated concurrent upload | **Met** | Same test: a concurrent upload inserted during `after-speech` survives every rollback. Rollback uses targeted add/remove by id. |
| 3 | Generated speech registered as a normal apply side effect with generated provenance | **Met** | Library entries tagged `generated-speech` with source text naming sam-js and "not natural speech"; `factory-provenance.json` `generatedAssets` with sha256 |
| 3 | Cached speech validated (sha256, duration, eligibility, identity) before reuse; changed bytes never reused under the old hash | **Met** | Test "never reuses cached speech whose bytes changed: a new unapproved clip is generated under a new id" |
| 3 | Missing or blocked imagery refused before any synthesis or write | **Met** | Test "refuses an apply whose assigned image became blocked, before any synthesis or write"; live check "unknown picture asset refused" (422 `FACTORY_ASSET_INVALID`) |
| 3 | Reference project and its approvals retained | **Met (round 1 test)** | Reference project SHA check in `factory-api.test.ts` |
| 4 | Each treatment's visual decisions execute on existing features | **Met for crop and still motion** | `editor-mapping.ts`: `tight` → centred 80% crop; `slow_push`/`pan_left`/`pan_right` → editor still motion. Test "treatments change the editor clips". Editor JSON evidence only. |
| 4 | Unexecutable features reported as gaps, not as implemented diversity | **Met** | `unexecuted` list per scene; screen-recording gap ("a still image is shown, not a recording"); footage-motion gap; card gaps. Shown in the scene table as "Not executed: …" |
| 4 | No still masquerading as a screen recording | **Met** | Gap text above; `contract-samples-round2.json` |
| 4 | No dissolve; transitions explicitly refused | **Met** | Every factory clip uses `transition: 'cut'` (`editor-mapping.ts` L173). The request schema has no transition field, so a transition cannot be requested. Dissolve remains out of scope (amendment A1 pending). |
| 4 | Evidence that treatment changes editor output | **Met for editor JSON. Rendered output not verified.** | Core and API tests compare editor clips per treatment. No render was run. |
| 5 | SAM voices labelled accurately as robotic English samples | **Met** | Capabilities `speech.voices[].speakerLabel`; live check "voices labelled robotic"; UI copy in `ContentPlan.tsx` |
| 5 | Reviewed externally generated audio stays first-class | **Met for supplied audio** | Live check "supplied recording is the full narration track"; ADD AUDIO in the editor |
| 5 | No new provider, model, or dependency downloads | **Met** | No install or download this round; Kokoro and Chatterbox are reported unavailable with the reason |
| 5 | Brief-only text without a callable text engine is blocked or explicit local rules; never AI script generation | **Met** | Live check "brief only returns 201 blocked"; apply refused with `FACTORY_INPUTS_REQUIRED`; no text engine is called |
| 5 | Supplied approved wording protected; no editable narration promised for immutable input | **Met** | Page copy: "Speech is the supplied text and is not edited here"; API narration equality checks |
| 5 | Edits to newly generated, unapproved narration are distinguished and invalidate dependent audio and timing | **Not met as a dedicated flow** | The plan page cannot edit narration. The editor's narration panel withdraws approval when `sourceAssetId` or timing changes, but generated-narration text editing is not offered. |

### Frontend scope

| Requirement | Status | Evidence |
|---|---|---|
| Entry from the existing app; legacy and editor flows still usable | **Met (code)** | Header button `open-content-plan` in `App.tsx`; other steps unchanged; the 277 focused tests across 15 files pass, including existing editor suites |
| Profile, format, optional channel identity, and inputs (brief, script, audio with script, pictures, storyboard v1) | **Met** | `ContentPlan.tsx` input form; `tests/web/content-plan.test.tsx` input-mode tests |
| Reuse the existing asset upload and library | **Met** | `api.assets()` and `api.uploadAsset` through `defaultPlanDeps` |
| No audio-only understanding promise | **Met** | Copy: "The audio is used as supplied and is not understood or transcribed." Audio alone is refused before any request. |
| Three treatments with rationale, scene order, visual intent, speaker assignment; explicit selection before apply | **Met** | `treatment-*` test IDs; "lists three treatments…" test; selection saved only with "Save selection" or a radio click that is persisted |
| Available, imported, and missing material shown accurately | **Met** | Picture counts per treatment (`supplied`, `library`, `chosen in review`, `missing`); "Missing" list |
| No presentation-card template; no duplicate timeline | **Met** | None built |
| Voices chosen from capability results per speaker and language; unavailable generation said so; imported audio allowed | **Met** | "generation unavailable" tests; Arabic message points to imported approved audio |
| ADD AUDIO and REPLACE SELECTED AUDIO are distinct | **Met** | `tests/web/audio-track-actions.test.tsx`; `AudioTrackActions.tsx` |
| REPLACE needs review of the specific track; keeps the source file; withdraws approval | **Met** | `audio-track-ops.ts` builder tests; DOM test "REPLACE stays disabled until this track is reviewed and its id is typed" |
| Uses existing editor track operations; no invented endpoint | **Met** | Operations go through the page's `stage` → pending → `save` → `commitOperations` (`Editor.tsx` L159–186) |
| Apply opens the new project in the existing Editor | **Code** | `ContentPlanPage` calls `onOpenEditor` → `setProjectId` and `setStep('editor')`. Not browser-verified. |
| Pass through conflicts, missing inputs, locked-row errors | **Met** | `errorView()` tests; DOM tests for 409, 422 with `missing`, and 423 mapping |
| No completion claim on transport failure | **Met** | DOM test "a transport failure with no reply claims no completion"; the page re-reads the draft and reports only what the server lists |
| Form edits preserved on recoverable errors | **Met** | DOM test "keeps the typed form exactly…"; "keeps the unsaved scene edits" |
| Save and reopen restore draft, selected treatment, and speaker decisions | **Met** | DOM test "restores the draft, the selected treatment and the speaker decision"; live `GET` check "draft reopens with the same revision and selection" |
| No hidden parallel-tab revisions | **Met.** | Patch and apply check `expectedRevision`. Round 3: an identical apply for the same draft revision returns the existing project (`reused: true`) after re-checking its sources. A newer revision creates a new project. See ARENA_DELIVERY.md section 10.2. Q1 is resolved. |
| Religious cannot select BuildTrack; educational allows an explicit identity or none | **Met** | `identityOptionsFor()` disables BuildTrack for religious; server returns `422 FACTORY_IDENTITY_REFUSED` |
| Educational contextual product mention, separate from promotional CTA | **Not met** | Not built. Educational treatments add no product mention or CTA. The profile copy was corrected so it no longer claims a contextual mention exists. See Q2. |
| Unknown or estimated timing shown truthfully; never "aligned" | **Met** | `timingLabel()` tests; no "aligned" wording in the new UI files |
| Engine technical details in a concise status panel only | **Met** | Collapsed "Engine status (technical)" panel |

### Acceptance

| Gate | Status | Evidence |
|---|---|---|
| Web build | **Met** | `npm run build:web` exit 0 |
| Web typecheck | **Met** | `npx tsc --noEmit -p apps/web/tsconfig.json` exit 0 |
| Focused frontend tests: input modes, capability refusal, treatment selection and editing, distinct audio add and replace, conflict and error preservation, draft reopen | **Met (DOM tests with test doubles)** | 45 new tests in `tests/web/` (18 + 5 pure; 16 + 6 DOM). Labelled test doubles, not live evidence. |
| Browser verification against the live API | **Blocked** | `chrome.ok: false` in `/api/health`: "No runnable browser for linux". No Chrome on PATH. No browser download was attempted (outside the allowed hosts). |
| Live HTTP verification against the API | **Met** | 17 of 17 checks against a live API process on isolated data (`evidence/http-check-live-round2.json`) |
| Dev proxy path for the UI | **Met (HTTP only)** | Vite dev server on `0.0.0.0:5178` proxies `/api/factory/*` to the live API; capabilities and draft create return the same results as direct calls |
| No mock fallback in production | **Met** | Test doubles live only under `tests/web/`. `defaultPlanDeps` uses the real client. No production module imports the fixtures. |
| Push UI to the permitted branch and verify the remote SHA | **Pending at the time of writing.** Result in the chat report after `git ls-remote`. |
| Two 8–12 s synthetic previews, only if the tools exist | **Blocked / not attempted** | No Chrome, so no UI screenshot and no Remotion render. `ffmpeg` exists under `node_modules/@ffmpeg-installer` (runs), but a preview needs the browser path. No frames were inspected. |
| No dependency or lockfile changes | **Met** | `git diff` of every `package.json` and `package-lock.json` against `2a4083a` is empty |

---

## 3. What changed in this round

Frontend (`apps/web`):

- `src/lib/factory-api.ts`: typed client for the five `/api/factory` routes. `FactoryApiError` carries `answered`, `code`, `missing`, and `currentRevision`. A transport failure is `answered: false`.
- `src/lib/factory-model.ts`: pure rules. Input checks, identity options, speaker and capability rows, timing and material labels, scene move locks, apply blockers, and `errorView()`.
- `src/lib/audio-track-ops.ts`: pure ADD and REPLACE builders for `audioClips`.
- `src/pages/ContentPlan.tsx`: the planning page. Props are injected (`PlanDeps`). Production uses `defaultPlanDeps`.
- `src/components/editor/AudioTrackActions.tsx`: ADD AUDIO and REPLACE SELECTED AUDIO. Mounted in `src/pages/Editor.tsx` after `EditorNarrationPanel`.
- `src/App.tsx`: `plan` step, header button, `?draft=` reopen. The header button reads the current draft from the address bar, so "Start a new plan" is not undone by reopening an old draft.
- `vite.config.ts`: `server.allowedHosts: ['.e2b.app', 'localhost', '127.0.0.1']`. Without it, Vite rejected the sandbox preview host with HTTP 403.

API and core:

- `packages/core/src/factory/contract.ts`: additive envelope fields `appliedProjects`, `profile`, `inputs`, and the `FactoryAppliedProject` type.
- `apps/api/src/services/factory-service.ts`: `envelopeOf()` fills those fields. Nothing else changed in this round.
- `packages/core/src/factory/editor-mapping.ts` and `planning.ts`: no change in this round. The round-2 changes (order lock, visual decisions, atomic apply) are in `d413a6d`.

Tests and config:

- `tests/web/` (new): `fixtures.ts` (labelled TEST DOUBLES), `factory-model.test.ts`, `audio-track-ops.test.ts`, `content-plan.test.tsx`, `audio-track-actions.test.tsx`.
- `vitest.config.ts`: include extended to `tests/**/*.test.tsx`. Automatic JSX applies to test files only.

Evidence (`docs/execution/milestone-2/evidence/`, round 2):

- `http-check-live.mjs`: the HTTP check script. Reads `API_BASE`, `FIXTURE_IDS`, and `EVIDENCE_OUT`.
- `http-check-live-round2.json`: 17 of 17 checks with recorded responses.
- `contract-samples-round2.mjs` and `contract-samples-round2.json`: trimmed real responses, including the 409 stale revision and the 422 refusals.
- `fixture-asset-ids.json`: the fixture library IDs from that run. Synthetic media only.

Round-1 files `contract-examples.json`, `derived-editor-*.json`, and `treatments-*.json` remain as recorded in round 1. Where they say portrait is refused, they are superseded by the tests and samples above.

---

## 4. Commands and results

All run in `/home/user/m2-work` on the final code.

| Command | Result |
|---|---|
| `npm run build:core` | exit 0 |
| `npx tsc --noEmit -p apps/api/tsconfig.json` | exit 0 |
| `npx tsc -p packages/core/tsconfig.json --noEmit` | exit 0 |
| `npx tsc --noEmit -p apps/web/tsconfig.json` | exit 0 |
| `npx tsc -p /tmp/tsconfig.webtests.json` (strict web config extended to `tests/web/*`; temporary, outside the repo) | exit 0 |
| `npm run build:web` | exit 0. `dist/assets/index-*.js` 493 kB (141 kB gzip). |
| `npx vitest run` on `factory-planning` (25), `factory-api` (39), `editor-api` (22), `editor-contract-integration` (4), `editor-document` (39), `editor-library-audio` (10), `editor-milestone1-ui` (19), `editor-model` (30), `editor-review-fixes` (17), `editor-alignment-preview` (22), and `tests/web` (5 pre-existing + 45 new) | exit 0. **15 files, 277 tests passed.** |
| `node docs/.../evidence/http-check-live.mjs` against `127.0.0.1:3100` (isolated data under the git-ignored `.stills/`) | **17 of 17 passed** |
| `node docs/.../evidence/contract-samples-round2.mjs` | wrote `contract-samples-round2.json` |
| Vite dev server on `0.0.0.0:5178` with `BUILDTRAKE_API` set to the isolated API | starts with no host warning; `/` 200; proxied `GET /api/factory/capabilities` and `POST /api/factory/drafts` 201 |

Not run: the full suite (targeted runs only, as instructed), any render, any browser test, owner-host checks, and any owner data.

Notes on the environment:

- A first HTTP run used a data directory under `/tmp`. The local sam-js engine writes relative to the working directory, so apply returned `503 FACTORY_SPEECH_FAILED` and changed nothing. The rerun used `.stills/live-http/`, which is git-ignored. This is a deployment constraint, documented in `ARENA_DELIVERY.md` §7.
- `/api/health` reports `ffmpegOk: true` from `node_modules/@ffmpeg-installer`, and `ffprobeOk: true` from `ffprobe-static`. No system `ffmpeg` is on PATH. `chrome.ok` is `false`.

---

## 5. Blockers and gates not passed

1. **Browser verification.** No Chrome or Chromium is available, and `/api/health` reports `chrome.ok: false`. The UI was not seen in a browser. Every claim about what the page looks like or how it behaves in a browser is untested. The DOM tests run in happy-dom with injected test doubles.
2. **Render gate.** Remotion needs Chrome, so no fixture preview was rendered. No frame was inspected. Rendered output of treatments is unproven.
3. **Owner-host checks.** Not run. They need owner media, the owner's machine, and owner approval.
4. **Speech quality.** Only the local sam-js English voices run. They are robotic samples. Arabic speech is unavailable. Kokoro and Chatterbox are not provisioned.
5. **Text, image, and transcription engines.** None configured. Briefs alone are blocked, pictures can only come from the library, and audio is never transcribed.

---

## 6. Open questions for the owner

- **Q1. Duplicate apply. Resolved in round 3.** The same draft at the same revision returns the existing project, with its sources re-checked. Details: ARENA_DELIVERY.md section 10.2.
- **Q2. Educational product mention.** Not built. It needs a supplied product name or a contextual rule, and a reliable detector needs semantic understanding that this milestone does not have. Please say whether a supplied-only mention (the owner marks the sentence) is acceptable.
- **Q3. Editing generated narration.** The plan page does not edit narration. Should the editor offer text edits for generated, unapproved narration, with dependent audio and timing invalidated? This needs a decision before it is built.

---

## 7. Conformance summary

- **Met with evidence:** portrait apply, speech order lock, supplied-time attachment, approval never implied, atomic apply with forced failures, cache validation, pre-write imagery refusal, crop and still motion in the editor, gap reporting, robotic-voice labelling, brief-only blocking, religious identity refusal, all planning and apply states on the page, distinct ADD and REPLACE with per-track review, conflict and transport-failure handling, reopen restore, web build and typecheck, and live HTTP behaviour (17 of 17).
- **Code only:** format-to-composition rendering, apply opening the Editor in a browser.
- **Not met:** educational product mention (Q2), dedicated edit flow for generated narration (Q3), browser verification, render verification, owner-host checks.
- **Not complete:** the generative factory. Professional Arabic and English speech, semantic text planning, image generation, and transcription are unavailable. Milestone 2 is not complete as a generative factory.

---

## 8. Patches and files

Patches are UTF-8 `git diff --binary` output, stored outside Git in `/home/user/delivery/milestone-2/round2/`:

- `m2-round2-incremental.patch`: `2a4083a..HEAD` (the round-2 changes on top of the remote head at the start of this push).
- `m2-cumulative.patch`: `3178561..HEAD` (the full Milestone 2 changes from the required M1 base `3178561`).

Their SHA-256 values are in the chat report. `LOCAL_VERIFY_STEPS.txt` gives the reproduction steps.
