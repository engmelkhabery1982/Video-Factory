# Rollback manifest — VF-20261107-UNIFIED-CLOSEOUT02

**Session branch:** `arena/37559090-video-factory`
**Base:** `f789a222516863f4795b8d727b12a5d7042bf370` (continuation source)
**Capture fix commit:** `a12f006cdec9384fff24d3fbe1a3848f212f8029`
**Generated:** 2026-11-07

This manifest lists every file changed or added in this corrective continuation session. To roll back, revert the listed files to their base state with `git checkout f789a22 -- <file>` (for modified files) or `git rm <file>` (for added files). No database migration or external state is affected; all changes are source + documentation.

## Added files (this session)

| File | Purpose |
|---|---|
| `tests/web/capture-panel.test.tsx` | Component tests for CapturePanel with browser-API doubles (NOT RUN here; requires vitest/happy-dom) |

## Modified files (this session)

| File | Change |
|---|---|
| `apps/web/src/components/factory/CapturePanel.tsx` | Fixed import paths (`../../lib/api`, `../../lib/capture`, `../ui`); removed unused `classifyMediaError`; added `captureTokenRef`/`mountedRef` for lifecycle guards; idempotent cleanup on unmount/cancel/error; `screen_audio` route with audio-absence detection; `MediaRecorder` capability check; discard button for failed uploads |
| `apps/web/src/lib/capture.ts` | Added `hasAudioTrack()` helper for testable audio-track detection |
| `tests/capture-state-machine.test.mjs` | Added 9 pure tests: `hasAudioTrack` (3), lifecycle guards (`captureStart` from stopping/processing, re-entry from error, no-op transitions, `captureStop` from stopping) |
| `docs/execution/factory-closeout/AUTHORITY_EVIDENCE_MATRIX.md` | Updated base to `f789a22`; updated G1/G2/G4/G5/G6/G7/G8/G9/G10/G11/G12 rows with current status and decision sheet references |
| `docs/execution/factory-closeout/ENGINE_OWNER_DECISION_SHEET.md` | Completed all TBD rows with precise candidate metadata (Wan2.2-TI2V-5B, Blender+Cycles, SILMA TTS, whisper.cpp); updated summary table |
| `docs/execution/factory-closeout/RELEASE_GUIDE.md` | Updated capture description, engine readiness table with candidate names, and known limits |
| `docs/execution/factory-closeout/ROLLBACK_MANIFEST.md` | This file (updated for VF-20261107) |

## Verification

- Pure Node capture tests: **27 passed / 0 failed** (`node --experimental-transform-types --test tests/capture-state-machine.test.mjs`)
- Existing pure regression suites: draft-static 19/19, kinetic-values 20/20, numeric-label 17/17 (all unchanged, still passing)
- Component test file (`tests/web/capture-panel.test.tsx`): written but NOT RUN here (requires vitest/happy-dom; owner-host gate)
- No npm install, provisioning, download or external engine call was performed.
- No private media, models, credentials or machine configs were committed.

## What this session did NOT do

- Did NOT run vitest component tests (vitest not installed in sandbox).
- Did NOT run typecheck (TypeScript compiler not installed in sandbox; import paths verified by file existence + manual inspection).
- Did NOT render a full film or run a browser (no Chromium/Remotion in sandbox).
- Did NOT install any dependency or download any model.
- Did NOT advance `review/owner-approved` (owner review agent only).
- Did NOT merge to `main`, deploy, publish or spend.
- Did NOT close G3/G6/G7/G8 engine gates (they remain BLOCKED with completed decision sheets).
