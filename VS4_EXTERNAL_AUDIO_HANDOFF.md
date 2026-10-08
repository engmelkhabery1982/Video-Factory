# VS4 — External narration import, exact-audio approval, duration-driven timing

The operator can generate an authorized cloned narration **outside this app** (for example on Kaggle), import the WAV, listen to those exact bytes, approve them, and have scene/caption timing follow the **measured** audio. A local NVIDIA GPU, a local Chatterbox install, and a model download are **not** required for this workflow. This phase did not run Chatterbox, did not download weights, and did not connect to Kaggle.

## Baseline and result

| | |
| --- | --- |
| Branch | `arena/c4cc1417-video-factory` (session branch; not merged to `main`) |
| Baseline (parent) | `9b33950fcca60adc6223ef4604b23a9e3863a773` — VS3, `feat(voice-audio): add the Voice & Audio workflow to the existing app` |
| This phase | one commit on top of that parent; final SHA is recorded in `REVIEW_HANDOFF.md` after the push, and re-read from the remote |

## What was reused, and what is new

There is still **one** narration upload system. Both the ordinary per-target upload and the external import go through `validateNarrationFileType`, `stageNarrationPart` and `acceptStagedNarration` in `apps/api/src/routes/target-audio.ts` (extension and MIME filter, the shared byte limit, real ffprobe decoding, a strictly positive measured duration, a collision-resistant name inside the managed `voiceover/` root, temp-file cleanup). Nothing second was built for storing publishable narration bytes.

| Concern | Where it lives |
| --- | --- |
| Publishable narration bytes | Existing managed `DATA_DIR/voiceover/<videoId>_<target>_<rand>.<ext>`, referenced by the existing `voiceoverFile` (Long) or `targetAudio.short_N` (a Short) |
| Declaration, approval, alignment metadata | Existing private `voice-audio/<videoId>/state.json` (`externalNarration` block). Not a second database |
| Per-turn dialogue clips | Existing `.production/<videoId>/audio/dialogue/` contract (`productionAudioBasePaths`). A combined track is never treated as verified per-speaker audio |
| Timing update | Existing `POST /api/projects/:id/storyboard`, which already times each target from its own narration |
| Export | Existing `POST /api/projects/:id/export` and `muxAndEncode`. The gate is consulted before that render starts |
| Project id safety | Existing `isSafeVideoId` |

New, because the product did not have these rules:

- `packages/core/src/scenario/external-narration.ts` — declaration, approval binding, timing coverage, honest alignment, per-turn dialogue coverage. Pure; no I/O.
- `apps/api/src/routes/external-narration.ts` — import, listen, approve/reject, timing review, dialogue-turn import.
- `apps/api/src/services/external-audio-gate.ts` — export gate. Projects with no import are `notApplicable` and keep the old flow.
- `apps/web/src/components/ExternalNarrationPanel.tsx` — the second source, mounted on the existing Captions page. `TargetAudioPanel` is unchanged (it still has no script textarea).

## UI entry point

Captions page (`apps/web/src/pages/Captions.tsx`), card **Narration from outside the app**, below the existing Target Audio and Voice & Audio panels.

The card states the two sources explicitly:

- **Generate inside the app** — the Voice & Audio panel above (Kokoro, or Chatterbox only when that engine is actually selected and provisioned).
- **Import from outside** — a file produced elsewhere. No local voice engine, no download, no provisioning.

A declaration is labelled as documentation, not a rights check. The Approve button stays disabled until "I listened to the whole file" is ticked.

## API

All under the existing project resource. No new server.

| Method | Path | Role |
| --- | --- | --- |
| POST | `/api/projects/:id/target-audio/:target/external` | Import one target's narration (multipart file + exact script + declaration) |
| GET | `/api/projects/:id/target-audio/:target/external` | Per-target record, readiness, timing review |
| GET | `/api/projects/:id/target-audio/:target/external/audio` | Listen to **this** project's imported bytes only |
| POST | `/api/projects/:id/target-audio/:target/external/approval` | Approve or reject. Approval requires `listened: true` |
| GET | `/api/projects/:id/external-narration` | Project-wide readiness |
| GET | `/api/projects/:id/external-narration/timing/:target` | Editable timing review, with honest labels |
| POST | `/api/projects/:id/external-narration/dialogue-turns` | One clip for one turn, through the existing dialogue root |
| GET | `/api/projects/:id/external-narration/dialogue` | Per-turn coverage. A combined track is not verified per speaker |

Final export remains `POST /api/projects/:id/export`. When an import exists and is not ready, the answer is `409` with `externalNarrationGate.findings` and `blockedCodes`. `blockReason` is only a summary. A project that imported nothing does not receive this gate.

The separate production-plan export (`POST /api/projects/:id/production/export`) synthesizes its own Kokoro dialogue and does **not** mux the imported narration. It is not this gate. That is stated in the gate comment so it is not mistaken for a second, ungated path for these bytes.

## Approval and invalidation

An approval is bound to the project, the target, the SHA-256 of the file bytes, the SHA-256 of the exact spoken script, the speaker identity, and the timing/alignment revision. It is stored only after the operator confirms they listened to the whole file.

Replacing the audio, changing the script, changing the speaker assignment, or changing the timing revision invalidates that approval. A new import deletes the previous approval of **that target only**. A rejected approval stays a block. An approval of another target, or of another project, never counts.

Three facts stay separate:

1. **User-declared authorization** — source kind (`own_recording` or `authorized_external_synthesis`) plus a confirmation statement. Typed by the operator.
2. **Documented source info** — engine, model and voice name, when known. Stored as documentation. An entered engine name is not a rights check and is not verification.
3. **Listening approval** — the only act that makes those exact bytes usable.

A Short never inherits the Long's audio. The existing resolver has no fallback, and the gate additionally refuses a Short whose stored reference is the Long file.

Private reference recordings stay in the voice-audio reference store. They are not written into the import record, not served by the imported-narration audio route, and not placed in a public URL, an export ZIP, a commit, or a log line by this phase.

## Exact timing method

| Fact | How it is known |
| --- | --- |
| File duration | **Measured.** `ffprobe` / `durationOf` on the decoded file. A non-audio payload is refused even if the extension is `.wav`. Duration must be > 0 |
| Per-scene alignment | **Aligned and verified** only when a sibling `<audio>.timing.json` has exactly one entry per scene, every duration > 0, and every entry's text equals that scene's narration word for word. Mode `exact_scene_timing`, `verified: true` |
| Otherwise | **Estimated, not verified.** Mode `estimated_from_script`, `verified: false`. The UI and the timing review say ESTIMATED. The finding `TIMING-ALIGNMENT-ESTIMATED` is a warning, never a claim of alignment |
| No timing file | `TIMING-ALIGNMENT-MISSING`, also a warning, also not called alignment |

No paid transcription API, no new model dependency, and no automatic download. If sentence or word alignment is not in the sidecar, this phase says so.

Coverage rule (core): the planned timeline must be at least the measured audio minus 0.05 s, or export is blocked (`TIMING-TIMELINE-SHORTER-THAN-AUDIO`). It may run past the audio by the silent end card (Long 8 s, each Short 0.3 s) plus 0.25 s. Further than that is a warning (`TIMING-TIMELINE-LONGER-THAN-AUDIO`), not a silent trim. The end card is extra silence after the last word; it is not made by cutting the narration.

Renderer (`muxAndEncode`):

- `-shortest` is removed. It used to stop at whichever stream ended first, which cut either the silent end card or the last words.
- Before encode, if `durationSec + 0.05 < measured audio`, the encode throws. The final words are not cut to fit an old plan.
- `durationSec` remains the only explicit `-t` cap, and it is only reached when the plan already covers the audio.
- If the narration ends before the picture, the video keeps its own length (the silent end card stays).

Accepted audio is never trimmed, accelerated, or sliced to fit old scene durations. The operator regenerates the storyboard (or edits scene durations) and reviews the result.

## Storage and safety

- Shared byte limit (`BUILDTRACK_MAX_AUDIO_UPLOAD_BYTES`, default 250 MB). Over the limit: 413, no project reference, no leftover temp file.
- Real decoding, not the extension.
- Safe project ids via `isSafeVideoId`. Dialogue clips must stay inside `.production/<id>/audio/dialogue`; an existing symlink on that path is a refusal.
- Serving a narration follows no symlink and no path that realpath-escapes the data root. Errors do not include filesystem paths or ffprobe's path-bearing stderr.
- A rejected declaration after the file has been staged deletes the temp file.
- Cross-project listening is 404. A traversal filename is not written outside the narration root.

## Tests

79 new tests, none skipped, none weakened:

| File | Tests |
| --- | --- |
| `tests/external-narration-core.test.ts` | 33 |
| `tests/external-narration-api.test.ts` | 31 |
| `tests/external-narration-ui.test.ts` | 11 |
| `tests/external-narration-render.test.ts` | 4 |

The size-limit API test originally set `BUILDTRAKE_MAX_AUDIO_UPLOAD_BYTES` (missing a C), so the product limit was never applied and the import returned 201. The test now sets `BUILDTRACK_MAX_AUDIO_UPLOAD_BYTES`, which is the variable the product reads, and also asserts that no partial file is left behind. That is a correction, not a weaker assertion.

| Check | Result |
| --- | --- |
| Focused 8 files (new suites + target-audio API/UI + export-targets + server-media-security) | 8 files, **121 passed** |
| VS1–VS3 / target-audio / timing / caption / export baseline (16 files) | 16 files, **350 passed** |
| Full suite | 91 files, **1504 passed**, 22 skipped, **1 failed** |
| Full suite excluding the pre-existing real-render file | 90 files, **1504 passed**, 13 skipped, **0 failed** |
| Typecheck core, web, API, scripts | clean |
| `npm run build` (core + web production) | clean. Built UI bundle contains the panel |
| `git diff --check` | clean |
| Count guard `node scripts/assert-test-count.mjs 300` | `ok - 1504 tests passed, at or above the floor of 300` (exit 0). The guard also printed `Tests failed: 1` — the same pre-existing phase6d real-render test. The guard checks the floor, not a zero-failure bar, so that failure is reported here and is not counted as passed. Its "Test files: 395" line is vitest's suite count (`numTotalTestSuites`), not the 91 files. |
| Doctor | see below |
| Bounded real-HTTP smoke | see below |

### The one failing test (reported, not hidden, not weakened)

`tests/phase6d-real-package.test.ts` — "rendered a real Long and Short through the approved renderer": `expected 'error' to be 'ok'`. Same pre-existing environmental failure reported in VS3. This phase did not edit that test or `plan-delivery.ts`. Chromium is not provisioned here (`chromePath()` throws). The 9 skipped assertions in that file are its own. It is not counted as passed.

## Bounded API smoke

Real HTTP against `buildServerApp`, data under git-ignored `.stills/test-isolation/vs4-smoke`. Fixture WAV only (24 kHz PCM sine, labelled TEST/FIXTURE). No Chatterbox marker was created. No file was written into the repository `data/` tree. No MP4 was produced.

| Step | Result |
| --- | --- |
| `GET /api/health` | 200 |
| Create + load `Video_Smoke4` | 200 / 200 |
| Import fixture WAV for `long` | 201, `durationSec=8` (measured), alignment `estimated_from_script`, `verified=false`, no filesystem path in the body |
| State before approval | 200, `ready=false` |
| Final export before approval | **409**, `IMPORT-APPROVAL-MISSING` |
| Regenerate storyboard from the imported audio | 200, `audioDuration=8` |
| Timing review | 200, `alignmentVerified=false`, 6 scenes, source `estimated` |
| Approve without listening | 400 |
| Approve after listening | 200, `ready=true`, approval bound to the artifact SHA-256 |
| Project readiness | `readyCount=1`, `blockedCount=0` |
| Listen | 200, `audio/wav`, byte length equal to the uploaded fixture |
| Final export after approval | 200, job accepted, **`externalNarrationGate` absent**. The server was then closed. No MP4 was written. This proves the gate let the job start; it does **not** prove a rendered video |

No browser was available in this sandbox, so there are no screenshots. UI behaviour is covered by the happy-dom component tests, not by a human click-through.

## Doctor

`npm run doctor` exit 1, after the production build:

- Node, ffmpeg, ffprobe, core library, web UI, data/projects, data/assets, output, libx264, AAC: ok.
- `data/voiceover`: warn, created on first upload (the smoke did create it inside the isolated data dir, not the repo `data/`).
- **Chatterbox: optional, not selected.** Kokoro stays the default. Nothing was downloaded. This is the honest optional-engine report. The import workflow does not need it.
- **Local Chromium and Chromium libraries: FAIL** (`run: npm run provision`). Rendering a real MP4 still needs that browser. This phase did not provision it and does not claim a rendered delivery.

## First real Kaggle WAV — steps this phase did not perform

1. On Kaggle (or any machine that is allowed to run the chosen engine), synthesize the **exact** spoken script to a WAV. This repository has no Kaggle connector and will not authenticate, download weights, or run that job.
2. Download the WAV to the operator PC. Do not commit it, and do not put a private reference recording in the same folder as a publishable narration.
3. Optional: if that external run produced real per-scene times, save `<same-name>.timing.json` next to the WAV with one entry per scene (`duration` > 0, `text` equal to the scene narration word for word). Without that file the app will say the scene times are estimates. Do not rename an estimate to alignment.
4. Open the project → Captions → **Narration from outside the app**.
5. Import for **one** target (Long, or a specific Short). Repeat separately for every target. A Short will not pick up the Long file.
6. Enter the exact spoken script, declare `own_recording` or `authorized_external_synthesis`, type the ownership statement, and enter engine/model/voice only as documentation.
7. Listen to the whole file in the player. Tick the listening confirmation. Approve.
8. Regenerate the storyboard so scenes and captions follow the measured duration. Review the timing panel. If it says estimated, it is not verified. Adjust scene durations if the timeline does not cover the audio. The silent end card may extend past the last word; it must not be created by cutting the last word.
9. Export from the existing project export. The gate blocks until the approval matches the current bytes, script, speaker and timing revision, and until the timeline covers the audio.

## Remaining acceptance work

- No real Kaggle WAV was imported. No Kaggle account, token, or notebook was used.
- No real Chatterbox (or other) inference was run. No weights, no GPU, no watermark check, no audio-quality claim.
- No local MP4 of an approved import was produced. Chromium is not provisioned; the smoke stopped at gate acceptance.
- No browser screenshots.
- Word/sentence alignment is not computed in-app. A matching sidecar is the only verified alignment this phase will claim.
- The production-plan (Kokoro) export is a different pipeline and is not a substitute for this import.

## Not done, on purpose

No Chatterbox weights, no cloning run, no Kaggle auth, no GitHub acceptance-workflow edits, no run-once marker edits, no lip-sync, no photorealistic-person generation, no paid transcription, no new heavyweight model, no second upload system, no second approval database.
