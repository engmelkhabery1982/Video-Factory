# Milestone 3 — closure report (authoritative closeout order)

**Status: NOT COMPLETE. The factory is not declared complete.**
Critical open gates: local still generation on the owner's PC (not yet run; `LOCAL_IMAGE_SETUP.md` §6),
a real local planner model (not yet run), real forced alignment on owner media, browser acceptance,
render and frame inspection, and owner-host acceptance. Google is used only for optional speech.
The paid Gemini image route is removed (no Google or cloud image generation).

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
| 4. Visual generation | **Route chosen (local); code and fixture tests built; local run not yet proven on the owner's PC** | stable-diffusion.cpp `sd-cli` (MIT) on the owner's PC, one job at a time, CPU baseline, with SD 1.5 weights (OpenRAIL-M). Prompt → job → validated preview → approve → bind per shot. Fixture runner tests only. No Google or cloud image call. Video generation not implemented. |
| 5. Synchronization | **Code-checked; real alignment blocked** | Audio identity, sidecar binding, transcript provenance, stable cue links, and clip-bounded highlights are in place. The real runner is not executed here. |
| 6. Edit and export | **Existing controls; not re-verified in this closeout** | Final export and preview share one render path. Editor controls exist. Browser checks are blocked. |
| 7. Consolidated delivery | **This report** | Checks run after the final code change are listed below. |

## Stage 1 — input completion

Canonical project: every path ends in the same editable draft, then Apply, then the Editor.

| Input path | Status | Evidence | Missing requirement shown |
|---|---|---|---|
| Idea / brief only | Semantic plans use the local loopback planner (llama.cpp, configured and licence-recorded by the owner); otherwise the labelled offline mode `local_rules`. Google is not used for planning. No speech or media is invented. | `factory-planning`, `gemini-plan-flow`, `gemini-provider` (local loopback double) | Missing script, speech, and pictures are listed in `missing`. |
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

## Stage 4 — visual generation (local)

The Gemini image route (`gemini-3.1-flash-image`) is **removed** by the closeout order. It is not reintroduced
behind flags. Stills are generated locally on the owner's computer.

### Route chosen

- **Runtime:** stable-diffusion.cpp `master-964-1d0a58a` (commit `1d0a58a35050d285b1d6fb1bc68a92924d35825e`,
  published 2026-10-13), MIT. Windows CPU zip 17,574,585 bytes, SHA-256
  `8e4e7bde781ff246817019a182040a087314caf4d21bc15fe4ff045167bd336d`. Vulkan zip 30,155,040 bytes, SHA-256
  `74211cb5c382aec2aeb086b64f2fdf525efec5faec4200a2d3257bc2328954ab`. Sources: GitHub release API.
- **Model:** SD 1.5 (`v1-5-pruned-emaonly`; fp16 conversion about 2.13 GB at Comfy-Org). CreativeML Open RAIL-M,
  use restrictions apply. **The weight SHA-256 is not verified** here; the owner records it.
- **Hardware:** Ryzen 9 5900HX, 15.4 GiB RAM, integrated AMD Radeon, no NVIDIA GPU. CPU is the baseline. No
  performance promise.
- **Flag names:** the upstream README confirms `sd-cli` and `-m`/`-p`. The rest are **unverified** and are checked
  against `sd-cli -h` at runtime.

### Built (code, route, and DOM checks)

- Status, job queue (one job), progress, cancel, timeout, actionable errors, PNG decode validation, approve,
  bind at the reviewed revision, provenance on the asset. `LocalImagePanel` in ContentPlan.
- Details and routes: `ARENA_DELIVERY.md` §15 and `LOCAL_IMAGE_SETUP.md`.

### Verified (fixture and code level only)

- `tests/local-image.test.ts`: 27 tests on the real server with a labelled stand-in runner
  (`tests/fixtures/fake-sd-cli.mjs`) and test model bytes with a computed pin.
- `tests/web/local-image-panel.test.tsx`: 9 tests (happy-dom, labelled client double).

### Not verified / blocked

- **Blocked:** running `sd-cli.exe` on the owner's PC. Not downloaded, not installed, not changed here.
- **Unverified:** flag names against the installed build; SD 1.5 weight hash; latency and RAM on the owner's CPU;
  image quality and licence fit for each use.
- **Browser:** not run (no Chromium in the sandbox; not downloaded).

### Owner decision and steps (exact)

1. Follow `LOCAL_IMAGE_SETUP.md` §1–§3 on `F:\`, record the weight hash, and accept the model licence.
2. Run `LOCAL_IMAGE_SETUP.md` §6. Only then is local generation proven on the owner's host.
3. Or supply your own stills or recordings for each shot. Those bind without any generation.

No other image provider or free route is authorized. The owner must not paste a key into chat or Git.

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

1. Set up local stills and the local planner per `LOCAL_IMAGE_SETUP.md` §1–§3 (outside Git, under `F:\`). Google is not needed for images or planning.
2. Open ContentPlan. Confirm "Local still images" shows Ready, or "Setup required" with the exact missing items. Generate one still, watch progress, try Cancel once, then approve and bind it.
3. Bind your own stills to the image shots. Confirm the shot list shows the type, source, licence, and status for each.
4. Apply. Confirm the Editor opens the canonical project and the final export is from the saved revision.
5. Listen to every narration line and every clip yourself. A provider success is not your acceptance.
6. Record your decision in `docs/execution/milestone-3/ARENA_DELIVERY.md`, not in chat.
