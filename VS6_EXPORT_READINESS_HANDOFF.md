# VS6 — Integrated audio readiness and safe export preparation

The review and the export page now show the same server readiness for each target. A final export reloads the current audio and rejects the request when that readiness fails, even if the button is bypassed.

Ready to attempt export is not publication approval. This phase did not render a video, generate speech, or import a real recording.

## Baseline and result

| | |
| --- | --- |
| Repository | `engmelkhabery1982/Video-Factory` |
| Branch | `arena/c4cc1417-video-factory` (session branch; not merged to `main`) |
| Required starting SHA | `fbfad3a4e2f0f90a4440af48c3728788127db408` |
| This phase | `5daf59b99dd1e7d45f008d38128e1b7d80950590` |
| Parent | `fbfad3a4e2f0f90a4440af48c3728788127db408` |
| Remote at verification of the phase commit | `git ls-remote` returned `5daf59b99dd1e7d45f008d38128e1b7d80950590` |

The sync gate found no earlier VS6 scope in the repository. The only prior note was that VS6 had not been started. This phase follows the requested readiness workflow rather than replacing an established one.

This handoff is documentation. If it is committed after `5daf59b`, that later commit does not change the readiness check. The green run below is the phase commit, not this file.

## What already worked, and what was missing

Already present, and reused:

- One import path, one `voice-audio/<id>/state.json`, and one storyboard. Long and each Short keep their own file. A Short does not fall back to the Long file.
- Listening approval bound to the artifact SHA-256, the spoken-script SHA-256 and the speaker. Timing approval bound to those digests plus the speech-timing revision.
- `evaluateExternalNarrationReadiness` and the final-export gate on `POST /api/projects/:id/export`. A project with no import stays `notApplicable`.
- The Captions page player, the timing editor, and the Export page back button.
- `muxAndEncode` already refuses to trim the narration with `-shortest`. That flag was not put back.

The gap: the review said "Ready" or "Blocked" without a compact account of which file would be used, whether listening and consent were current, how timing was classified, or whether the scenes covered the measured audio. The export page did not show that check at all. "Ready" could be read as publication approval. A Short that merely pointed at the Long file was not rejected by this gate before the job. A long-only request was also blocked by an unreviewed Short that the request would not render.

## What changed

| File | Role |
| --- | --- |
| `apps/api/src/routes/external-narration.ts` | Projects the existing evaluation into one readiness summary. No second check. |
| `apps/api/src/services/external-audio-gate.ts` | Final export uses that summary for the targets the request will render. A shared Long/Short file is rejected even without an import record. |
| `apps/api/src/routes/projects.ts` | Passes the same target list `planTargets` renders. The 409 body includes the readiness summary. A QC override does not bypass it. |
| `packages/core/src/targets.ts` | `exportTargetIds` is the shared list. Behaviour of an omitted `includeShorts` is unchanged: every Short is included. |
| `apps/web/src/components/ExternalNarrationPanel.tsx` | The existing card displays the server lines. It does not decide them. |
| `apps/web/src/pages/Export.tsx` | The ordinary export entry shows the same lines and will not start a final export when the fresh server read says blocked. |
| `apps/api/src/routes/production.ts` | Comment only. This route is not the imported-narration gate. |
| `tests/external-narration-api.test.ts` | Fixture HTTP coverage of the gate. No MP4. |
| `tests/external-narration-ui.test.ts` | The panel renders the server strings. |
| `tests/external-readiness-ui.test.ts` | The export page uses those strings and does not call export while blocked. |

## Navigation

Captions page, card **Narration from outside the app**. The existing buttons remain: Approve this exact audio, Review timing, Replace import.

Export page, card **Imported narration readiness**. **Open narration review** uses the existing back control to Captions. It does not clear saved approvals or saved timing. An unsaved timing draft is not a second store and is not kept in the browser after leaving the page. Returning reloads the saved server state.

## Readiness states

The summary is built from the evaluation the gate already runs. `publicationApproved` is always `false`.

| Line | Passing state | What it is not |
| --- | --- | --- |
| Audio source | Imported narration for this target, with the file name and measured duration | Not another target's file, and not a voice generated inside the app |
| Listening approval | Listening approved for these exact bytes | Not acoustic verification of the captions |
| Rights and consent | A statement is on record | Not a legal clearance, and not publication approval |
| Timing | Estimated, script-matched, or manually approved, plus the approval state | Estimated is not acoustic alignment. A script match is not heard-word sync. Manual approval is not acoustic verification |
| Scene coverage | Spoken scenes cover the measured audio | Not a listening check. A caption gap inside the audio is not forbidden |
| Export attempt | Ready to attempt export | Not a completed render |
| Publication | Not publication approved | A later render would still not be a rights clearance |

A target with no outside import says the outside-import checks do not apply. It does not inherit another target's audio. An ordinary upload remains the ordinary path.

## Invalidation

Unchanged contracts, now visible on the summary:

- Replacing one target's audio clears that target's listening approval and timing approval. Another target is left alone.
- Changing the spoken script cannot keep the old approval.
- A timing-only edit keeps the listening approval and the consent statement, and requires timing approval again.
- A Short cannot inherit the Long file or the Long approval.
- A storyboard whose spoken scenes end before the measured audio blocks export. The audio is not trimmed to the old duration.
- A missing or tampered file fails with a message that does not include a filesystem path.
- Two reads of an unchanged project return the same summary. A change after the first read is seen by the export gate, which reloads the project and the bytes. It does not reuse the earlier response.

## Server export checks

Applicable entry point: `POST /api/projects/:id/export` with `kind: 'final'`.

The handler reloads the project and the audio, then rejects when any requested target has an import that is missing, unreadable, or not the approved bytes; when listening approval or the rights/consent statement is missing or stale; when required timing is missing, invalid, or unapproved; when spoken scenes do not cover the measured audio; or when the request names a target this project does not have. A Short whose file pointer is the Long file is rejected when that Short is in the request.

`includeShorts: false` asks only for the Long. An unreviewed Short is not rendered and does not block that request. Omitting the flag still means every target, which is what the Export page sends.

Not this gate:

- Preview. The page says a preview does not run this check and is not an export attempt. It was already ungated. Newly blocking it would have changed a different workflow.
- `POST /api/projects/:id/production/export` and the production preview. They synthesize Kokoro dialogue and do not mux the imported file. The page says so. Applying this gate there would block a path that does not use the file.
- A QC override. It is recorded for QC only.

`-shortest` was audited and left absent.

## Tests and CI

Local non-render suite, `BUILDTRACK_CI_LANE=non-render`: 1540 passed, 0 failed, 5 skipped. This is a local JSON-reporter count, not a number read from the GitHub log. The count guard printed `ok - 1540 tests passed, at or above the floor of 300` and `Test files: 395`. As in the VS4 note, that "Test files" line is vitest's suite count, not the number of `*.test.ts` files. Three Chromium render files remain in the render lane and were not run.

Strict typecheck: `packages/core`, `apps/web`, `apps/api`, `scripts` — pass.

`npm run build:core` and `npm run build:web` — pass. The existing Vite duplicate-key warning in `packages/video/src/scenes/Explanations.tsx` was not touched.

`git diff --check` — clean.

Fixture HTTP smoke, no MP4: a valid external narration reaches export-attempt readiness and the gate allows it, without starting a render. Missing listening approval, missing rights/consent, stale timing approval, a changed script, a tampered file, a missing file, a short storyboard, a Short pointing at the Long file, and a named target the project does not have each block. Replacing Long audio leaves the Short approval in place. A direct `POST /export` is rejected when the check fails. A production export of an unapproved import is not rejected by this gate.

UI coverage is happy-dom, not a browser. The panel and the export page display the server strings, including "Not publication approved", and the export page does not call export while the projection is blocked.

Non-render CI: [run 37871100379](https://github.com/engmelkhabery1982/Video-Factory/actions/runs/37871100379) success on `5daf59b99dd1e7d45f008d38128e1b7d80950590`, created 2026-10-09T01:42:48Z, updated 2026-10-09T01:48:26Z. The Jobs API reported every step successful, including Python 3.11, both typechecks, the test suite, the production build and the test-count guard. The raw job log was not read. Render checks were not dispatched. This is not a production-render pass.

## Real versus simulated

| Check | Evidence |
| --- | --- |
| Readiness projection and export rejection | Deterministic in-process WAV fixtures and the registered API. Not a real voice. |
| UI | happy-dom operating the real panel and export page. Not a browser. |
| Render, speech, Slima, models | Not run. |

## Limitations

- Not production-ready. Not Slima-tested. Voice cloning is not verified.
- Estimated timing, a matching `.timing.json`, and a manual timing approval are not acoustic verification.
- A rights statement is not commercial-rights clearance. A passing readiness check is not publication approval. A render, if one is made later, is still not either of those.
- Preview does not run this check.
- The Kokoro production export does not use the imported file.
- No browser was available. No real recording was imported. No speech was generated. No model was downloaded. No MP4 was produced.
- VS7 was not started.

## Prerequisites for the single post-VS7 acceptance

One combined test after VS7, not before:

1. The real Slima recording, imported through the existing outside-narration path. No Kaggle, Chatterbox, or other provider substituted.
2. A person listens to that exact file and records the listening approval and a real rights/consent statement.
3. Caption and scene times are reviewed against that audio and the timing approval is recorded. That review is still not acoustic verification unless a later phase actually performs one.
4. The readiness summary shows ready to attempt export, and still shows not publication approved.
5. A final export of the reviewed target is then attempted. Publication approval remains a separate decision.
6. Browser acceptance of the review and export pages, and a real render, belong to that same combined test. They were not done here.
