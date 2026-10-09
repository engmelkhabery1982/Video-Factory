# Final export coherence handoff

Scoped correction on `arena/c4cc1417-video-factory`. No render, no speech, no model download, no import of the real recording, no acceptance command, no publish, and no merge to `main`.

## SHAs

| | |
|---|---|
| Required source | `ba8924f101dc58212e551a6b6a4085564d8eb838` |
| Behavior commit | `9031034b4a8c1a5619649d7ddea04fc8717d715d` |
| Behavior remote, independently fetched | `9031034b4a8c1a5619649d7ddea04fc8717d715d` |
| Handoff commit | the child of `9031034` that adds this file |

This file cannot contain its own commit SHA. After the docs push, `git rev-parse HEAD` and `git rev-parse origin/arena/c4cc1417-video-factory` must match. That tip is the final HEAD. The delivery note records the fetched value.

Local HEAD was behind the required remote at the start of this session (`b235b002df4cab2237ef0a8093b1aeef225f6903`) with a dirty tree whose bytes already matched `ba8924f`. The tree was stashed, the branch was fast-forwarded, and the identical stash was dropped. No unique local work was discarded. No reset and no force-push.

## Changed files

- `apps/api/src/services/export-snapshot.ts` — review identity and per-export audio freeze.
- `apps/api/src/services/external-audio-gate.ts` — compares that identity across the async check and returns the approved project object.
- `apps/api/src/routes/projects.ts` — final export consumes that object and the frozen audio. It does not reload newer captions.
- `tests/external-narration-api.test.ts` — regressions A–L, and the old reload assertion now expects the approved snapshot.
- `.gitignore` — `export-audio-scratch/`.

Chatterbox pins, the worker, and the bounded Gemini planner were not changed.

## 1. Caption edits escaped export identity

**Reproduction, before the fix.** An isolated project was imported, regenerated, and approved for listening and timing. During `externalNarrationRenderGate`, `afterInitialRead` called the real `PATCH /api/projects/:id/captions/:cueId` once and changed cue text. The Long gate returned `allowed=true`. Caption start/end, a scene-duration PATCH whose `updatedAt` was restored, a scene-narration edit that did not change `updatedAt`, and a listening-approval revocation also left the gate allowed. A caption PATCH after the gate returned HTTP 200 and would have rendered the new cue.

**Cause.** Export identity was project id, `updatedAt`, the script digest, and audio ref plus file digest. `PATCH /api/projects/:id/captions/:cueId` saves captions and does not set `meta.updatedAt`. `saveProject` does not set it either. The gate then reloaded the project, so a passing check could be followed by newer, unapproved captions. Approval records live in voice-audio state, which the old identity did not include. Both identity reads also happened after the await, so an approval change on disk was invisible to the comparison.

**Fix.** Identity now also includes, for the targets this export will render:

- `speechTimingRevision` from the existing speech-timing snapshot (caption text and times, scene narration, scene start and duration, audio digest, imported script digest).
- a fingerprint of the listening approval (`decision`, import id, artifact digest, script digest, intended spoken digest, speaker, listened).
- a fingerprint of the timing approval (`decision`, artifact digest, script digest, speech-timing revision, reviewed).

The pre-await identity is compared with a post-await reload. A review-only mismatch is `IMPORT-APPROVAL-STALE-TIMING`. The allowed gate returns the in-memory project captured before the await. The handler does not reload that project for the renderer. A later caption, scene, timing, or approval edit is rejected if it is visible before render starts, and is otherwise excluded because the renderer receives the approved object.

Caption-only and timing-only edits still do not revoke listening approval of unchanged audio. A Long caption edit does not revoke an unchanged Short approval, and a Short-only gate does not include the Long speech revision. Ordinary project-script invalidation is unchanged. There is no second timeline and no second approval store.

**After.** The same routes now reject. Listening approval of the unchanged file remains `approved`. The declared import transcript is not rewritten.

## 2. Approved audio was still read from a mutable path

**Reproduction, before the fix.** The mocked renderer received the original narration path. Replacing that file after the last identity check changed the bytes read from the path. No acquire-time mismatch rejected the export. No private snapshot was cleaned up, because none was created.

**Cause.** The handler rechecked the digest, then `resolveTargetAudio` put the source path in `targetAudio`. `exportProject` passes that path to `muxAndEncode`, which reads it after visual rendering. The recheck did not freeze the bytes.

**Fix.** When the external gate returns an identity, the handler copies each approved file into `data/export-audio-scratch/job_<32 hex>/` before the job renders. The copy is hashed after it is written. That hash must equal the approved identity digest. An earlier digest is not treated as proof of the copy. A mismatch, an unreadable source, or an unsafe path returns HTTP 409 and does not call the renderer. The original file is not modified. The snapshot path is what `exportProject` and therefore `muxAndEncode` receive. A project with no imported narration still uses `resolveTargetAudio` and is not given a snapshot.

This is snapshot isolation, not a lock. Two exports do not block each other. Each job has its own directory. A concurrent edit is rejected if it changes the reviewed identity before render starts, and is excluded from an already frozen snapshot if it happens later. The later edit remains on disk for the next check.

**Cleanup.** Success and failure delete only that job directory. The scratch root, the original recording, and another job's directory are not deleted. The token must match `job_` plus 32 hex characters. A symlink at the job path is unlinked, not followed. Paths are not written to the 409 body or the job error. The directory is under `data/`, which is gitignored, and is not served by `/media` or `/output`.

## Snapshot identity

`ExportIdentity`:

- `projectId`
- `updatedAt`
- SHA-256 of `input.script`
- `reviewTargets`: the targets this request will render, sorted
- `audio`: every target's narration ref and file SHA-256
- `review`: for each reviewed target, `speechTimingRevision`, `listeningSha256`, `timingApprovalSha256`

The speech revision is the existing `externalNarrationSpeechTimingRevision`. It includes caption text and times and scene narration and times. It does not include visual-only fields such as variant or background.

## Audio acquisition

1. Open the source path already accepted by `targetAudioAbsPath` (contained in the data root, not a symlink).
2. The `duringAudioAcquire` seam, if a test set it, runs before that read.
3. Read the open file descriptor and write those bytes to a new exclusive file in the job directory.
4. Hash the file that was written.
5. Compare that hash with the approved identity. Mismatch rejects. No guessed identity is exported.
6. Pass that path in `targetAudio`. Do not call `resolveTargetAudio` again for an imported project.

`muxAndEncode` is only called from `exportProject`, and that function uses `targetAudio.file`. The production-plan exporter does not use this path.

## Regression evidence

Before the fix, against `ba8924f`, the new describe failed 9 tests and passed J and L:

- A, B, C, D, K: gate `allowed` was `true`, expected `false`.
- E, H: export returned 200, expected 409.
- F/G: the renderer path was the original path.
- I: the consumed path was not under the scratch root.

After the fix, the same describe passed, including the previous export-identity tests. Caption text and times, scene timing plus narration, and approval revocation reject with a stale timing or approval code. A post-validation caption edit returns 409 and does not render. Replacing the original after the snapshot does not change the consumed bytes, and those bytes hash to the approved digest. An acquire-time swap returns 409. Cleanup leaves the original and a sibling job directory. An unchanged import still exports. A project with no import still passes `none` through the existing resolver. A Long caption edit does not revoke Short listening, and the Short gate stays allowed.

## Remaining limitations

- Not a lock. A second export can start. Each consumes its own snapshot.
- A replacement after the last pre-render identity check is excluded by the snapshot, not rejected, if it happens inside the renderer. The consumed bytes stay the approved bytes.
- If ffprobe cannot measure the snapshot, `durationSec` is null. The bytes are still the approved bytes. The mux length check then has no measured duration.
- The timing sidecar next to the original is not copied. Export uses the approved project's scene times and the frozen audio bytes.
- Projects with no imported narration still pass the live path to the renderer. That is the existing path, not the approved-import path.
- Visual-only edits are not part of the speech revision. They are excluded from an in-flight snapshot because the renderer does not reload, and they do not by themselves reject the export.
- No MP4 was produced. The renderer and muxer were mocked.

## Local checks

These are local. They are not the GitHub result.

- Before: 9 failed, 2 passed in the new describe, as listed above.
- After: `tests/external-narration-api.test.ts`, core, timing, readiness, and acceptance-plan tests: 127 passed.
- `BUILDTRACK_CI_LANE=non-render npm test`: 1589 passed, 5 skipped, 1594 total, 97 files. The 5 skips include the expected unprovisioned Kokoro A6 skip.
- Count guard: `Tests passed: 1589`, `Tests failed: 0`, `Test files: 409`, `ok - 1589 tests passed, at or above the floor of 300`. The floor was not lowered.
- Strict `tsc --noEmit` passed for core, web, API, and scripts. Push CI typechecks core and web only.
- `npm run build:core` and `npm run build:web` passed. The existing Vite duplicate-key warning in `packages/video/src/scenes/Explanations.tsx` was not touched.
- `git diff --check` was clean.
- `fatal: not a tree object` appeared in local stderr and did not fail a test.

Not claimed: human listening, real Chatterbox inference, browser acceptance, or a correct MP4.

## GitHub checks

Non-render CI for the behavior commit: [run 37895482095](https://github.com/engmelkhabery1982/Video-Factory/actions/runs/37895482095).

- Conclusion: `success`
- Head SHA: `9031034b4a8c1a5619649d7ddea04fc8717d715d`
- Job `Test, typecheck and build` (`113705756980`): success, about 9m29s
- Every listed step succeeded, including Python 3.11, core typecheck, web typecheck, the test suite, the production build, and the test-count guard
- Created `2026-10-09T06:48:34Z`, job completed `2026-10-09T06:58:06Z`
- The raw job log was not read. No GitHub test count is claimed.
- Render checks were not dispatched. This is not a production-render pass.
- Annotations were the existing Node.js 20 deprecation notice and the Ubuntu 26 runner-image notice. They did not fail the job.

The docs commit that adds this file starts a later CI run because the workflow triggers on push. That later run is not the behavior result above.

## Later acceptance command

Do not run this until the actions below are done. This correction did not run it.

```bash
git checkout 9031034b4a8c1a5619649d7ddea04fc8717d715d
node --import tsx scripts/external-narration-acceptance-plan.ts \
  --project <project-id> \
  --audio <path-outside-this-repo>/rahman_raheem_narration.wav \
  --duration-min 58 \
  --duration-max 60 \
  --base http://127.0.0.1:3000 \
  --confirm-single-export
```

Use the final remote SHA if it is newer than `9031034` and contains this export fix. The audio placeholder is intentional. Do not substitute a path inside the repo, a symlink, or a `voice-audio` path. Without `--confirm-single-export` the command does not contact export. With it, the command sends one `POST /api/projects/<id>/export` body `{ "kind": "final", "includeShorts": false }` and no `override`, then polls `GET /api/jobs/:jobId`. HTTP 409 stops it. There is no retry. A finished job is not publication approval.

The recording is Gemini `rahman_raheem_narration.wav`, 58.84 seconds. It was not fabricated or imported. Accepted pronunciation is not commercial-rights clearance. Slima is not a prerequisite.

Before that command can export: check out the final SHA, keep the file outside the repository, import it through the existing outside-narration path for the Long target, listen to the whole file and approve it again, record the existing ownership declaration, approve timing, and confirm the review is ready to attempt export and publication is not approved. An approval stored before the post-VS7 script-identity correction has no `intendedSpokenSha256` and is stale until it is approved again.
