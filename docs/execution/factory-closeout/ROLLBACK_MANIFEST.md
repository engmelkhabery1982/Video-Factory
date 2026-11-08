# Rollback manifest — VF-20261107-UNIFIED-CLOSEOUT04

**Fixed session branch:** `arena/dc133a86-video-factory`
**Provisioned ancestor:** `b235b002df4cab2237ef0a8093b1aeef225f6903`
**Pre-edit reviewed source / rollback comparison base:** `41b28c06f499bb97786f7d4646c4eb8062d7ef0e`
**Accepted authority preserved:** `daae482aac9de85e993599a6d010e29908ac567a`
**Generated:** 2026-11-07

This is a source/data-recovery manifest, not owner acceptance or a deployment record. Resolve the delivery commit with `git rev-parse HEAD` on the reviewed session branch; the final Arena handoff reports that full SHA. This file cannot truthfully embed its own final commit hash before that commit exists.

## Safe rollback procedure

1. Preserve and review any newer work first: `git status --short`, `git log --oneline 41b28c06f499bb97786f7d4646c4eb8062d7ef0e..HEAD`, and `git diff --stat 41b28c06f499bb97786f7d4646c4eb8062d7ef0e..HEAD`.
2. Prefer a new reviewed `git revert <explicit-closeout04-commit-sha>` commit. Revert every dependent CLOSEOUT04 commit in reverse order if more than one is present. Do not reset, clean, force-push or overwrite a newer branch.
3. If a file-level rollback is necessary, perform it only in a separate clean disposable worktree/copy after comparing the file list below. Do not restore an old whole tree over unknown or owner work.
4. Source rollback does NOT delete masked-job JSON, imported assets, captures, drafts, renders or backups. CLOSEOUT04 registered no production runner. CLOSEOUT05 adds opt-in registration code but ran no production engine/model here; stop the server before source rollback and separately disable the host launch configuration if present. Never delete the owner's model as part of source rollback.
5. If data restoration is separately required, stop the server and use `scripts/factory-data-recovery.mjs` only into an absent/empty destination. Verify first; never replace a live nonempty owner directory. See `RELEASE_GUIDE.md` §7.

## Modified source and test paths

| Path | CLOSEOUT04 purpose |
|---|---|
| `apps/api/src/routes/factory.ts` | G7 create/list/get/readiness/cancel/retry/review/apply/delete routes with correct statuses |
| `apps/api/src/server.ts` | Masked-job startup recovery during app construction |
| `apps/api/src/services/factory-service.ts` | Verified image bytes/path/type/dimensions, canonical masked target fingerprints, same-lock Apply marker, shot-list bound facts |
| `apps/api/src/services/masked-correction.ts` | Replaced permissive ephemeral contract with bounded durable jobs, strict result verification, lifecycle/review/Apply/recovery and labelled test seams |
| `apps/web/src/components/factory/CapturePanel.tsx` | Canonical phase guard before browser APIs, retained-capture controls, capability consistency and complete owned-resource cleanup |
| `apps/web/src/lib/capture.ts` | Direct-start restriction and retained-capture/upload phase protections |
| `apps/web/src/lib/factory-api.ts` | Canonical shot-list facts and typed masked-correction HTTP client |
| `apps/web/src/pages/ContentPlan.tsx` | Existing workflow integration and production dependency injection for the masked panel |
| `packages/core/src/factory/contract.ts` | Required `FACTORY_MASKED_CORRECTION_NOT_FOUND` and `FACTORY_RUNNER_NOT_SET` error codes |
| `tests/capture-state-machine.test.mjs` | 31 PURE capture phase/retention cases |
| `tests/factory-masked-correction-pure.test.mjs` | 27 strict canonical mask/fingerprint/resource-limit PURE cases; old permissive stubs removed |
| `tests/factory-masked-correction.test.ts` | 22 real-route/real-store cases with fresh drafts/current revisions, owned PNGs and labelled mock runner; NOT RUN here |
| `tests/web/capture-panel.test.tsx` | 29 browser-API-double component cases; harness defects repaired and new retained-capture regressions; NOT RUN here |

## Added source, recovery and test paths

| Path | Purpose |
|---|---|
| `apps/api/src/services/masked-correction-contract.ts` | Dependency-light strict mask v1 parser/canonicalizer/fingerprint and finite limits |
| `apps/web/src/components/factory/MaskedCorrectionPanel.tsx` | Current-scene mask/instruction/comparison/review/reject/retry/Apply/reopen/provenance/error UI |
| `apps/web/src/lib/masked-correction.ts` | Browser-only integer/pixel-mask assembly; server still revalidates |
| `scripts/factory-data-recovery.mjs` | Offline hash-manifest backup/verify/non-merging restore, no dependencies/network |
| `tests/factory-data-recovery.test.mjs` | 8 executed disposable-file recovery/CLI cases |
| `tests/masked-correction-ui-pure.test.mjs` | 6 executed browser-mask/server-parser PURE cases |
| `tests/web/masked-correction-panel.test.tsx` | 9 labelled-client component cases, including Apply reconciliation; NOT RUN here |
| `docs/execution/factory-closeout/orders/VF-20261107-UNIFIED-CLOSEOUT04.md` | Saved corrective assignment and scope limits |
| `docs/execution/factory-closeout/ARENA_UNIFIED_CLOSEOUT04_DELIVERY_2026-11-07.md` | Consolidated evidence/handoff report |

## Modified evidence/release paths

- `docs/execution/factory-closeout/AUTHORITY_EVIDENCE_MATRIX.md`
- `docs/execution/factory-closeout/ENGINE_OWNER_DECISION_SHEET.md`
- `docs/execution/factory-closeout/RELEASE_GUIDE.md`
- `docs/execution/factory-closeout/STATUS.md`
- `docs/execution/factory-closeout/ROLLBACK_MANIFEST.md` (this file)
- `docs/execution/factory-closeout/ARENA_UNIFIED_CLOSEOUT04_DELIVERY_2026-11-07.md`

No dependency manifest/lockfile, renderer, owner media/timing, private output, credential, model or machine configuration was changed. Generated backup/test directories are outside Git and disposable.

## Verification boundary

Executed locally with installed Node only: capture **31/31**, strict masked contract **27/27**, browser-mask PURE **6/6**, recovery/CLI **8/8**; combined **72/72**. TypeScript/TSX typechecks, Vite build, Vitest real-route/component suites, real browser capture, real inpainting and rendered output are **NOT RUN**. Exact commands and finite owner-host follow-up are in the delivery report.

No reset/clean/force-push, dependency install, provisioning/download, provider call/spend, real owner capture, deployment/publish/main merge, owner-media/output modification or owner acceptance occurred.

## CLOSEOUT05 additive package — 2026-11-08

**Arena-fixed branch:** `arena/da9e43e6-video-factory` (the requested `arena/dc133a86-video-factory` source tip was preserved by fast-forward, but Arena requires this different session branch).
**Exact comparison base:** `59089ab47c943245909bcf673c4e2d468942d002`.

New paths:

- `apps/api/src/services/masked-correction-sd-cli-contract.ts` — verified sd-cli flags/artifact pins, exact grayscale mask PNG and argv protocol.
- `apps/api/src/services/masked-correction-sd-cli.ts` — opt-in configuration/probe/registration, frozen-input child lifecycle, canonical run-specific result import and scratch cleanup.
- `tests/masked-correction-sd-cli-contract.test.mjs` — 9 executed PURE protocol cases.
- `docs/execution/factory-closeout/ARENA_UNIFIED_CLOSEOUT05_DELIVERY_2026-11-08.md` — consolidated evidence and finite host checklist.

Modified paths:

- `apps/api/src/server.ts` — opt-in adapter registration during app construction after masked-job recovery.
- `apps/api/src/services/masked-correction.ts` — setup diagnostics, exact adapter readiness and unchanged-result refusal.
- `apps/web/src/lib/factory-api.ts` — typed setup diagnostics.
- `apps/web/src/components/factory/MaskedCorrectionPanel.tsx` — complete setup-missing display.
- `apps/web/src/components/factory/CapturePanel.tsx` — non-autoplay captured audio/video review and object-URL cleanup.
- `tests/factory-masked-correction.test.ts` — unchanged-byte refusal plus fake-CLI registration/import/Apply/cancel/corrupt/missing-flag cases (28 real-route cases total; NOT RUN here).
- `tests/web/capture-panel.test.tsx` — 32 browser-API/object-URL-double component cases total; NOT RUN here.
- `tests/web/masked-correction-panel.test.tsx` — readiness fixture compatibility.
- `tests/fixtures/fake-sd-cli.mjs` — labelled help-double coverage for the verified inpainting flags; no generation behavior or real-engine claim.
- `docs/execution/factory-closeout/{AUTHORITY_EVIDENCE_MATRIX.md,ENGINE_OWNER_DECISION_SHEET.md,RELEASE_GUIDE.md,ROLLBACK_MANIFEST.md,STATUS.md,PLAN.md}` — reconciled implementation/evidence/recovery state.

To roll back only CLOSEOUT05, preserve newer work and create a reviewed revert of its explicit delivery commit. Do not reset or restore old files over unknown work. Reverting source does not remove any already imported canonical result, job, capture, draft, model or backup. Dedicated `sd-cli/work` scratch is disposable; imported results under `DATA_DIR/assets` are not scratch and must not be deleted by rollback.
