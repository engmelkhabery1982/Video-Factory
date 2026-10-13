# Milestone 3 — closure report for the workflow work order

**Status: NOT COMPLETE.** The factory is not declared complete. Everything below is either
implemented and verified by tests in this repository, verified by a labelled provider double or
fixture media, blocked by a named gate, or genuinely missing. Fixture evidence is never presented
as owner acceptance, live-provider evidence, listening review, or browser acceptance.

Evidence labels: **code-checked** (typecheck, build, unit test), **route-tested** (real registered
Fastify server through `app.inject`, no real network), **DOM-checked** (happy-dom component test,
not browser acceptance), **fixture** (synthetic media or labelled provider double), **blocked** (a
gate this sandbox cannot run), **open** (not built).

Base for this continuation: `4d2723c` (the remote branch head at the start of this continuation, which holds the previous checkpoint). Branch: `arena/890ccb82-video-factory`.

## 1. Implemented in this continuation

### 1.1 Exact spend confirmation (work order item 1)

| Requirement | State | Evidence |
|---|---|---|
| Creating, editing, deriving or reviewing a derivative does not spend | implemented, verified | `tests/factory-spend-speakers.test.ts` (derive and review leave the provider call count unchanged; the source draft file's hash is unchanged after derive) |
| Apply shows the exact additional call count before confirmation | implemented (existing), verified | `GET .../apply-preview` returns `speechCalls` and `sceneIds`; web apply panel shows the count (`tests/web/gemini-plan-flow.test.tsx`) |
| Count is rechecked server-side before spending | implemented (existing), verified | `applyLocked` recounts; a mismatched `confirmSpeechCalls` returns 422 with 0 provider calls (`factory-spend-speakers`, `factory-gemini-flow`) |
| Budget refusal before any call | implemented (existing), verified | `factory-gemini-flow` (429 `FACTORY_BUDGET_EXHAUSTED`, no call) |
| Unchanged clips and existing budget records preserved | implemented, verified | byte-for-byte comparison of the other speaker's clips after a style change and after a derived apply (`factory-spend-speakers`) |
| A derivative's new count is exact | implemented, verified | derived preview counts only the changed line (`speechCalls` 1), after a style change had already counted separately |

Correction to the previous checkpoint: that report said `confirmSpeechCalls` was not wired. It was
wired already (web client, API, and flow tests). The checkpoint was wrong on this point.

Limit: the derivative's additional count is shown by the Apply panel once the derivative is open.
The derive panel itself does not display a count.

### 1.2 Missing assets, binding and shot list (work order item 2)

One binding rule now decides Apply gating, the missing list, and the shot list
(`bindingOf` in `apps/api/src/services/factory-service.ts`). Statuses:

| Status | Meaning | Apply |
|---|---|---|
| `bound` | assigned, active, sourced and licensed, correct media type, bytes unchanged since binding | allowed |
| `missing` | nothing assigned (still need: kind `image`; recording need: kind `recording`) | refused before spend |
| `blocked` | assigned asset is inactive, blocked, unlicensed, or its file is missing | refused before spend |
| `changed` | assigned file's bytes differ from the hash recorded at binding | refused before spend |
| `incompatible` | a still bound to a screen-recording need, or a non-visual asset | refused before spend |

- Hashes are recorded per draft (`assetHashes`), keyed by asset id, not in the scene rows. Locked
  rows keep their bytes. An asset no scene references is dropped from the map, so unbinding,
  saving, and binding again records the current file.
- A re-apply of the same revision after a source changed returns 409 `FACTORY_SOURCE_CHANGED`
  (existing `reusableApply` check, verified).
- A bound asset that is no longer eligible keeps the established code `FACTORY_ASSET_INVALID`
  (verified by an existing test that an earlier change had broken).
- The shot list (JSON and Markdown, same data) reports per shot: status, reason, media type,
  source, licence, bound asset id, and a still prompt or a screen-recording brief. A prompt is
  never reported as media.
- No generic card is substituted: an unbound scene is missing and blocks Apply.
- The web shot-list panel shows the server's status, media type, source, licence, and reason, and
  no longer derives media from a library lookup.

Evidence: `tests/factory-binding.test.ts` (7, route-tested, fixture media),
`tests/web/shot-list-panel.test.tsx` (3, DOM-checked), `tests/factory-gemini-flow.test.ts` and
`tests/factory-turn-cache.test.ts` (updated: a still is no longer accepted for the recording need;
they bind a labelled fixture video instead).

Limits, stated plainly:
- Fixture videos are checked by type, licence, duration, and hash. They are not decoded.
- A draft bound before this change has no recorded hash until its first save after this change.
  A file changed before that save is not detected.
- No storyboard importer (out of scope). No image or video generation (out of scope).

### 1.3 Speaker turns and delivery (work order item 3)

The existing per-turn pipeline was extended in place. No second pipeline was added.

- Voice identity (`voiceId`) and delivery style (`style`) are separate fields on each speaker.
  The style travels only in `speechMetadata` on the part; the narration text is verbatim.
- Two speakers use separate unary turns, each with its own voice and style.
- Changing one speaker's style or voice invalidates only that speaker's clips. The other
  speaker's clips are unchanged byte for byte.
- Saved speakers and speaker assignments survive a server restart (test: "the saved speakers and
  speaker assignments survive a server restart").

Evidence: `tests/factory-spend-speakers.test.ts` (route-tested, labelled provider double).

Compatibility: the existing field name `style` is kept. The voice list is still the single
`GEMINI_PREBUILT_VOICES` constant in core.

### 1.4 Product-mention rules (work order item 4)

| Rule | Evidence | Label |
|---|---|---|
| Educational default OFF; request tells the model no mention is requested; plan records it disabled | `tests/factory-product-mention.test.ts` | route-tested, provider double |
| Explicit request with no supplied fact refused before any call | same file (test: "an explicit request with no supplied fact is refused before any provider call") | route-tested (0 calls) |
| Religious content refuses a mention before any call | same file (test: "religious content refuses a product mention before any provider call") | route-tested (0 calls) |
| An enabled mention must use the supplied fact's text exactly, with no added wording or claims | `packages/core/src/factory/gemini-contract.ts`; `tests/gemini-contract.test.ts` (new test) | code-checked |
| Only the owner's supplied facts are sent in the request | same file (asserts no unrelated data or private paths) | route-tested |
| Religious draft never takes the BuildTrack identity | same file: a religious draft asking for `buildtrack` gets `channelBrandId` null and a 422 `FACTORY_IDENTITY_REFUSED` | route-tested |

Limits:
- **Open:** an enabled product mention is recorded on the plan, but no code path inserts it into the
  draft or the video. The owner can see it in the plan result, and it does not appear in the
  narration. Insertion as a reviewed, owner-approved line is not built.
- Invented wording is rejected by the validator (code-checked in `tests/gemini-contract.test.ts`).
  No live model output was tested.
- The request carries the owner-supplied facts that were given for this plan. The model is told to
  cite only the one it uses.

### 1.5 Earlier items closed in this continuation
- `gemini-contract.ts` header now names `speechMetadata.style` (previously `speech_metadata`).
- Derived rewrite, caption language, transcript provenance, sidecar binding, and the video-with-narration
  HTTP path were built in the previous checkpoint (`4d2723c`) and are recorded in `ARENA_DELIVERY.md`.

## 2. Verification run (final, after the last code change)

| Command | Result |
|---|---|
| `npm run build:core` | exit 0 |
| `npm run build:web` | exit 0 |
| `tsc --noEmit -p packages/core/tsconfig.json` | exit 0 |
| `tsc --noEmit -p apps/api/tsconfig.json` | exit 0 |
| `tsc --noEmit -p apps/web/tsconfig.json` | exit 0 |
| `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tools/alignment-run -p test_ctc_greedy.py` | exit 0 (8 test functions in `test_ctc_greedy.py`) |
| `npx vitest run` over 43 targeted files (alignment, transcript, caption language, editor, factory, derive, binding, spend and speakers, product mention, video narration, Gemini contract/provider/routes, sync, external narration, targets binding, and web ContentPlan, derive panel, caption language, sync, plan flow, client contract, shot list) | exit 0; **43 files passed; 685 tests passed, 1 skipped** |

One test is skipped by its own guard (environment-dependent). It is not counted as evidence.

Changed files in this continuation (11 modified, 4 new tests):
`apps/api/src/services/factory-service.ts`, `apps/api/src/services/gemini-service.ts`,
`apps/web/src/components/plan/GeneratedDraftPanels.tsx`, `apps/web/src/lib/factory-api.ts`,
`apps/web/src/pages/ContentPlan.tsx`, `packages/core/src/factory/contract.ts`,
`packages/core/src/factory/gemini-contract.ts`, `tests/factory-gemini-flow.test.ts`,
`tests/factory-turn-cache.test.ts`, `tests/gemini-contract.test.ts`, `tests/web/gemini-plan-flow.test.tsx`;
new: `tests/factory-binding.test.ts`, `tests/factory-spend-speakers.test.ts`,
`tests/factory-product-mention.test.ts`, `tests/web/shot-list-panel.test.tsx`.

No `data/`, `output/`, saved timings, recordings, models, or dependencies are in Git. No manifest or
lockfile changed in this continuation. Test assets are written under the test isolation roots.

## 3. Partial-apply, restart and concurrent duplicates (work order item 5)

Existing tests cover these and still pass unchanged in behaviour:
- `tests/factory-turn-cache.test.ts`: a forced failure after the first validated turn spends once and
  keeps the saved turn; a simulated restart keeps the turn and the ledger; a 401 during retry counts
  as an attempt and keeps the saved turn; the retry calls only the missing turns; concurrent duplicate
  applies produce exactly one project and make no provider call.
- `tests/factory-binding.test.ts` adds: a changed bound file after a successful apply refuses the
  re-apply (409, no call).

Not proven: the concurrent duplicate case across separate OS processes. The test runs two
`Promise.all` applies in one process.

## 4. Six-input capability matrix (Phase 3)

| # | Input path | Reaches the same editable draft and export? | Evidence label | Missing requirement or blocker |
|---|---|---|---|---|
| 1 | Brief only | No. Planner reports missing script and speech; no silent success | fixture (planning tests) | Needs a script and a speech engine |
| 2 | Supplied script | Partial. Draft is built; speech needs an engine | fixture | No Arabic speech engine; the local English engine is robotic; Kokoro and Chatterbox are unavailable without provisioning |
| 3 | Supplied script and supplied audio, with storyboard times | Yes, for fixture audio | fixture (`factory-api`, `external-narration-api`) | Owner recording not run through real alignment |
| 4 | Supplied images, with brief or script | Yes, with binding rules above | route-tested (`factory-binding`, fixture media) | Owner pictures not tested |
| 5 | Supplied storyboard, standalone | **Not evidenced** | open | No standalone storyboard evidence |
| 6 | Supplied screen recording, with narration | Yes, for synthetic fixtures | HTTP-only (`factory-video-narration`), plus binding with a fixture video | Boundary-frame inspection blocked (no ffmpeg); owner recording not tested |

## 5. Blocked gates (not run, not claimed)

- **Browser acceptance:** no Chromium in this sandbox. Every "DOM-checked" result above is a
  happy-dom component check, not browser acceptance.
- **Render, frames, and boundary frames:** no ffmpeg or ffprobe. Caption and highlight boundary
  frames have not been inspected.
- **Windows verification script (`tools/gemini-verify.mjs`):** the preflight from an earlier continuation made no calls.
  The model-name mismatch it reported was fixed, and the re-run is still pending. The live path was not run.
- **Live Gemini:** no call was made. No key was used or requested. Structured-output acceptance
  (`responseFormat.text`, `APPLICATION_JSON`) is unproven against Google. The text budget is two
  generations per session, and the production budget is not touched by tests.
- **Real alignment runner:** numpy and fairseq2 are not installed, so `create_decoder` is unverified.
- **Owner host and listening review:** not run. Owner acceptance: not given.

## 6. Genuinely missing (do not treat as done)

- Enabled product mention is not inserted into the draft or the video (section 1.4).
- Storyboard standalone evidence (six-input row 5).
- Boundary-frame inspection (blocked by ffmpeg, but also not yet designed as a check).
- Legacy drafts have no recorded hash until their first save after this change (section 1.2).
- Arabic speech: no engine and no live Arabic evidence.
- The owner's extended voice catalog and local delivery-style selection are not in this repository.
- Derive panel does not display the additional count (the Apply panel does).

## 7. Integration overlaps with the owner's unpushed local fixes (`de545d0fe69e9d3047c0e052323c74488cffdddb`)

Status: **`de545d0` is not in this sandbox clone** (`git cat-file` fails). Nothing here is verified
against that commit, and nothing claims `de545d0` is on origin. The owner's Windows checkout was not touched.

| Owner fix (as described) | Overlap in this continuation | Action during integration |
|---|---|---|
| Gemini 3.8 REST corrections | `apps/api/src/services/gemini-service.ts` (product-fact text added to the validation context, one line) and `packages/core/src/factory/gemini-contract.ts` (product-mention prompt wording and a new validation rule) | Keep the owner's REST corrections; re-apply the two small product-mention changes on top |
| Extended voice catalog and delivery-style selection | Speaker `style` and `voiceId` are used by the new tests (`Kore`, `Puck`). The voice list constant is unchanged | Keep the owner's catalog. Keep `style` as the delivery-style field, or map it, and rerun `tests/factory-spend-speakers.test.ts` |
| Still-image pan overscan | Not touched | None expected |
| Explicit channel-logo visibility | Not touched | None expected |

## 8. Owner verify steps

See `docs/execution/milestone-3/LOCAL_VERIFY_STEPS.txt`, section N (updated). Nothing in these steps
needs a live key, a recording upload, or a paid call.
