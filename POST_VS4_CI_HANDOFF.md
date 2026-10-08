# Post-VS4 CI — non-render baseline

Non-render CI baseline verified.

This is a CI harness repair only. It is not a product change, not a render pass, and not acceptance of the application.

## What this does not claim

- The application is not production-ready.
- Voice cloning is not validated. No Chatterbox weights were installed and no real inference ran.
- The agreed Slima narration was not imported. No speech was generated. No video was rendered.
- Final product acceptance did not pass. VS5, VS6 and VS7 were not started.
- The named render lane was not dispatched. A green result here is not a production-render pass.
- Estimated timestamps were not treated as verified alignment. An entered engine name was not treated as verified rights.

## Remote identity

| | |
| --- | --- |
| Repository | `engmelkhabery1982/Video-Factory` |
| Branch | `arena/c4cc1417-video-factory` (session branch; not merged to `main`) |
| Required VS4 commit | `98cb9799546e3ff117381f983ba651534ce2e447` (parent `9b33950fcca60adc6223ef4604b23a9e3863a773`) |
| Diagnostic commit | `20081c5eb4f3727ec843a442bd9415e3b96c8d34` |
| Repair commit verified below | `4e00432fdf30fcf013ea1b471691aedfd9f9fa2a` |
| Remote ref at verification | `git ls-remote origin refs/heads/arena/c4cc1417-video-factory` returned `4e00432fdf30fcf013ea1b471691aedfd9f9fa2a` |
| Local HEAD at verification | the same SHA. `98cb979` is an ancestor. Working tree was clean apart from this handoff, which was written after the green run |

This handoff is documentation. It does not change the repair. If it is committed after `4e00432`, that later commit is not the run recorded here.

## Failing run that was investigated

[Run 37852142691](https://github.com/engmelkhabery1982/Video-Factory/actions/runs/37852142691), job `113567400563`, push of `98cb979`. Conclusion: failure. The raw job log could not be downloaded (`productionresultssa15.blob.core.windows.net` returned EOF). That URL was not retried.

What the Checks API did show:

- Type check (core) and type check (web) completed successfully.
- The test step exited 1. Elapsed time was about 5.5 minutes, not a 20-minute render timeout.
- Failure annotations, and only these product failures:
  - `tests/chatterbox-provisioning-doctor.test.ts:66` — `python-3.11.ok` was false.
  - `tests/chatterbox-provisioning-doctor.test.ts:124` — parsing the fake worker returned `null` because `spawn('python3.11')` did not start.
  - `tests/chatterbox-synthesizer.test.ts`, `tests/chatterbox-reuse-invalidation.test.ts` and `tests/voice-audio-api.test.ts:207` — `Python 3.11 is required to run the deterministic Chatterbox worker fixture`.

Those annotations were a strong hypothesis, not yet a complete census, because the raw log was missing.

## Bounded diagnostic

[Run 37854446845](https://github.com/engmelkhabery1982/Video-Factory/actions/runs/37854446845) on `20081c5`. The push gate was split so the three inspected Chromium files stayed out of `npm test`. A temporary diagnose job recorded the remaining failures and probed the interpreters. It was removed in the repair commit. The render workflow was not dispatched.

Diagnose job `113575142450` succeeded by design (the census script exits 0). Its notices:

```text
platform=Linux x86_64
os=Ubuntu 24.04.5 LTS
python3=/usr/bin/python3 Python 3.12.3
python3.11=missing (command not found)
```

Its census annotation: `failed=4 passed=1402 skipped=35 files=372 groups=3`. The three groups were the two doctor assertions and the two suite errors from `chatterbox-synthesizer` and `chatterbox-reuse-invalidation`. That census undercounted a `beforeAll` hook: the same run's validate job `113575141979` still annotated `tests/voice-audio-api.test.ts:207` with the same Python 3.11 error. No other failure class appeared. No render-file failure appeared in the non-render lane.

The ubuntu-latest migration to Ubuntu 26 is dated 2026-10-19. The user date for this work is 2026-10-08, and the probe image was Ubuntu 24.04.5. That migration was not the cause.

## Cause

Demonstrated, not inferred from a name:

- The runner's `python3` is CPython 3.12.3. There is no `python3.11` executable.
- `tools/doctor.mjs` and `tests/chatterbox-provisioning-doctor.test.ts` resolve the command name `python3.11`. `CHATTERBOX_PYTHON` alone does not satisfy that test.
- `resolveTestPython()` rejects anything that is not 3.11, so the fake worker never starts.
- The fake worker is a deterministic fixture. It is not Chatterbox and it does not download weights.

This was a runner-setup failure. It was not a product regression in VS4.

## Repair

Commit `4e00432` only:

- `.github/workflows/ci.yml` installs CPython 3.11 with `actions/setup-python@v5` (`python-version: '3.11'`).
- A following step requires the name `python3.11` on `PATH`, creates that name from the installed interpreter if setup-python did not, asserts `sys.version_info[:2] == (3, 11)`, logs path and version, and exports `CHATTERBOX_PYTHON` for later steps.
- The workflow does not run `provision:voice-clone`, does not install `chatterbox-tts`, and does not pass `--apply`.
- `BUILDTRACK_CI_LANE=non-render` remains. `vitest.config.ts` then excludes only the files in `scripts/render-lane-tests.json`: `tests/phase6b-real-render.test.ts`, `tests/phase6c-real-short-render.test.ts`, `tests/phase6d-real-package.test.ts`. Those three were classified by reading their calls, not by filename. `phase6d` calls `renderProductionDeliveryTargets` in `beforeAll`. The other two call the real renderer inside `describeReal`.
- `.github/workflows/render-checks.yml` stays `workflow_dispatch` only. This task did not run it.
- The temporary diagnose job and `scripts/ci-failure-summary.mjs` are removed.
- `tests/ci-non-render-lane.test.ts` fails if the push workflow stops provisioning 3.11 or starts invoking those render files.

No test was deleted, skipped, or weakened. The count-guard floor is still 300. Safety, consent, approval and invalidation gates were not changed. Kokoro and Chatterbox behaviour were not changed. The VS4 external-audio and duration-preservation contracts were not changed.

## Green non-render run

[Run 37856650077](https://github.com/engmelkhabery1982/Video-Factory/actions/runs/37856650077)

| | |
| --- | --- |
| Event | `push` |
| Workflow | CI |
| Head SHA | `4e00432fdf30fcf013ea1b471691aedfd9f9fa2a` (matches the remote ref above) |
| Conclusion | `success` |
| Job | `113582325993` “Test, typecheck and build”, conclusion `success` |
| Created | 2026-10-08T22:57:26Z |
| Updated | 2026-10-08T23:06:41Z |

Every step concluded `success`, including Set up Python 3.11, the step that asserts the `python3.11` name and version, both typechecks, the test suite, the production build, and the test-count guard.

The raw job log is still unreadable from this environment (the same blob host returned EOF). The step conclusions and annotations were read from the Actions API, not from that log. Because the log text could not be read, this handoff does not quote a GitHub test count and does not quote the hostedtoolcache path. The interpreter step exits non-zero unless `python3.11` reports version 3.11; that step succeeded. The count-guard step exits non-zero below 300 passed tests or on any failure; that step succeeded.

Annotations on the green run: a Node.js 20 deprecation warning (checkout, setup-node, setup-python and upload-artifact are forced onto Node.js 24) and the Ubuntu 26 migration notice. No failure annotation. The warning did not fail the job and was not “fixed” by pinning a different action major.

No other workflow ran on this SHA. Render checks was not dispatched.

## Local checks before the push

These are local results, not the GitHub count:

- Strict typecheck: `packages/core`, `apps/web`, `apps/api`, `scripts` — pass.
- `BUILDTRACK_CI_LANE=non-render npx vitest run`: 382 files, 1506 passed, 0 failed, 5 skipped. The three render-lane files were absent. `tests/ci-non-render-lane.test.ts` was present.
- `npm run build:core` and `npm run build:web` — pass. The existing Vite duplicate-key warning in `packages/video/src/scenes/Explanations.tsx` was not touched.
- `BUILDTRACK_CI_LANE=non-render node scripts/assert-test-count.mjs` — `ok - 1506 tests passed, at or above the floor of 300`.
- `git diff --check` — clean.

The previously failing Python tests passed locally because this machine already has `python3.11`. That local pass was not treated as the CI result.

## Left as it was

- Render lane: listed, intact, not triggered.
- VS5–VS7, Slima audio import, speech generation, video render, and final acceptance: still deferred.
- Node.js 20 action warning: reported, not changed.
