# Milestone 1 backend — conformance report

- Baseline: `59c8d29515227a53b424cf4402e2399fa5ee8ba7` (tree `5f45783791d9efeeec0fbeab53f83d35dcabdc9a`)
- Head: `011b023fc30f9eae3dd19b9f007c7d5124bfe213` (tree `b33f688c6c242a13666181f213e5d3cbc4b2e814`), branch `arena/890ccb82-video-factory`, local only, not pushed
- Scope: `apps/api/**`, `packages/core/**`, `packages/video/**`, backend tests. No `apps/web` file changed. No package manifest or lockfile changed. No model install or download. No owner `data/` or `output/` touched.

## 1. Route conformance (EDITOR_CONTRACT_V1)

| Route | Contract | Implementation | Evidence |
|---|---|---|---|
| `GET /api/projects/:id/editor?targetId=` | envelope `{document, undoAvailable, redoAvailable, capabilities}` | yes; first open is revision 0 even with narration bound | `editor-api` + `editor-alignment-preview` tests |
| `PATCH …/editor` | body `{targetId, baseRevision, operations}`; atomic; 409 `REVISION_CONFLICT {code,message,currentRevision}` | yes; 423 `EDITOR_LOCKED`; storage failure → `EDITOR_STORAGE_FAILED` | tests (conflict, lock, takeover, storage failure) |
| `POST …/editor/undo`, `/redo` | whole-transaction history, limit 50 | yes; narration sync clears history | tests |
| `POST …/editor/alignment` | body `{targetId, sourceAudioId}`; `{jobId,status:"running"}`; structured blocker otherwise | yes. Adds optional `baseRevision`. 202 running; 503 `ALIGNMENT_RUNTIME_UNAVAILABLE` with reason; 400 `EDITOR_BAD_AUDIO`; 422 `ALIGNMENT_SOURCE_MISMATCH` / `ALIGNMENT_TARGET_UNSUPPORTED`; 409 `ALIGNMENT_ALREADY_RUNNING` | tests (202, 409, 422, 503 path; 503 path with env unset in editor-api) |
| `GET …/editor/alignment/:jobId` | `{status, proposalId?, rows?, error?}`; unresolved spans; unavailable/failed explicit | yes, top-level `status`, `proposalId`, `rows`, `unresolved`, `error`, `detail`; extra `proposal` object and `stale` flag | tests (proposed, unavailable, BLOCKER failed) |
| `POST …/editor/alignment/:proposalId/accept` | body `{targetId, baseRevision, reviewed:true}`; validates identity; applies; returns envelope | yes. 400 without reviewed; 404 unknown; 409 `ALIGNMENT_PROPOSAL_STALE` / `ALIGNMENT_PROPOSAL_NOT_ACCEPTABLE` / `REVISION_CONFLICT` | tests |
| `POST …/editor/preview` | body `{targetId, baseRevision, range?}`; `{jobId,status:"running"}`; frozen revision; ≤30 s | yes. 202 running with `revision`, `range`. 501 `PREVIEW_UNAVAILABLE` when off or no renderer (checked before body). 400 `PREVIEW_RANGE_*` | 501 in tests; 202 + ready in local real run (section 4) |
| `GET …/editor/preview/:jobId` | `{status, revision, range?, mediaUrl?, error?}`; stale is labeled | yes, plus `stale`, `evidence`. Running jobs left by a restart become `failed`, never `ready` | 404 in tests; 200 in real run |
| `GET …/editor/preview/:jobId/media` | file serving | yes, `video/mp4`, 409 `PREVIEW_NOT_READY` otherwise | real run (200, video/mp4) |
| `GET …/editor/media/narration/:importId` | owner import, read-only | yes, `audio/wav` from the owner's import; 404 for non-current ids | test (bytes sha equal) |

Revision conflict body: `{code:"REVISION_CONFLICT", message, currentRevision}` — as specified.

## 2. Deliverable conformance

- **Editor document, atomic persistence, revisions, undo/redo**: sidecar `data/projects/<id>/editor/<target>.editor.json`; `project.json` and approvals never written by editor. Atomic temp → fsync → rename.
- **Edit operations with source-range trim/split/reorder**: from the earlier commit (`89f53ff`); split source offsets tested.
- **Crop, still motion, portrait/landscape mapping**: plan maps crop/motion/`sourceInSec` into `Scene.content`; reuses SceneRenderer.
- **Fade transition**: fade-through-black at clip boundaries, window `min(0.5, prev/2, clip/2)`. Mapping unit-tested; **not visually verified in a real render** (the real run used a single scene).
- **Dissolve**: refused with `EDITOR_CAPABILITY_UNAVAILABLE` (422). **Pending owner amendment A1**; that document is not written here.
- **Narration binding**: the existing external import is bound read-only. New file or bytes → new asset/clip, approval cleared, alignment reset. Approval-only change keeps trim. Missing/changed file → 409 `EDITOR_NARRATION_CHANGED`, never silently dropped.
- **Windows bridge to vf-align**: `vf-align-worker.ts` reads config from env (`VF_ALIGN_COMMAND` JSON argv, checkpoint, tokenizer, review root, optional WSL path translation, timeout 60–7200 s). Runner flags are the real ones from `align_recording.py` (`--wav --project-json --state-json --checkpoint --tokenizer --review-dir`). No install, no download, no hardcoded duration, no pause estimate. Review root must sit outside project data (the runner enforces the same).
- **Proposal identity and staleness**: proposal bound to `sourceRevision`, narration sha, import id, and an alignment identity hash (visual clip ids/durations and caption texts). Any change → `ALIGNMENT_PROPOSAL_STALE`, nothing applied.
- **Accept mapping**: captions map linearly from their visual clip span into the row span (narration time converted through the audio clip). Visual and audio clips unchanged. A locked caption in an aligned span → 423 `EDITOR_LOCKED_ITEM` (limit: the whole accept is refused, not partially applied).
- **Alignment status changes do not bump revision**; proposal staleness stays comparable to `sourceRevision`.
- **Previews**: frozen revision (`editor/frozen/<target>-r<rev>.json`), frame-range render through the existing `LongVideo`/`ShortVideo` composition, narration cut with source-offset rules (clip starting after range start is delayed; clip started earlier is read from its own offset; silence outside), ffprobe verification (duration ±0.12 s, video and audio present).

## 3. Acceptance checks

| Check | Status | Where |
|---|---|---|
| save/reopen parity | pass (fixture) | editor-api |
| storage failure | pass (fixture) | editor-api |
| concurrent revisions (409) | pass (fixture) | editor-api |
| locks (423, stale takeover) | pass (fixture) | editor-api |
| undo/redo | pass (fixture) | editor-api, alignment-preview |
| split source offsets | pass (fixture) | editor-api |
| partial-preview offsets | pass (pure rule tests); real run covers a 2–8 s range | alignment-preview (`narrationFilter`, `previewFrames`); section 4 |
| proposal staleness | pass (fixture) | alignment-preview |
| video clip starting after time zero | pass | editor-api |
| preserved Arabic text | pass; visually confirmed in a real frame (diacritics intact) | editor-api; section 4 |
| **owner recording acceptance** | **NOT RUN here** (see section 5) | `LOCAL_VERIFY_STEPS.txt` STEP 5–7 |

Fixture success is not acceptance. The alignment runner in tests is `tests/fixtures/fake-align-runner.mjs`, which writes boundaries in the real shape but produces no alignment evidence.

## 4. Real render evidence (this Linux sandbox, not the owner's host)

Script `.stills/scripts/run-preview-evidence.ts` (git-ignored scratch) ran the real API over HTTP on port 3917 with a generated 20 s sine WAV as the narration and no image assets:

- `POST /editor/preview` range 2–8 s → 202, job `prv_60044b3c2dd87dbb`, revision 0.
- Job → `ready`; `evidence`: startFrame 60, endFrameExclusive 240, expected 6 s, probed 6.022 s (AAC priming), 1920×1080, video and audio, `hasNarration: true`.
- `GET …/media` → 200 `video/mp4`, 82,847 bytes.
- Frame at 1.0 s of the preview shows the Arabic caption rendered with diacritics intact, on the typography-only background (scratch project has no image asset, so no owner footage was exercised).

This proves Remotion `renderMedia` with frameRange, the composition props mapping, the narration cut, and ffprobe verification work end to end here. It does not prove owner footage or owner audio.

## 5. Known blockers and limits

1. **Owner acceptance not run.** No WSL vf-align runtime on this sandbox. The bridge is verified only against the fixture protocol. Real alignment, listening, and accept must run on the owner's Windows host (STEP 5–7 of `LOCAL_VERIFY_STEPS.txt`).
2. **Dissolve refused** until amendment A1.
3. **Alignment target `long` only**: the runner reads the `long` script. Short targets return 422 instead of guessing.
4. **Cached emissions reuse not implemented**: each job recomputes; the contract's cache reuse is deferred.
5. **Preview with owner footage not run**; only a typography-only scene was rendered here.
6. **In-process job queue**: one preview at a time; jobs are not multi-process safe. A restart marks running jobs failed.
7. **Narration media route has no HTTP Range support**: seeking in some browsers may be limited (frontend concern, noted).
8. **Narration change clears undo/redo** by design: an external import cannot be undone through the editor.
9. **Accept does not re-verify listening**: the owner's `reviewed:true` is the gate, as the contract requires.
10. **Pre-existing**: `packages/video` scoped typecheck shows 15 errors in `Root.tsx`, `Explanations.tsx`, `Hooks.tsx` — identical to the baseline count; none in changed files.
11. Not implemented (later capabilities, per scope): storyboard importer, audio-only transcription, new TTS, image/video generation APIs, creative scenario generation.

## 6. Tests and builds

- `npm run build:core` → exit 0 (`build-core.log`).
- `apps/api` `tsc --noEmit` → exit 0, 0 errors (`typecheck-api-m1.log`).
- Scoped `packages/video` typecheck → 15 errors, same as baseline (`typecheck-video-M1.log`).
- Targeted editor suites: `tests/editor-document.test.ts`, `tests/editor-api.test.ts`, `tests/editor-alignment-preview.test.ts` → 3 files, **75 passed** (`test-editor-m1.log`). Last run was after the final API change.
- Regression subset (11 files, non-UI, non-browser: ctc-alignment, content-led, external-narration api/core/render, external-timing-review api/core, narration-boundaries and its API, audiovisual-sync, export-targets) → **183 passed** (`test-regressions-M1.log`). Run before the final alignment-contract change, which touched only alignment job routes and worker outputs.
- Patch `git apply --cached --check` against baseline tree → exit 0.
