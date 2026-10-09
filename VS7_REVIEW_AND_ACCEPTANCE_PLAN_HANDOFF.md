# VS7 — Review stays current, and the later acceptance is planned

The Captions review now reloads after a caption edit, says what a listening approval is not, and keeps the server readiness card ahead of the actions. A caption wording change stales timing approval only. The later outside-narration acceptance is a manual planner. It was not run.

This phase did not import a real recording, generate speech, or render a video. Ready to attempt export is not publication approval.

## Baseline and result

| | |
| --- | --- |
| Repository | `engmelkhabery1982/Video-Factory` |
| Branch | `arena/c4cc1417-video-factory` (session branch; not merged to `main`) |
| Required starting SHA | `fa2377928137dccafcbc98a92a4fa95d649e3bf7` |
| Behavior SHA | `0733f26a7ca5bb775db5765f74703a4d5c4e3eff` |
| Parent | `fa2377928137dccafcbc98a92a4fa95d649e3bf7` |
| Remote at verification of the behavior commit | `git ls-remote` returned `0733f26a7ca5bb775db5765f74703a4d5c4e3eff` |

This handoff is documentation. A later docs commit does not change the review or the planner. The green run below is the behavior commit, not this file. The copy-paste command uses the remote tip after the docs push, which still contains `0733f26`. History was not amended to make those SHAs identical.

## What already worked, and what was missing

Already present, and reused:

- One import path, one `voice-audio/<id>/state.json`, and one storyboard. Listening approval stays bound to the exact bytes. Timing approval stays bound to the speech-timing revision, which already includes caption text.
- The Captions page player, the timing editor, and the export gate on `POST /api/projects/:id/export`.
- `GET /api/projects/:id/external-narration` already returns `import.sha256`.
- A rejected timing save already leaves the previous approval unchanged.

The gap: a caption save on the same page did not reload the narration card, so a stale listening checkbox or an old readiness line could remain on screen. The card did not say, in one place, the order of the existing steps. A listening approval could still be read as timing approval or publication approval. There was no non-rendering plan for the single later acceptance of a 20–30 second recording kept outside the repository.

## What changed

| File | Role |
| --- | --- |
| `apps/web/src/components/ExternalNarrationPanel.tsx` | Reloads when `refreshToken` changes. Clears the listen checkbox when the import id changes or the file no longer matches the approval. A failed import reloads, then keeps the import error. The readiness card sits above the actions. The existing order is stated. Listening approval is labelled as not timing approval and not publication approval. |
| `apps/web/src/components/ExternalTimingReview.tsx` | The heading names the target. A server issue shows its code. A failed save still asks the panel to reload. |
| `apps/web/src/pages/Captions.tsx` | A wording save or a timing nudge bumps `refreshToken`. The cue note says a wording or timing change does not revoke listening approval and does require timing approval again. Production projects still do not show this editor. |
| `apps/web/src/pages/Export.tsx` | A finished export toast says it is not publication approval. |
| `scripts/external-narration-acceptance-plan.ts` | Pure planner plus the only manual command. Not referenced by a workflow. |
| `scripts/tsconfig.json` | Typechecks that planner. The push CI still typechecks core and web only. |
| `tests/external-narration-api.test.ts` | A caption wording edit stales timing approval only. A rejected timing save leaves the previous approval. No second data directory. |
| `tests/external-narration-vs7-ui.test.ts` | happy-dom fixtures for the panel and the caption reload. Not a browser. |
| `tests/external-narration-acceptance-plan.test.ts` | Path, digest, duration, gate, 409, and the single export body. No MP4. |

No workflow file was edited. `final-product-acceptance.yml`, `render-checks.yml`, and `phase6e-full-production.yml` do not invoke this planner. Their run-once markers were not touched.

## Review behavior

Order, unchanged and now written on the card: choose the target, import its own file and record rights, regenerate the storyboard so scenes cover the measured audio, listen and approve those exact bytes, review timing and approve it, then open QC & export. Saved work stays on the project when moving between those pages.

A caption wording edit changes the speech-timing revision. The fixture shows:

- Long listening approval stays, including the same artifact digest.
- Long timing approval becomes stale. Export of that Long is 409 with `TIMING-APPROVAL-STALE`, not `IMPORT-APPROVAL-STALE-TIMING`.
- Short 1 listening approval and timing approval stay, and Short 1 remains ready to attempt export.
- Publication stays not approved.

A rejected timing save does not replace the previous timing approval, and the target stays ready.

The listen checkbox is not approval. It is cleared when the import id changes, or when the server reports `IMPORT-APPROVAL-STALE-ARTIFACT` or `IMPORT-ARTIFACT-MISSING`. A failed import reloads the server view and still shows the import error, so a committed-but-unparsed import cannot keep an old approved view.

The bare "Approved" tag remains only when the server readiness summary is absent. When the summary is present, the card uses the server listening line. It does not invent publication approval.

## Later acceptance command

Do not run this until a person has, in the browser, imported the real recording through the existing outside-narration path, listened to those exact bytes, recorded a real rights statement, and approved the timing. The command does not import audio and does not re-approve anything.

It rejects an inside-repo path, a symlink, and any `voice-audio` path, without printing the absolute path. The measured duration and the stored duration must both be 20–30 seconds and within half a second of each other. The file digest must match `import.sha256` on the Long target. The stored gate must be ready to attempt export, and `publicationApproved` must be false.

If those checks pass, and only if `--confirm-single-export` is present, it sends one:

`POST /api/projects/<id>/export` with `{ "kind": "final", "includeShorts": false }`

No `override`. No second export. It then polls `GET /api/jobs/:jobId`. HTTP 409 stops the command. A finished job is still not publication approval.

Without `--confirm-single-export` the command only classifies the path and does not contact export.

This command was not executed. No Slima file was supplied. No render was started.

## Tests and CI

Local non-render suite, `BUILDTRACK_CI_LANE=non-render`: 1558 passed, 0 failed, 5 skipped. This is a local JSON-reporter count, not a number read from the GitHub log. The count guard printed `ok - 1558 tests passed, at or above the floor of 300` and `Test files: 400`. That "Test files" line is vitest's suite count, not the number of `*.test.ts` files. Three Chromium render files remain in the render lane and were not run.

Strict typecheck: `packages/core`, `apps/web`, `apps/api`, `scripts` — pass. Push CI typechecks core and web only; API and `scripts/tsconfig.json` were typechecked locally. The acceptance workflow typechecks `scripts/tsconfig.json` when that workflow is run. It was not run.

`npm run build:core` and `npm run build:web` — pass. The existing Vite duplicate-key warning in `packages/video/src/scenes/Explanations.tsx` was not touched.

`git diff --check` — clean.

Non-render CI: [run 37875784957](https://github.com/engmelkhabery1982/Video-Factory/actions/runs/37875784957) success on `0733f26a7ca5bb775db5765f74703a4d5c4e3eff`, created 2026-10-09T02:41:46Z, updated 2026-10-09T02:51:05Z. The Jobs API reported every step successful, including Python 3.11, both typechecks, the test suite, the production build and the test-count guard. The raw job log was not read. Render checks were not dispatched. This is not a production-render pass.

## Real versus simulated

| Check | Evidence |
| --- | --- |
| Caption wording stales timing only | In-process WAV fixture and the registered API. Not a real voice. |
| UI reload and labels | happy-dom operating the real panel and Captions page. Not a browser. |
| Acceptance plan | Pure functions and a fake client. The manual command was not executed. |
| Render, speech, Slima, models | Not run. |

## Limitations

- Not production-ready. Not Slima-tested. Voice cloning is not verified.
- Estimated timing, a matching `.timing.json`, and a manual timing approval are not acoustic verification.
- A rights statement is not commercial-rights clearance. A passing readiness check is not publication approval. A finished export job is not either of those.
- Preview does not run this check.
- The Kokoro production export does not use the imported file.
- No browser was available. No real recording was imported. No speech was generated. No model was downloaded. No MP4 was produced.
- The later command is ready to be run by a person after the browser steps. It was not run here.
