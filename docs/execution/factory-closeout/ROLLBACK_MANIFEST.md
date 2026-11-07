# Rollback manifest — VF-20261106-UNIFIED-CLOSEOUT01

**Session branch:** `arena/37559090-video-factory`
**Base:** `b6637edc07617ab80776860258083ed15b40c0c2` (continuation source `review/order03-working-20261104`)
**Generated:** 2026-11-07

This manifest lists every file changed or added in this closeout session. To roll back, revert the listed files to their base state with `git checkout b6637edc -- <file>` (for modified files) or `git rm <file>` (for added files). No database migration or external state is affected; all changes are source + documentation.

## Added files

| File | Purpose |
|---|---|
| `apps/web/src/lib/capture.ts` | Pure consented capture state machine (G10) |
| `apps/web/src/components/factory/CapturePanel.tsx` | Browser capture UI panel (G10) |
| `tests/capture-state-machine.test.mjs` | PURE-CONTRACT tests for the capture state machine (18/18) |
| `docs/execution/factory-closeout/AUTHORITY_EVIDENCE_MATRIX.md` | Living G1–G12 + 11-input-row matrix (STAGE1) |
| `docs/execution/factory-closeout/ENGINE_OWNER_DECISION_SHEET.md` | Consolidated blocked-engine decision sheet |
| `docs/execution/factory-closeout/RELEASE_GUIDE.md` | Operational release guide (STAGE3) |
| `docs/execution/factory-closeout/ROLLBACK_MANIFEST.md` | This file |

## Modified files

| File | Change |
|---|---|
| `apps/web/src/pages/Assets.tsx` | Wired `CapturePanel` into the Assets page; `load` moved to `useCallback` |

## Verification

- Pure Node capture tests: **18 passed / 0 failed** (`node --experimental-transform-types --test tests/capture-state-machine.test.mjs`)
- Existing pure regression suites: draft-static 19/19, kinetic-values 20/20, numeric-label 17/17 (all unchanged, still passing)
- No npm install, provisioning, download or external engine call was performed.
- No private media, models, credentials or machine configs were committed.

## What this session did NOT do

- Did NOT render a full film or run a browser (no Chromium/Remotion in sandbox).
- Did NOT install any dependency or download any model.
- Did NOT advance `review/owner-approved` (owner review agent only).
- Did NOT merge to `main`, deploy, publish or spend.
- Did NOT close G3/G6/G7/G8 engine gates (they remain BLOCKED with decision sheets).
