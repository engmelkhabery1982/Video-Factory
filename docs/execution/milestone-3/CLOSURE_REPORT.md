# Milestone 3 — closure report (authoritative closeout order)

**Status: NOT COMPLETE. The factory is not declared complete.**
Critical open gates: live Gemini availability and quality, the paid still-image route (no owner
decision yet), real forced alignment on owner media, browser acceptance, render and frame
inspection, and owner-host acceptance.

## Evidence labels

- **code-checked**: typecheck, build, or a unit test of a pure function.
- **route-tested**: the real registered Fastify server through `app.inject`, with a labelled
  provider double (no real network) and synthetic fixture media.
- **DOM-checked**: a happy-dom component test with a labelled client double. Not browser acceptance.
- **fixture**: synthetic media or a labelled double. Never evidence of real-provider readiness.
- **blocked**: a gate this sandbox cannot run. Named below.
- **open**: not built.

## Base and checkpoints

- Remote head at the start of this closeout: `2b315a641621d7967ca6b245c66f56f6893d6da5`
  (`2b315a6`, the previous closure commit). It descends from the checkpoint `4d2723c`.
- The owner-local commit `de545d0fe69e9d3047c0e052323c74488cffdddb` is **not** in this clone and
  not on origin. `git cat-file` fails for it. Nothing here is verified against it.
- The main checkout `/home/user/Video-Factory` was not modified (it is dirty at `b235b00`). Work was
  done in the clean worktree `/home/user/m3-work`, created from `origin/arena/890ccb82-video-factory`.
- Dependencies: `npm ci --ignore-scripts` (lockfile-only, disclosed). No manifest or lockfile change.

## Stage status

| Stage | Status | Summary |
|---|---|---|
| 1. Input completion | **Partly verified** | Six input paths reach one canonical draft and export, or state a missing requirement. Missing requirements block Apply before spend. Owner media not tested. |
| 2. Script and direction | **Partly verified** | Planning, derived rewrites with immutable originals, product-mention rules, and religious refusal are verified. Product-mention insertion is **open**. Live treatment quality is unverified. |
| 3. Speech | **Verified (fixture)** | Ordered multi-speaker unary turns, separate styles, selective regeneration, server-side exact call count, ledger and cache across restart. Live Google speech is unverified. |
| 4. Visual generation | **Route chosen; integration built; live route blocked by an owner decision** | One paid image route (Gemini image model via generateContent). Gated, budgeted, per-shot, bound, and tested with a labelled double. No live call. Video generation not implemented. |
| 5. Synchronization | **Code-checked; real alignment blocked** | Audio identity, sidecar binding, transcript provenance, stable cue links, and clip-bounded highlights are in place. The real runner is not executed here. |
| 6. Edit and export | **Existing controls; not re-verified in this closeout** | Final export and preview share one render path. Editor controls exist. Browser checks are blocked. |
| 7. Consolidated delivery | **This report** | Checks run after the final code change are listed below. |

## Stage 1 — input completion

Canonical project: every path ends in the same editable draft, then Apply, then the Editor.

| Input path | Status | Evidence | Missing requirement shown |
|---|---|---|---|
| Idea / brief only | Plans only with a text provider (Gemini, paid text route, or labelled local rules). No speech or media is invented. | `factory-planning`, `gemini-plan-flow` (route-tested, double) | Missing script, speech, and pictures are listed in `missing`. |
| Supplied script | Draft builds from the script; speech needs an engine. | `factory-api` (route-tested) | Missing engine, Arabic speech, or pictures is listed. |
| Images with brief or script | Each shot binds to a library file: type, source, licence, status, hash. | `factory-binding` (7, route-tested, fixture media) | `missing`, `blocked`, `changed`, or `incompatible` per shot. |
| Storyboard | Supplied storyboard times apply only with matching audio. Storyboard times without audio are refused. | `factory-api` ("refuses supplied times without audio with 422 FACTORY_INPUTS_REQUIRED") | Audio is named as missing. |
| Supplied audio | Applied with its identity and duration. Arabic narration needs supplied audio. | `factory-api` (route-tested) | Arabic speech missing is named. |
| Screen recording with narration | Fixture recording plus narration reaches the same draft and export. | `factory-video-narration` (HTTP-only, fixture) | A recording is required for a recording shot. A still is refused. |

Not verified: owner recordings, owner pictures, owner storyboard, and any live provider output.

## Stage 2 — script and direction

- **Verified (route-tested or code-checked):** narration stays unapproved until reviewed. Treatments
  come from the plan. Supplied order is kept (`factory-api`). Derived rewrites keep the original
  immutable, record before and after, and need review before speech or apply (`factory-derive`,
  source hash unchanged).
- **Verified:** educational product mention is off by default. A mention with no supplied fact is
  refused before any call. Religious content refuses a mention before any call. A religious draft
  asking for the BuildTrack identity is refused with `FACTORY_IDENTITY_REFUSED` (`factory-product-mention`, 5).
- **Code-checked:** an enabled mention must use the supplied fact's text verbatim
  (`tests/gemini-contract.test.ts`).
- **Open:** an enabled product mention is recorded on the plan but **not inserted** into the draft or
  video. An owner-approved insertion line is not built.
- **Unverified:** whether a live model yields three semantically distinct treatments. Fixture plans only.

## Stage 3 — speech

- **Verified (labelled double):** two speakers use separate unary turns, each with its own voice and
  `style` (`factory-spend-speakers`, 8). Changing one speaker's style or voice invalidates only that
  speaker's clips; the other speaker's clips stay byte-identical. Saved speakers survive restart.
- **Verified:** the apply count is shown before confirmation. The server recounts and refuses a
  mismatch with zero provider calls. Budget refusal happens before any call. A failed turn keeps its
  charge and its saved clip, and a retry calls only the missing turns (`factory-turn-cache`).
- **Verified:** concurrent duplicate applies in one process create one project and make no provider
  call. Not proven across separate OS processes.
- **Not built:** the owner's extended voice catalog and local delivery-style selection. They are in
  `de545d0`, which is not available here. The repo has only `GEMINI_PREBUILT_VOICES`.
- **Blocked:** live Google speech (no key used, no call made), and Arabic speech (no engine).

## Stage 4 — visual generation

### Route chosen

Source: `https://ai.google.dev/gemini-api/docs/pricing` (chunks 2 and 6), `https://ai.google.dev/gemini-api/docs/image-generation`,
`https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-image` (last updated 2026-10-09).

- **Model:** `gemini-3.1-flash-image` ("Nano Banana 2"). Override: `GEMINI_IMAGE_MODEL`.
- **Endpoint:** `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent`,
  through the same transport as the text client.
- **Free allowance:** none. The pricing page marks the image-output rows "Not available" for the free tier.
  Secondary sources from June to October 2026 agree that no Nano Banana model has a free API tier.
- **Price:** the secondary sources give about $0.067 per 1K image. This was not checked against the primary
  pricing row for this model in this session, so treat it as an estimate.
- **Video:** no route. The Veo models are paid-only in the API. Video generation is **not implemented**.
- **Limitation (unverified):** the image-generation page reviewed here shows the Interactions API as the
  example endpoint. This project uses generateContent, as the owner requires. The image-specific
  `generationConfig.responseModalities` and `imageConfig` shape was **not** re-read from a current
  generateContent example in this session. It is therefore **unverified against the live endpoint**.

### Built (code, route, and DOM checks)

- Gates, in order, before any provider call: `GEMINI_IMAGE_GENERATION_ENABLED=1`,
  `GEMINI_IMAGE_PAID_CONFIRMED=1`, a server key, and budget `GEMINI_BUDGET_IMAGE` (default 0, hard cap 4 per session).
- Route `POST /api/factory/drafts/:draftId/scenes/:sceneId/generate-still` with `{expectedRevision, confirmSpend: true}`.
  Status route `GET /api/factory/visual-generation` (never calls the provider).
- Three phases. The lock is held only around validation and binding. A refused request costs nothing. A
  failed call keeps its charge and saves nothing. A result for a changed draft stays in the library, unbound,
  and the caller gets `FACTORY_REVISION_CONFLICT` with `generatedAssetId`.
- Output checks: MIME type (PNG, JPEG, WEBP only), magic bytes, size ≤ 8 MB, non-empty. Otherwise
  `FACTORY_AI_INVALID_OUTPUT`.
- Request contains only the shot's prompt and aspect ratio. A test asserts no paths or file names.
- Replacement: a second call for the same shot rebinds it. The earlier image stays in the library.
- Library record: `source` says "AI-generated still … Not a screen recording"; `license` says "Owner review required before publication."
- Screen-recording shots are refused (422 `FACTORY_ASSET_INVALID`). A still is never a recording.
- Web: `StillGenerationPanel` in ContentPlan shows the server state, the reason, and the remaining budget.
  Each shot has its own confirmation. A refused call keeps the confirmation.

### Verified

- `tests/factory-visual-generation.test.ts`: **11 of 11** route-tested with a labelled fetch double.
  Covers: off by default (403, no call, no charge); enabled but not paid-confirmed (403); missing
  confirmation and stale revision (422/409, no call, no charge); recording shot refused (422, no call);
  one call binds one shot and leaves the others untouched, and the request carries only the prompt;
  replacement keeps the earlier image; a GIF is refused and the attempt stays charged; a 401 is
  reported plainly and the attempt stays charged; the hard cap of 4 stops the next call before the provider.
- `tests/web/still-generation-panel.test.tsx`: **5 of 5** DOM-checked with a labelled client double:
  no call on mount; the button needs both the server ready state and the shot's confirmation; one click
  sends one call at the revision read; a disabled state blocks the button; a 429 keeps the confirmation.

### Not verified / blocked

- **Blocked:** any live call to the image route. No key was used. No paid call was made.
- **Unverified:** the generateContent image request shape and field names against the live API.
- **Unverified:** the timeout for the image route. The shared transport's timeout and cancellation are
  tested on the text path only (`gemini-provider`). The image route has no timeout test of its own.
- **Unverified:** image quality, aspect fit, text rendering in the image, and licence terms for
  publication. These need owner review.
- **Not built:** video generation; batch generation; editor-level re-render of one replaced shot
  (the draft-level replacement is verified; the Editor is not re-rendered per shot).

### Owner decision required (exact blocker)

Choose one:
1. **Approve paid image billing** for a server key: set `GEMINI_IMAGE_GENERATION_ENABLED=1`,
   `GEMINI_IMAGE_PAID_CONFIRMED=1`, and `GEMINI_BUDGET_IMAGE` to the number of paid stills you accept
   (max 4 per session). Then run one live check. Otherwise, or as well,
2. **Supply your own stills or recordings** for each shot. Those bind without any paid call.

No other provider or free route is authorized. The owner must not paste a key into chat or Git.

## Stage 5 — synchronization

- **Verified (code-checked and route-tested):** exact sidecar binding needs the declared sha256 and
  duration (`targets-sidecar-binding`, `external-narration-api`). Transcript provenance: the runner's
  transcript has `source: frame_emissions`, `independentOfScript: true`, `scriptCopied: false`. A fixture
  transcript is accepted only under `VF_ALLOW_FIXTURE_TRANSCRIPT=1` (`alignment-transcript`). Translations
  link to a spoken cue by stable `cueOf` id and share its timing (`caption-language`). Audio replacement,
  trim, or source change clears approval and alignment (core). Highlights stay inside their visual clip.
  Captions follow one selection rule shared by preview and export.
- **Verified:** no owner-specific boundary value (6.022 s) is in product logic. Its one occurrence in a
  refusal message was reworded and the content-led tests still pass.
- **Unverified:** forced-alignment `available: true` is not proof of speech. The independent transcript
  requires the real runner. The runner needs numpy and fairseq2, which are not installed here.
- **Blocked:** real alignment on owner recordings (no runner, no owner media upload allowed).
- **Blocked:** browser audio-seek test (`external-audio-seek-browser`): no browser.

## Stage 6 — edit and export

- **Verified (code-checked):** final export is a job over the **frozen** revision. It calls
  `renderEditorPreview`, which builds the plan with `editorDocumentToRenderPlan(doc)`. The preview uses the
  same builder. The Export page routes editor projects to Editor final export.
- **Checked by code search (controls exist in the Editor):** crop and motion, volume and gain, captions,
  highlights, caption language, text size, and channel identity (`EditorMediaPanels.tsx`, `Editor.tsx`,
  `EditorTextPanels.tsx`). The caption-language controls have DOM and API tests (`editor-caption-language`).
  The earlier 43-file run passed the editor suites. They were not re-run in this closeout because the editor
  code did not change here. Dedicated tests for each control are not confirmed in this closeout.
- **Unverified:** portrait export and undo on a real browser.
- **Blocked:** browser acceptance of the Editor (no Chromium). Render and frame inspection (no ffmpeg).
- **Not built:** a new editor control. No new editor control was needed for this closeout.

## Stage 7 — six-input capability matrix

| # | Input | Reaches the same editable draft and export? | Label | Missing requirement or blocker |
|---|---|---|---|---|
| 1 | Brief only | Plans only with a text provider. No speech or media is invented. | route-tested (double); live blocked | Live Gemini text (no key used). |
| 2 | Supplied script | Yes, once speech is available. Arabic speech is not. | route-tested | Arabic speech engine. |
| 3 | Supplied script and supplied audio, with storyboard times | Yes, with the supplied timing. | route-tested | Real alignment on owner audio. |
| 4 | Supplied images, with brief or script | Yes, with the binding rule. | route-tested (fixture media) | Owner pictures untested. |
| 5 | Supplied storyboard alone | **Not evidenced.** Storyboard times need audio, so this path stops with a named requirement. | route-tested refusal | Audio. Owner storyboard not tested. |
| 6 | Supplied screen recording with narration | Yes, for fixture recordings. | HTTP-only (fixture) | Owner recording, boundary frames (no ffmpeg). |

## Checks run after the final code change

| Command | Result |
|---|---|
| `npm run build:core` | exit 0 |
| `npm run build:web` | exit 0 |
| `npx tsc --noEmit -p packages/core/tsconfig.json` | exit 0 |
| `npx tsc --noEmit -p apps/api/tsconfig.json` | exit 0 |
| `npx tsc --noEmit -p apps/web/tsconfig.json` | exit 0 |
| `npx vitest run` on 22 targeted files (factory, gemini, web flows, content-led; full list in the log) | 21 files passed; the one failing budget-shape assertion was updated for the new `imageStills` field, and that file then passed 35 of 35 |
| `npx vitest run tests/factory-visual-generation.test.ts` | 11 of 11 |
| `npx vitest run tests/web/still-generation-panel.test.tsx` | 5 of 5 |
| `npx vitest run tests/gemini-provider.test.ts` | 35 of 35 (after the budget-shape update) |

The earlier continuation's 43-file run (685 passed, 1 skipped) covered the editor, sync, and caption
suites. The editor and sync code did not change in this closeout.

## Changed files in this closeout

Modified: `apps/api/src/routes/factory.ts`, `apps/api/src/services/factory-service.ts`,
`apps/api/src/services/gemini-service.ts`, `apps/api/src/services/gemini-store.ts`,
`apps/web/src/components/plan/GeneratedDraftPanels.tsx`, `apps/web/src/lib/factory-api.ts`,
`apps/web/src/pages/ContentPlan.tsx`, `packages/core/src/content-led.ts`, `tests/gemini-provider.test.ts`,
and this report plus the two verify docs.

New: `apps/api/src/services/visual-generation.ts`, `tests/factory-visual-generation.test.ts`,
`tests/web/still-generation-panel.test.tsx`.

No `data/`, `output/`, saved timings, recordings, models, or dependencies are in Git. No key was used.

## Integration overlaps with owner-local fixes (`de545d0`, not available here)

| Owner fix (as described) | Overlap in this closeout | Action during integration |
|---|---|---|
| Gemini 3.8 REST corrections | `gemini-service.ts` (readGeminiConfig, budget shape), `gemini-store.ts` (ledger kinds). `visual-generation.ts` calls `generateContentRaw` | Keep the owner's REST corrections. Re-apply the budget and image-field additions. Re-run `factory-visual-generation` and `gemini-provider`. |
| Extended voice catalog and delivery-style selection | None in this closeout. The speaker `style` field is unchanged | Keep the owner's catalog and its selection. |
| Still-image pan overscan | None | None expected |
| Explicit channel-logo visibility | None | None expected |

## Owner-host acceptance steps (short)

1. Set up the server with `GEMINI_API_KEY` only if you accept paid billing. Otherwise leave the image gates off.
2. Open ContentPlan, generate a plan (with `local_rules` if you do not want Gemini text), and confirm the still panel says "disabled" with the reason.
3. Bind your own stills to the image shots. Confirm the shot list shows the type, source, licence, and status for each.
4. Apply. Confirm the Editor opens the canonical project and the final export is from the saved revision.
5. Listen to every narration line and every clip yourself. A provider success is not your acceptance.
6. Record your decision in `docs/execution/milestone-3/ARENA_DELIVERY.md`, not in chat.
