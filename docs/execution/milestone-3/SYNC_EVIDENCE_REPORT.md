# Milestone 3 — synchronization and source-integrity report

Branch `arena/890ccb82-video-factory`. Base for this work: `48d44cd` (the pushed M3 Gemini UI head).
This report covers the sync work order only. It does not declare the factory complete.

## 1. What was wrong (observed in code, before this change)

- `externalNarrationAlignment` labelled a narration `exact_scene_timing, verified: true` when the
  sidecar `<audio>.timing.json` had the same scene count and the same scene text. It never checked
  the audio bytes, the duration, or the source window. A sidecar made for another audio window with
  the same text was therefore labelled exact.
- `proposalStaleReasons` checked the narration sha, the import id and the identity hash, but no
  excerpt identity. `acceptProposal` had no discrepancy check. The alignment runner's
  `boundaries.json` had no transcript field.
- A forced-alignment `available: true` result could therefore be applied as if it proved the supplied
  text was spoken. It does not.

## 2. What changed (fixture-level, code-verified)

### 2.1 Core: `packages/core/src/scenario/sync-evidence.ts` (new)

- `normalizeSpokenText`: comparison form only. Strips diacritics and tatweel, folds alef variants
  (أ إ آ ٱ → ا), ى → ي, ؤ → و, ئ → ي, ة → ه, lowercases, drops punctuation. The stored text is never
  changed; Arabic diacritics stay in the caption data.
- `diffTokens`: LCS diff of token lists (missing and extra words, in order).
- `compareScriptToTranscript`: exact agreement after normalisation. Any missing or extra word is a gap.
- `excerptIdentitySha256`: sha256 of the audio sha, source in/out, and composition start, each
  rounded to the millisecond.
- `syncVerdict`: the verdict rules, in order:
  1. no alignment requested and no evidence → `not_requested`
  2. evidence excerpt differs from the current excerpt → `stale`
  3. no transcript → `unverified`, even when forced alignment placed the text
  4. transcript disagrees (any missing or extra word) → `discrepancy`
  5. transcript agrees and forced alignment placed the text → `verified`
  6. transcript agrees but no placement → `unverified`

  Forced alignment alone can never yield `verified`.

### 2.2 Sidecar binding: `apps/api/src/routes/external-narration.ts`

- `externalNarrationAlignment` now takes the sidecar and the measured narration file. Exact timing is
  claimed only when the text matches, the sidecar declares the sha256 of the file on disk, and its
  declared duration matches the measured duration within 0.05 s (`SIDECAR_DURATION_TOLERANCE_SEC`).
- A sidecar that matches the text but does not declare its audio is an estimate, with a reason.
- **Behaviour change:** a sidecar without `audioSha256` and `audioDurationSec` is no longer exact. The
  owner's existing sidecars, if any, must declare the audio they describe to be exact again.

### 2.3 Alignment evidence: `apps/api/src/services/editor-alignment.ts`

- The job records `excerptSha256` at start. Each proposal records `excerptSha256`, `syncVerdict`,
  `syncReasons`, and the optional `transcript`.
- `proposalStaleReasons` adds an excerpt check. A proposal with no excerpt evidence (made before this
  change) is stale, and the owner must run the alignment again.
- `acceptProposal` refuses a `discrepancy` with `ALIGNMENT_TRANSCRIPT_DISCREPANCY` (409). Nothing is
  applied, and the proposal stays `proposed` for review.
- An accepted alignment stores `excerptSha256` and `syncVerdict` on the document. Audio trim, source
  change, or replacement clears them (`not_requested`), and that state survives save and reload.
- `vf-align-worker.ts`: `parseBoundaries` reads an optional `transcript` string. **The current runner
  does not produce one** (`tools/alignment-run/align_recording.py` performs a forced-alignment forward
  pass with `transcribeCalled: false`). Until a transcript source exists, every alignment is reported as
  `unverified`. This is the honest state, and it is not a bug.

### 2.4 Caption translation link (`cueOf`), `packages/core/src/editor/`

- `EditorCaption.cueOf` (optional, additive). A translation points at a spoken cue by stable id.
- Validation: the target must exist, must not be a translation, and must have equal timing.
- Operations:
  - a translation's timing cannot be edited (`EDITOR_TRANSLATION_TIMING_LOCKED`);
  - translation text can be edited and keeps its timing;
  - retiming a spoken cue moves its translations to the same timing;
  - a spoken cue with a translation cannot be removed (`EDITOR_CUE_HAS_TRANSLATIONS`);
  - `cueOf` cannot be changed by an update;
  - inserting a translation with different timing is refused, and missing timing is copied from the cue;
  - accepted alignment rows cannot move a translation directly, and move its spoken cue with it.
- **Not built:** a UI for creating translations. The link is enforced in core and reachable through
  the existing editor operations endpoint. Nothing in the UI creates a translation today.

### 2.5 Highlights

- Unchanged in code. `applyEditorOperations` validates the whole result, so a highlight moved outside
  its clip, or a clip trimmed or reordered so that a highlight falls outside, is refused with
  `highlight … lies outside its visual clip`. The input is untouched, so the highlight is never moved.
- **Not built:** a separate "flagged" badge for a highlight that is already outside its clip. Such a
  state cannot be saved, so there is nothing to flag.

### 2.6 Editor review (existing Editor, no competing editor)

- `EditorAlignmentPanel` shows the proposal's verdict, its reasons, and whether an independent
  transcript was compared. A `discrepancy` disables "Accept reviewed timing". `unverified` shows that
  forced alignment is not proof of spoken text.
- The saved document verdict appears in the panel after reload, and states that listening review is
  separate.
- `EditorTimingStatus` is unchanged.

## 3. Owner-observed boundaries

The recording boundaries in the work order (previous fragment 0–3.944 s, "Yes" 4.725–4.946 s,
"Keep the certificate reference…" 5.947–11.193 s, "That helps you avoid…" 12.434 s) are evidence for
one recording. They are not used as offsets, targets, or fixtures anywhere in this change. No owner
recording, WAV, MP4, or model was requested or touched.

## 4. Integration overlap report (owner's unpushed local fixes)

Owner local HEAD `de545d0fe69e9d3047c0e052323c74488cffdddb` is **not present in this sandbox**. The
analysis below uses the described areas only. Nothing here claims those fixes are on origin, and the
owner's Windows checkout was not touched.

| Owner local fix (as described) | Files touched in this change | Overlap |
|---|---|---|
| Gemini 3.8 REST corrections | none in the Gemini adapter | None found. Not analysed in code. |
| Extended voice catalog and delivery-style selection | none | None found. |
| Still-image pan overscan | none (video package not changed) | None found. |
| Explicit channel-logo visibility | none | None found. |

**Caveat.** Any owner change to `apps/api/src/routes/external-narration.ts`,
`apps/api/src/services/editor-alignment.ts`, `apps/api/src/services/vf-align-worker.ts`,
`apps/api/src/routes/editor.ts`, `packages/core/src/editor/{document,narration,operations}.ts`, or
`packages/core/src/scenario/index.ts` could conflict textually. The owner should check those files
before merging. This report cannot determine that from the sandbox.

## 5. Changed files

Source:
- `packages/core/src/scenario/sync-evidence.ts` (new)
- `packages/core/src/scenario/index.ts`
- `packages/core/src/editor/document.ts`
- `packages/core/src/editor/narration.ts`
- `packages/core/src/editor/operations.ts`
- `apps/api/src/routes/external-narration.ts`
- `apps/api/src/services/editor-alignment.ts`
- `apps/api/src/services/vf-align-worker.ts`
- `apps/api/src/routes/editor.ts`
- `apps/web/src/lib/editor-types.ts`
- `apps/web/src/components/editor/EditorServerPanels.tsx`

Tests and fixtures:
- `tests/sync-evidence-core.test.ts` (new)
- `tests/web/editor-sync-evidence.test.tsx` (new)
- `tests/editor-alignment-preview.test.ts` (4 new blocks appended)
- `tests/external-narration-api.test.ts` (existing sidecar test now declares its audio; 3 negative cases added)
- `tests/fixtures/fake-align-runner.mjs` (test fixture only: `VF_FAKE_ALIGN_TRANSCRIPT` mode)

Docs:
- `docs/execution/milestone-3/SYNC_EVIDENCE_REPORT.md` (this file)
- `docs/execution/milestone-3/ARENA_DELIVERY.md` and `LOCAL_VERIFY_STEPS.txt` (short sections added)

Not changed: owner `data/`, `output/`, recordings, saved timings, published packages, the factory
branch `factory/m1-integrated-handoff-2026-10-13`, the `byte-range.ts` service, and the Python runner.
No dependency, manifest, or lockfile change was made in this window.

## 6. Evidence inventory

Run in `/home/user/m3-work` (clean worktree at `48d44cd`, `npm ci --ignore-scripts` completed; that is
a lockfile-only reproduction, disclosed).

| Check | Result | Label |
|---|---|---|
| Baseline, 13 affected suites, before edits | 264 / 264 passed | code-level |
| `tests/sync-evidence-core.test.ts` | 29 / 29 passed | fixture / code-level |
| `tests/external-narration-api.test.ts` | 57 / 57 passed | HTTP-level, fixture |
| `tests/editor-alignment-preview.test.ts` (fake runner) | 26 / 26 passed | HTTP-level, **fixture runner, not alignment** |
| `tests/web/editor-sync-evidence.test.tsx` | 4 / 4 passed | DOM (happy-dom), not browser |
| `tests/web/` + `editor-milestone1-ui` + `editor-contract-integration` | 125 / 125 passed | DOM and fixture |
| Broad set: 30 files (editor-*, external-*, alignment, narration-boundary*, timing-reconciliation*, user-flow-external-*, project-recording-alignment, sync-evidence-core) | 429 passed, 4 skipped, 1 failed | the failure is `external-audio-seek-browser`, see below |
| `npm run build:core` | exit 0 | build |
| `npm run typecheck` (core + web) | exit 0 | typecheck |
| API typecheck (`apps/api/tsconfig.json`) | exit 0 | typecheck |
| `npm run build:web` | exit 0 | build |

**The one failure is the blocked browser gate, not a regression.**
`tests/external-audio-seek-browser.test.ts` throws "No runnable browser … Set BUILDTRAKE_CHROME_PATH".
No Chromium is installed here. Its three tests are skipped by design, and the suite says so.

## 7. Blocked gates (honest)

- **Browser and render gate: blocked.** No Chromium and no ffmpeg/ffprobe binary (`which` returned
  nothing). Nothing was downloaded. `external-audio-seek-browser` cannot run here.
- **Independent transcript: not available.** No transcript source exists in the current runner, so
  no real alignment can reach `verified`. The `script` and `drop_last` transcript modes are fixture
  stand-ins only, and they prove the comparison rules, not speech recognition.
- **Owner recording synchronization: unproven.** It needs the owner's own recording on the owner's
  machine. No recording was requested or used.
- **Listening review and owner approval: not done.** A `verified` verdict would still need listening.

## 8. Still open from earlier M3 items (not in this work order)

- The core `gemini-contract.ts` header comment fix.
- The `cancel()` already-succeeded test.
- The `runPreview` unmount guard.
- The `planSpeech` refactor.

This window did not address the remaining items of the earlier M3 request (the full ContentPlan
workflow beyond what is already pushed, the derived-rewrite proposal, and the phase 2 and phase 3
matrices). Those are not claimed here.

## 9. Owner verification steps (no recordings, no keys needed)

1. Check out `arena/890ccb82-video-factory` at the pushed SHA. Do not touch your Windows checkout.
2. `npm ci` (or your usual install). Then run:
   - `npm run build:core && npm run typecheck`
   - `npx vitest run tests/sync-evidence-core.test.ts tests/external-narration-api.test.ts tests/editor-alignment-preview.test.ts tests/web/editor-sync-evidence.test.tsx`
3. Expected: all pass. The fake runner and fixture transcript are test-only.
4. Owner-host check (not run here): import your own narration and a `.timing.json` sidecar.
   - Without `audioSha256` and `audioDurationSec` in the sidecar, the view must show **estimated**.
   - With both declared and matching the file, it may show exact, which is still only text-match
     structural evidence.
   - Listen to the result yourself. The app does not claim that it is correct.
5. Do not treat `unverified` as a failure of the owner's audio. It means no independent transcript was
   compared.

The factory is **not** declared complete. Live Gemini planning, owner-media synchronization, and
owner acceptance remain unproven.
