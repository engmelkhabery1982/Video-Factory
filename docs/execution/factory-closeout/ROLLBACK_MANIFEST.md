# Rollback manifest — VF-20261107-UNIFIED-CLOSEOUT03

**Session branch:** `arena/37559090-video-factory`
**Base:** `f789a222516863f4795b8d727b12a5d7042bf370` (continuation source)
**Independently verified source:** `b3e32104eeb3f5c5e38e322197581fb5e2d4c391`
**Generated:** 2026-11-07

This manifest lists every file changed or added in this corrective continuation session. To roll back, revert the listed files to their base state with `git checkout f789a22 -- <file>` (for modified files) or `git rm <file>` (for added files). No database migration or external state is affected; all changes are source + documentation.

## Added files (this session)

| File | Purpose |
|---|---|
| `apps/api/src/services/masked-correction.ts` | G7 masked/regional correction contract — job/provenance/review/apply with original preservation; mock runner for tests; injectable real runner |
| `tests/factory-masked-correction-pure.test.mjs` | 27 pure-contract tests for G7 masked correction (job lifecycle, review, apply, error cases, provenance, original preservation) |
| `tests/factory-masked-correction.test.ts` | HTTP integration test for G7 (vitest, owner-host) |
| `tests/web/capture-panel.test.tsx` | Component tests for CapturePanel with browser-API doubles (NOT RUN here; requires vitest/happy-dom) |

## Modified files (this session)

| File | Change |
|---|---|
| `apps/api/src/routes/factory.ts` | Added 5 G7 routes: POST/GET `/api/factory/drafts/:draftId/masked-corrections`, GET `/api/factory/masked-corrections/:jobId`, POST `/api/factory/masked-corrections/:jobId/review`, POST `/api/factory/masked-corrections/:jobId/apply` |
| `apps/web/src/components/factory/CapturePanel.tsx` | Fixed import paths (`../../lib/api`, `../../lib/capture`, `../ui`); removed unused `classifyMediaError`; added `captureTokenRef`/`mountedRef` for lifecycle guards; idempotent cleanup on unmount/cancel/error; `screen_audio` route with audio-absence detection; `MediaRecorder` capability check; discard button for failed uploads; `startingRef`/`uploadingRef` synchronous locks; `upload_failed` phase for retry |
| `apps/web/src/lib/capture.ts` | Added `hasAudioTrack()` helper; added `upload_failed` phase and `captureUploadRetry` |
| `tests/capture-state-machine.test.mjs` | 30 pure tests: lifecycle guards, error classification, upload payload rules, `hasAudioTrack`, `upload_failed` phase, synchronous locks |
| `docs/execution/factory-closeout/AUTHORITY_EVIDENCE_MATRIX.md` | G7 row updated to IMPLEMENTED (contract) / BLOCKED (engine); G10/G11 rows updated; G11 audit completed (no code gaps) |
| `docs/execution/factory-closeout/ENGINE_OWNER_DECISION_SHEET.md` | Inpainting row: exact upstream metadata (SHA256 `c6bbc15e...`, size 4,265,437,280 bytes, CreativeML Open RAIL-M); video row: official 10.5 GB BF16 (not estimate); TTS row: RTF clarified as model card claim; summary table updated |
| `docs/execution/factory-closeout/RELEASE_GUIDE.md` | Engine readiness table adds masked correction row; licence section adds SD inpainting SHA256/size |
| `docs/execution/factory-closeout/STATUS.md` | Added VF-20261107-UNIFIED-CLOSEOUT03 continuation entry |
| `docs/execution/factory-closeout/ROLLBACK_MANIFEST.md` | This file (updated for VF-20261107-CLOSEOUT03) |

## Verification

- Pure Node capture tests: **30 passed / 0 failed** (`node --experimental-transform-types --test tests/capture-state-machine.test.mjs`)
- Pure Node G7 masked-correction tests: **27 passed / 0 failed** (`node --experimental-transform-types --test tests/factory-masked-correction-pure.test.mjs`)
- Combined pure suite: **113 passed / 0 failed** (capture 30 + masked-correction 27 + draft-static 19 + kinetic 20 + numeric 17)
- Existing pure regression suites: draft-static 19/19, kinetic-values 20/20, numeric-label 17/17 (all unchanged, still passing)
- Component test files (`tests/web/capture-panel.test.tsx`, `tests/factory-masked-correction.test.ts`): written but NOT RUN here (requires vitest/happy-dom; owner-host gate)
- No npm install, provisioning, download or external engine call was performed.
- No private media, models, credentials or machine configs were committed.

## What this session did NOT do

- Did NOT run vitest component tests (vitest not installed in sandbox).
- Did NOT run typecheck (TypeScript compiler not installed in sandbox; import paths verified by file existence + manual inspection).
- Did NOT render a full film or run a browser (no Chromium/Remotion in sandbox).
- Did NOT install any dependency or download any model.
- Did NOT advance `review/owner-approved` (owner review agent only).
- Did NOT merge to `main`, deploy, publish or spend.
- Did NOT close G3/G6/G7/G8 engine gates (they remain BLOCKED with completed decision sheets). G7 contract implemented; inpainting engine runner NOT RUN.
