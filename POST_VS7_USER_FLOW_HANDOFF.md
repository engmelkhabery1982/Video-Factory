# Post-VS7 user-flow handoff

Scoped continuation on `arena/c4cc1417-video-factory`. No merge to `main`, no publish, and no claim that the app is production-ready. `Ready to attempt export` is a gate result, not a completed render, not a rights clearance, and not publication approval.

## SHAs

| | |
|---|---|
| Required source for the first requested CI wait | `0617adf26a4689902178fa076403f78596d27e1f` |
| Later behavior commit already on the remote | `62320242be3e4d0a0a79e5d78f5dd75caab6c8f8` |
| Render-start commit already on the remote | `fb20065edf2cd91bd902b7a9a36cae8a8cd86546` |
| Remote tip before this handoff | `fb20065edf2cd91bd902b7a9a36cae8a8cd86546` |

This file cannot contain its own commit SHA. After the docs push, fetch `origin/arena/c4cc1417-video-factory` and compare it with `HEAD`. That match is the final remote SHA.

The local checkout that started this turn was a stale `b235b00` tree. It was aligned to the remote tip before any new edit. Unique browser screenshots were kept. No history rewrite and no force-push.

## CI

| Run | SHA | Result |
|---|---|---|
| [CI for `0617adf`](https://github.com/engmelkhabery1982/Video-Factory/actions/runs/37909413850) | `0617adf26a4689902178fa076403f78596d27e1f` | success |
| [CI for the export-gate fix](https://github.com/engmelkhabery1982/Video-Factory/actions/runs/37911651786) | `62320242be3e4d0a0a79e5d78f5dd75caab6c8f8` | success |
| [CI for the render-start commit](https://github.com/engmelkhabery1982/Video-Factory/actions/runs/37912519474) | `fb20065edf2cd91bd902b7a9a36cae8a8cd86546` | success |
| [Synthetic external render](https://github.com/engmelkhabery1982/Video-Factory/actions/runs/37912519536) | `fb20065edf2cd91bd902b7a9a36cae8a8cd86546` | **failure** |

The non-render CI for the requested SHA succeeded. The separate synthetic render workflow failed. That failure is not a CI pass for the video.

## What is proven by automated tests

Fresh run on `fb20065` of `tests/approval-content-type.test.ts`, `tests/user-flow-external-narration.test.ts`, `tests/chrome-resolution.test.ts`, and `tests/external-narration-render.test.ts`: 25 passed, 0 failed.

- Arabic script, diacritics, and order are kept. The hook and key points are not spoken.
- An external project does not start production generation, Kokoro captions, or production export.
- Opening a project does not switch the narration source. An explicit switch keeps production files.
- The in-app dialogue path still attempts generation.
- An unprovisioned English engine returns `ENGINE_NOT_PROVISIONED`, not a generic 500. Arabic on an English-only voice returns `DIALOGUE_LANGUAGE_UNSUPPORTED`.
- Missing production state and corrupt production data are distinct.
- `durationSec=null` and a missing measurement refuse a final mux before ffmpeg.
- Missing listening or timing approval blocks ordinary export.
- A caption change after the check is rejected. Swapping the original after the snapshot does not change the frozen bytes.
- Dialogue structure findings (missing hook, CTA count, product-only-at-end) do not block an approved external project. The ordinary export route returns a job id. That test replaces `exportProject` with a stub, so it proves the gate, not a rendered file.
- Listening approval is posted by `apps/web/src/lib/api.ts` to a listening server. The duplicated header `application/json, application/json` still returns 415. The client sends one `Content-Type` and the server records the approval.
- Windows/Linux browser resolution is the same function for doctor, provision, and runtime: an ELF is not selected or renamed on Windows, an old marker is not success, `BUILDTRAKE_CHROME_PATH` is honored with that spelling, and a missing override does not fall through to the ELF.

## Real browser

Local headless Chromium, not Windows, and not happy-dom. Screenshots are in `docs/post-vs7-browser/`. They were captured against a local server before `6232024` / `fb20065`, using a synthetic sine WAV, not the Gemini recording.

Shown: new project with “I already have the narration”, Arabic storyboard without invented English dialogue, captions import card, listening approval, timing review, reload that kept the import and approvals, and the export page saying ready to attempt export while still “Not publication approved”. Final export was not clicked. This is not a render and not human listening approval.

## Actual render

**Failed. Not a pass.**

One GitHub run already happened: [Synthetic external render #1](https://github.com/engmelkhabery1982/Video-Factory/actions/runs/37912519536). The job “One synthetic WAV final export” exited 1 at “Render one declared synthetic WAV”. The uploaded artifact `synthetic-external-render` is 6.67 KB, so no MP4 was produced.

The log and artifact bytes are served from a host this environment cannot read (`productionresultssa10.blob.core.windows.net`). The only GitHub-hosted annotation is `Process completed with exit code 1`. That is not a root cause.

A local pre-export probe of the same declared fixture, stopped before `POST /export`, succeeded: create 200, import 201, spoken text unchanged, QC not blocked, fixture approvals accepted, gate `exportAttemptReady=true` and `publicationApproved=false`, frozen audio planned at 4 seconds. That does not explain the GitHub failure and is not a render.

No second render was started. Editing `.github/workflows/synthetic-external-render.yml` or `scripts/synthetic-external-render-once.ts` would start another run through the path filter. That would be a retry without a proven fix, which this order forbids. `workflow_dispatch` was already unavailable to the token.

Declared fixture, unused for a successful export: `synthetic-external-narration.wav`, ffmpeg `sine=frequency=220:duration=4`, 44100 Hz mono pcm_s16le, spoken text `بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ.` only. `decidedBy` is `ci-fixture-not-a-human`. It is not the Gemini file and not a user approval.

## Windows, not tested here

No Windows machine was available. Do not treat the Linux ELF under `.browser/chrome` as `chrome.exe`. Do not rename it. An old provision marker is not success.

To update a Windows checkout without touching existing projects:

1. Stay on `arena/c4cc1417-video-factory`. Do not merge to `main`.
2. Copy `data/` and `output/` aside if they hold real projects, or leave them in place. `git pull` does not delete them; they are not the branch contents.
3. `git fetch origin` and fast-forward to the remote SHA recorded after this docs push.
4. `npm ci`. Do not run `npm audit fix --force`.
5. Do not run the Linux provision unpack. Set `BUILDTRAKE_CHROME_PATH` to the installed Chrome, with that exact spelling, for example `C:\Program Files\Google\Chrome\Application\chrome.exe`.
6. Run `node tools/doctor.mjs`. It must report that same path and that the browser runs, not merely that a file exists.
7. Start the app with the existing `data/` directory. Opening a project must not switch its narration source and must not delete production files.
8. Import the real recording only on that machine, through Captions, and approve it by listening. This handoff does not do that.

## Remaining security risks

`npm audit` reports 14 vulnerabilities: 2 critical, 6 high, 6 moderate. Critical findings are `vitest` and `tinypool`, which are test tooling, not the running app. High findings include `vite` and `source-map-js` (development), the Kokoro/`sharp` chain (not used by the external-audio path), and `@fastify/static` (pinned, not imported by the server). No mass upgrade and no `npm audit fix --force` was run. This is not production-deploy readiness.

## What remains blocked

The synthetic GitHub render failed, and its log cannot be read from this environment. Until that log is available, or a proven code failure is reproduced without a local render, another render run would be an undiagnosed retry. The real Gemini WAV, human listening, Windows doctor, and a finished MP4 are not done.
