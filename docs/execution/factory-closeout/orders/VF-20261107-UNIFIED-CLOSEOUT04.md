# VF-20261107-UNIFIED-CLOSEOUT04 — corrective continuous factory assignment

**Date:** 7 November 2026
**Reviewed source:** `41b28c06f499bb97786f7d4646c4eb8062d7ef0e` (`arena/37559090-video-factory`)
**Arena execution branch in this environment:** `arena/dc133a86-video-factory` (fixed by the running session)
**Preservation:** `b235b002df4cab2237ef0a8093b1aeef225f6903` is an ancestor of the reviewed source. The clean checkout was fast-forwarded without reset, clean, forced checkout or history replacement. Required ancestors `c02bd2482b8b372324c9156982e03e120fc6b54f`, `daae482aac9de85e993599a6d010e29908ac567a`, `b6637edc07617ab80776860258083ed15b40c0c2`, and `e593883d4f82bee98b4d99b896644811c2704008` were verified.

This is a corrective continuation of UNIFIED-CLOSEOUT03, not a new product scope or a rewrite of PLAN.md. All standing instructions in START_HERE.md and orders 01–06 remain authoritative.

## Required continuous work

1. Repair the canonical `FactoryErrorCode` union and rebuild current core before interpreting API declarations.
2. Add real-route G7 safeguards with a fresh draft and uploaded/bound original per case: unknown scene (422), false original fingerprint (409 source conflict or precise validation), false result fingerprint (refuse Apply), and stale target/source after a newer binding (409 while preserving the newer binding). Validate strict mask content, dimensions and bounds. Never trust a supplied path, hash or asset id as provenance.
3. Replace the ephemeral unbounded G7 job Map with bounded, versioned, restart-safe persistence using the existing local data conventions. Add configured-runner readiness, cancellation, timeout/late-result handling, retry, idempotence, cleanup, frozen input/target/result/review fingerprints and runner/version provenance. Apply through the canonical binder and draft lock; reconcile an interrupted bind/job update without double-apply or false success.
4. Complete the existing ContentPlan/local-still workflow with mask editing, original/result comparison, review/reject/retry, explicit Apply, reopen, provenance and error states. Test doubles stay labelled and never register as a production engine. Register a runtime only if its selected interface is verified; otherwise retain a precise engine-protocol blocker while all independent code continues.
5. Close the G10 completed-capture phase defect synchronously before any browser API call. A completed/uploading capture requires explicit discard/coherent transition. Preserve the four reviewed capture regressions, capability gating, per-capture confirmation and complete native/timer/listener/generation cleanup.
6. Repair only the test-harness defects: query absence directly after discard, hold Stop for two same-batch clicks or assert stopped state, use fresh G7 drafts/current revisions and assert HTTP status before body fields. Do not weaken wrong-revision, source, hash or scene checks.
7. Re-audit every G1–G12, input and visual-family row after these fixes. Implement remaining independent code in existing routes/editor/services; do not convert missing implementation into an engine-only gate. Keep real engine, browser, rendered-output, listening and owner-acceptance evidence separate.
8. Run affected native/component/HTTP/restart/fault checks available with installed tools; run current core/web/API typechecks and production builds when available. No dependency install, provisioning, model download, provider call, real capture, owner data/output change or historical full render.
9. Deliver one versioned release/rollback/recovery package with full SHAs, changed paths, actual results/NOT RUN, finite owner-host checklist and precise remaining code/runtime/resource gates. Arena does not grant owner acceptance or claim full G1–G12 closure.

## Execution rule

A blocked item records its exact code/route, dependency, verified part, environment reason and smallest executable host follow-up; independent work continues immediately. No destructive Git operation, force push, main merge, deploy, publish, spend, account/provider/runtime/dependency/browser/model addition or unrelated owner-fix removal is authorized.
