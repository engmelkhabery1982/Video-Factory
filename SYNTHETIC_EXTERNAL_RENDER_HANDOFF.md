# Synthetic external render handoff

Scoped fix on `arena/c4cc1417-video-factory`. No merge to `main`, no publish, and no claim that the app is production-ready. A successful fixture export is not human listening approval, not a rights clearance, and not publication approval.

## SHAs

| | |
|---|---|
| Expected source before this fix | `c3438d2368e0a705329f29897e8c46c865cecc76` |
| Fix commit, and the only render-start push | `f4a3f649a370c9f05f5b89a6bd6e08e421ad2577` |

Local `HEAD`, `origin/arena/c4cc1417-video-factory`, and `git ls-remote` all matched `c3438d2` before editing. No reset, force-push, or history rewrite.

This file cannot contain its own commit SHA. After the docs push, fetch `origin/arena/c4cc1417-video-factory` and compare it with `HEAD`. That match is the final remote SHA. This docs push does not change `scripts/synthetic-external-render-once.ts` or `.github/workflows/synthetic-external-render.yml`, so the path filter must not start another render.

## What failed before

[Synthetic external render #1](https://github.com/engmelkhabery1982/Video-Factory/actions/runs/37912519536) on `fb20065` failed with `input.productShots is not iterable`. The artifact was 6.67 KB, so no MP4. The create body in the script omitted `productShots` and `brollFiles`. `provenance()` iterates both lists, and `exportProject` calls `writeMetadata` before rendering. That was not a Chrome, FFmpeg, or GPU failure.

Before the API change, posting that original body returned 200 and saved the incomplete project. After the change, the same body returns 400 and is not saved. `provenance()` still throws on that shape. The defect is not hidden by a fallback array.

## Fix

`scripts/synthetic-external-fixture.ts` is a pure factory. Importing it does not start a server, generate a WAV, or render. The request uses `satisfies ProjectInput`. It keeps the Arabic line `بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ.`, `narrationSource: 'external_ready'`, `shortCount: 0`, empty media lists, `voiceoverFile: null`, `targetAudio: {}`, and the existing `buildtrack` preset. Other required fields are neutral. No invented dialogue and no Gemini recording.

The render script posts that factory value. `scripts/tsconfig.json` includes the factory and the script, and `tsc --noEmit -p scripts/tsconfig.json` was executed.

`POST /api/projects` requires `productShots` and `brollFiles` to be arrays of strings. Omission is rejected, not stored as `[]`. `null`, objects, numbers, strings, and non-string members return 400 `INVALID_MEDIA_LIST`. An ordinary `PUT` rejects a malformed list and leaves the stored lists unchanged. A topic-only update preserves valid lists. The approval content-type caller now sends `[]` for both lists.

On failure, the script writes `.stills/synthetic-external-render/evidence.json` with the job error and job log, with absolute paths replaced by `[path]`. The existing upload step already runs `if: always()`.

## Local checks before the triggering push

- Original incomplete fixture: expected 400, received 200, then the route was fixed.
- `tests/synthetic-external-fixture.test.ts`: 5 passed. Isolated data and output directories. Real `writeMetadata`, not a mock.
- Full non-render suite: 1620 passed, 5 skipped, 0 failed.
- Strict typecheck: core, web, API, and `scripts/tsconfig.json`.
- `npm run build:core` and `npm run build:web` succeeded.
- Test-count guard: 1620 passed, floor 300.
- `git diff --check` clean.
- No local render, no `POST /export` from this machine, no `workflow_dispatch`.

## GitHub

| Run | SHA | Event | Result |
|---|---|---|---|
| [CI](https://github.com/engmelkhabery1982/Video-Factory/actions/runs/37937267944) | `f4a3f649a370c9f05f5b89a6bd6e08e421ad2577` | push | success |
| [Synthetic external render #2](https://github.com/engmelkhabery1982/Video-Factory/actions/runs/37937267737) | `f4a3f649a370c9f05f5b89a6bd6e08e421ad2577` | push | success |

That push is the only render start. No dispatch, marker edit, empty commit, rerun, or second triggering push. The workflow list for `synthetic-external-render.yml` shows this success and the earlier failure only.

The job “One synthetic WAV final export” completed in 1m 34s. Every step succeeded, including “Render one declared synthetic WAV” and “Upload the render evidence”. The artifact `synthetic-external-render` is 3,944,319 bytes (3.76 MB), digest `sha256:3bff312defe1253fb37a89b48806537fb1d3b2210dab89e1acf81f291beb9401`. The previous failed artifact was 6.67 KB.

## What this environment could not read

Artifact and job-log downloads redirect to `productionresultssa10.blob.core.windows.net` and `results-receiver.actions.githubusercontent.com`. Both returned EOF from this environment, as they did for the failed run. The evidence JSON and MP4 bytes were therefore not opened here, and no independent ffprobe was run on the downloaded file.

The render step exits non-zero unless its own ffprobe sees a nonempty MP4 with video and audio, 1920x1080, audio and video durations within 1 second of the 4-second sine fixture, and an unchanged WAV hash. That step succeeded. The evidence file it writes on success labels the generator as `ffmpeg lavfi sine=frequency=220:duration=4`, `speech: false`, `geminiRecording: false`, `humanListeningApproval: false`, and `publicationApproved: false`. Those labels were not re-read from the artifact in this environment.

## Not claimed

This is not speech, not the Gemini recording, not a human listening approval, and not publication approval. `decidedBy` remains `ci-fixture-not-a-human`. Windows was not tested. Do not merge to `main`.
