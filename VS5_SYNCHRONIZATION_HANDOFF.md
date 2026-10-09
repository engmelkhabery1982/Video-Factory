# VS5 — Audio, caption and scene synchronization review

The operator can review one target's caption and scene times against the exact imported narration, correct those times, save them, and approve that revision. Export stays blocked while the timing approval is missing, stale or invalid.

This is not a new synthesis engine, not automatic lip-sync, and not acoustic alignment. No real Slima recording was imported. No speech was generated. No video was rendered.

## Baseline and result

| | |
| --- | --- |
| Repository | `engmelkhabery1982/Video-Factory` |
| Branch | `arena/c4cc1417-video-factory` (session branch; not merged to `main`) |
| Required baseline | `653bf35bbd27094497a3ef2c50997819e44fe618` — post-VS4 non-render CI, parent of this phase |
| This phase | `8d3f16ccb7980bba723eb9f771686afffe16b54b` |
| Parent | `653bf35bbd27094497a3ef2c50997819e44fe618` |
| Remote at verification of the phase commit | `git ls-remote` returned `8d3f16ccb7980bba723eb9f771686afffe16b54b` |

This handoff is documentation. If it is committed after `8d3f16c`, that later commit does not change the timing review. The green run below is the phase commit, not this file.

## What already worked, and what was missing

Already present, and reused:

- One narration upload path, one private `voice-audio/<id>/state.json`, and one storyboard. Long captions live in `storyboard.captions`. Short captions live in `storyboard.shortCaptions`. A Short does not read the Long cues.
- Import, listen, and audio approval bound to the artifact digest, spoken-script digest and speaker.
- A read-only timing review that listed scene starts and labelled estimates honestly.
- The export gate on `POST /api/projects/:id/export`. Projects with no import stay `notApplicable`.
- The existing audio player on the Captions page.

The gap: the review could not edit caption or scene times, could not save a correction, and had no timing approval separate from the listening approval. Changing the timeline also made the listening approval look stale. A matching `.timing.json` was described as alignment even though nobody had listened to the sync.

No second VS5 plan was defined in the repository. This phase follows the requested review workflow rather than replacing an established one.

## What changed

| File | Role |
| --- | --- |
| `packages/core/src/scenario/external-timing-review.ts` | Speech-timing revision, validation, timing-approval evaluation, honest labels. Pure. |
| `packages/core/src/scenario/external-narration.ts` | New finding codes. Readiness can carry the timing-approval findings. Older callers that omit them keep the previous result. |
| `apps/api/src/routes/external-narration.ts` | Validate, save and approve timing. The review reads and writes the storyboard. |
| `apps/api/src/services/voice-audio-state.ts` | `timingApprovals` beside the existing listening approvals. Old state files still load. |
| `apps/api/src/routes/projects.ts` | A presentation-only scene edit no longer rewrites start times. A duration edit still retimes. |
| `apps/web/src/components/ExternalTimingReview.tsx` | The editor inside the existing panel. |
| `apps/web/src/components/ExternalNarrationPanel.tsx` | Same card, same player. Review timing opens the editor. |
| `apps/web/src/lib/api.ts` | Validate, save and approve-timing calls. |
| `tests/external-timing-review.test.ts` | Pure contract. |
| `tests/external-timing-review-api.test.ts` | API and the fixture smoke. |
| `tests/external-timing-review-ui.test.ts` | Real panel controls under happy-dom. |
| `tests/external-narration-api.test.ts` | Export readiness now requires the timing approval. Assertions were moved, not dropped: audio approval is still bound to the bytes, and a timing change still blocks export. |
| `tests/external-narration-ui.test.ts` | The structural-match tag is no longer "Aligned timing". |

## UI entry point

Captions page, card **Narration from outside the app**, button **Review timing**.

That review is the only timing editor for an imported target. It shows the selected target, the measured duration, the player, the playback position, caption start/end, scene start/duration, the timing source, the review status, Check, Save and Approve this timing. Caption and scene text are shown and are not editable here, so a timing save cannot delete words.

The legacy caption nudge still writes the same storyboard cues. It is not a second store. A duration change there changes the speech revision, so the timing approval becomes stale and export is blocked until the review is approved again.

## API

| Method | Path | Role |
| --- | --- | --- |
| GET | `/api/projects/:id/external-narration/timing/:target` | Review: scenes, captions, source, review status, measured duration. |
| POST | `/api/projects/:id/external-narration/timing/:target/validate` | Check a proposal. Writes nothing. |
| PUT | `/api/projects/:id/external-narration/timing/:target` | Save a valid proposal onto the storyboard. Rejects an invalid one and leaves the saved times unchanged. |
| POST | `/api/projects/:id/external-narration/timing/:target/approval` | Approve or reject this revision. Requires `reviewed: true` to approve. |

Final export remains `POST /api/projects/:id/export`. A target with an import is not ready until the listening approval and the timing approval both match the current audio, script and speech times, and the spoken scenes cover the measured audio.

## Timing-source labels

`acousticVerification` is always `false`. Nothing in this phase heard the audio.

| State | Label | Meaning |
| --- | --- | --- |
| Estimated | Estimated timing | Durations were distributed from the script and the measured total. Not word-accurate alignment. |
| Imported structural match | Script-matched timing | A sibling `.timing.json` matches every scene word for word. That proves script consistency. It is not a listening check and not acoustic verification. The existing `alignment.verified` flag still means this structural match, so older callers keep that fact. The UI does not call it aligned-by-listening. |
| Manually approved | Timing approved | The operator reviewed these times against this audio and approved this revision. |
| Stale or invalid | Timing stale / Timing invalid | The approval does not match the current audio, script or times, or the times break a rule. |

## Approval semantics

Two approvals, one state file:

- **Listening approval** (VS4): project, target, artifact SHA-256, spoken-script SHA-256, speaker, and the fact that the file was listened to. A timing-only edit does not revoke it and does not revoke the ownership statement.
- **Timing approval** (VS5): project, target, artifact SHA-256, spoken-script SHA-256, and the speech-timing revision. The revision hashes scene id/start/duration/narration and caption id/start/end/text. It does not hash variant, background, assets or layout.

Replacing the audio or the spoken script deletes that target's listening approval and timing approval. Another target is left alone.

Changing caption or scene times makes the timing approval stale and blocks export. It does not clear the listening approval.

A scene presentation change that does not change speech times does not invalidate either approval.

A Short cannot submit the Long's scene or caption ids. Saving Short timing does not change the Long storyboard.

## Validation

Rejected, and not written:

- Non-finite, negative, reversed or missing times.
- Times past the silent end-card allowance (Long 8s, each Short 0.3s, plus 0.25s).
- Caption overlap. Touching boundaries are allowed.
- Scene gaps or overlaps. Scenes must tile from 0.
- A missing scene or caption, or an id from another target.
- A narration or caption text change. The spoken words stay.
- Spoken scenes that end before the measured audio. An end card may follow the last word. It must not be created by cutting the last word.

The save path does not trim, stretch or replace the audio. The fixture smoke compared the file SHA-256 before and after a save; it was unchanged.

## Tests and smoke

Local non-render suite, `BUILDTRACK_CI_LANE=non-render`: 392 files, 1532 passed, 0 failed, 5 skipped. The three Chromium render files were absent. This is a local count, not a number read from the GitHub log.

Strict typecheck: `packages/core`, `apps/web`, `apps/api`, `scripts` — pass.

`npm run build:core` and `npm run build:web` — pass. The existing Vite duplicate-key warning in `packages/video/src/scenes/Explanations.tsx` was not touched.

`BUILDTRACK_CI_LANE=non-render node scripts/assert-test-count.mjs` — `ok - 1532 tests passed, at or above the floor of 300`.

`git diff --check` — clean.

TEST/FIXTURE smoke, real HTTP, in-process WAV, not a real voice:

import fixture → audio approval does not make the target ready → export 409 `TIMING-APPROVAL-MISSING` → edit a caption end → save → reload shows the same end and the same words → approve timing → ready → replace the audio → listening and timing approvals of that target are gone → export blocked. The fixture file hash was unchanged by the timing save.

No browser was available in this environment (`google-chrome`, `chromium` and `chromium-browser` were absent). The UI tests drive the real panel under happy-dom. That is not browser acceptance and no screenshots were captured.

## Non-render CI

[Run 37862917401](https://github.com/engmelkhabery1982/Video-Factory/actions/runs/37862917401)

| | |
| --- | --- |
| Event | `push` |
| Workflow | CI |
| Head SHA | `8d3f16ccb7980bba723eb9f771686afffe16b54b` |
| Conclusion | `success` |
| Created | 2026-10-09T00:05:03Z |
| Updated | 2026-10-09T00:14:10Z |

The Jobs API reported every step successful, including Python 3.11, both typechecks, the test suite, the production build and the test-count guard. The raw job log was not read. This result is the non-render lane. Render checks was not dispatched. It is not a production-render pass.

## Not done

- No real Slima audio, no speech generation, no model download, no MP4.
- Voice cloning is not validated. The application is not production-ready. Final acceptance did not pass.
- VS6 and VS7 were not started.
- Word-accurate alignment is not computed. A matching timing file is structural only.
- happy-dom is not a real-browser pass.
