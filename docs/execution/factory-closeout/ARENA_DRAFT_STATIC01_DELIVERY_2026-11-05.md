# VF-20261105-DRAFT-STATIC01 — 5 November 2026

**IMPLEMENTED / PENDING OWNER REVIEW.** Draft action provenance through Apply only; not the previously accepted values-editor repair, a renderer change or whole-G5/factory/episode acceptance.

## Identity and workspace preservation

- Branch: `arena/25f29d2c-video-factory` only.
- Implementation: `6e4c8bfae7c756d1b9a81f6e615f0a7feef25cb4`.
- Parent / required pre-edit FF base: `04f2b2a2f1348409da4333a6dbca74e38eb2e20e`; base parent `67f929172aea51ae0a15a3e3bb4dfee6bc1169cc`. Accepted owner fixes and pending Order02 retained through that exact base.
- **Recovery caveat:** arrival HEAD was again `e38c1b168c4bbca2e705f54f19637e822709c681` with restored files. Requested stash `ec022c90a084a262183b88e45634fceadc9b48a1` was absent from both refs and the object database (initial guard exit 128), still absent after fetch. This turn did not apply/drop it and cannot claim its retention or recovery.
- All **39 restored source/docs/test files** (7 tracked, 32 untracked) matched delivery `92541857347d355ec4e4447c41803bd0a5c2ea96` exactly by unfiltered Git blob hash; 34 also matched the required base, 5 matched only the delivery, 0 unknown. Explicitly scoped `git stash push --include-untracked` preserved only these paths as **`8d80b78adfe6dbbb06456b26894da56342f25a3d`**, named `VF-20261105-DRAFT-STATIC01 verified restored 9254185 sources before FF 04f2b2a`. Every saved blob was verified. This new stash is retained, not applied. No reset/clean or owner/private-file stashing.
- Then `git merge --ff-only 04f2b2a2f1348409da4333a6dbca74e38eb2e20e` completed on a clean tree, before feature edits.
- Pre-documentation remote observations: session `92541857347d355ec4e4447c41803bd0a5c2ea96`; working review `04f2b2a2f1348409da4333a6dbca74e38eb2e20e`; approved `be6f7aa4ee2f3eb81da7ecfbe4a8d27cc4ac52f8` (read-only). Installed owner checkout not inspected. Final delivery-tip SHA and remote equality are reported at handoff after push, not predicted here.

## Minimal provenance / compatibility policy

An optional **server-owned** scene field, `graphicActionsAuthored: true`, travels with an authored graphic through canonicalization, serialization, source-choice carry and Apply. It is never added to `EditorGraphic` or the final editor clip. The server derives it from a new/replaced graphic kind, an actual action-list change, existing stored provenance, or an explicit validated action-editor command. Forged server-owned flags are refused; locked rows include provenance in equality checks.

Full-scene PATCHes can echo an untouched planner `[]`. Those echoes, including value-only edits, must not disable default animation. Therefore the existing ContentPlan action callback sends optional `graphicActionsEdit: true` for a deliberate action edit ending at the *same* `[]` bytes. This is a client command requiring a valid supplied graphic, not trusted provenance; it is not persisted and is cleared after a successful save. Failed saves retain the local intent. No new screen/control or required field.

`timedGraphic` preserves authored static `[]`; otherwise legacy/default pacing is unchanged. Nonempty actions/IDs/values/times remain exact. Provenance follows the graphic on intake carry, not fresh treatment proposals or replaced source content. Language resets require confirmation for authored choices even when their graphic JSON matches the proposal, and drop old intent/provenance on reset. Locking, revision checks, idempotent Apply and atomic-write code paths were not changed.

**Legacy limit:** historical empty lists without provenance remain legacy/untimed; their lost intent cannot be guessed. An explicit action edit records static intent. No narration, source timing, default scene duration, engine, renderer, content-limit or dependency changes.

## Exact files

Production (6 files, **46 insertions / 16 deletions**):
- `packages/core/src/factory/contract.ts` — optional server provenance.
- `packages/core/src/factory/validation.ts` — canonical carry, command validation, provenance derivation, forged-flag/lock protection.
- `packages/core/src/factory/editor-mapping.ts` — provenance-aware `timedGraphic`; legacy three-argument behavior retained.
- `apps/api/src/services/factory-service.ts` — Apply forwarding, source carry and confirmed language-reset handling.
- `apps/web/src/lib/factory-api.ts` — optional response metadata/request command types.
- `apps/web/src/pages/ContentPlan.tsx` — transient intent from the existing action editor only.

Tests:
- `tests/helpers/draft-static-cases.ts` — 19 focused PURE cases.
- `tests/draft-static-source-check.mjs` — installed-Node source runner, no dependency mocks or substitute renderer.
- `tests/factory-draft-static.test.ts` — same assertions for Vitest (unexecuted through Vitest here).
- `tests/factory-intake-http.test.ts` — supplied regression unchanged; 7 added lifecycle cases (all HTTP unexecuted here).
- `tests/web/content-plan-graphic.test.tsx` — 3 added request-intent DOM cases with labelled fake transport (unexecuted).

Implementation total: **11 files, 450 insertions / 17 deletions**. Documentation: this report and `docs/execution/factory-closeout/STATUS.md`.

## Actual checks and missing gates

| Label | Actual command / result |
|---|---|
| Supplied HTTP regression | **NOT RUN here**: installed Vitest is absent. The owner's recorded PATCH200/Apply201 failure is not counted as an Arena HTTP run. |
| Before-fix PURE | `VF_DRAFT_STATIC_BEFORE=1 node --experimental-transform-types --test tests/draft-static-source-check.mjs` — **1 passed / 1 failed / 0 skipped**, exit **1**, before production edits. Actual parser/reconciler/document mapping produced the same unwanted `in-word1` / `in-word2` actions; untouched planner control passed. JSON roundtrip only, not disk/HTTP/browser evidence. |
| After-fix PURE | `node --experimental-transform-types --test tests/draft-static-source-check.mjs` — final **19 passed / 0 failed / 0 skipped**, exit **0**, installed Node **v22.22.3**. Covers explicit/new/same-empty/cleared actions, legacy echoes, all default pacings, exact nonempty actions, canonical roundtrip, forgery/lock/source-time refusals, fresh treatment/reset semantics and both formats/all existing graphic kinds. |
| Syntax only | `node --input-type=module` calling built-in `stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: path })` parsed the five changed production `.ts` files plus `tests/helpers/draft-static-cases.ts`, `tests/factory-draft-static.test.ts`, `tests/factory-intake-http.test.ts`: **8 files**, exit **0**. Type erasure is **not typechecking or TSX compilation**; experimental-feature warning expected. |
| Diff/scope | `git diff --check`, `git diff --cached --check` and protected-scope `git diff --exit-code -- packages/core/src/editor packages/video package.json package-lock.json apps/web/src/components/graphic/GraphicEditors.tsx` — exit **0**. |
| Availability | Individual `test -x node_modules/.bin/{vitest,tsx,tsc,vite}` and PATH probes found those tools absent. No install/download attempted. |
| Vitest / HTTP / DOM | **UNAVAILABLE / NOT RUN**: 8 targeted HTTP cases (owner regression + 7 new), 3 new DOM cases, and the Vitest entry for the pure cases. Route persistence/carry/reset/revision/idempotence assertions are not executed evidence yet. |
| Type/build | **UNAVAILABLE / NOT RUN**: core/API/web typechecks and TSX compilation; `npm run build:core`, `npm run typecheck`, API `tsc --noEmit`, `npm run build:web`. |
| Actual UI / renderer / owner acceptance | **NOT RUN / PENDING OWNER HOST**. No historical suite/render rerun, no static video proof or alternate project, no application/episode acceptance inferred. |

Local ignored logs: `.stills/draft-static01-checks/before-fix.log` and `after-fix.log`. No installation/provisioning, dependency/lock/runtime/model/browser downloads, new environment/service/provider/cost/access/private uploads, or owner data/output/WAV/assets/narration/timing edits in this slice. No main/approved/force/deploy operations.

## Next owner-host gate (existing environment only)

Run the supplied regression first, then only this slice's tests; these commands are **not executed here**:

```sh
./node_modules/.bin/vitest run tests/factory-intake-http.test.ts -t 'explicit static draft actions survive Apply'
./node_modules/.bin/vitest run tests/factory-draft-static.test.ts
./node_modules/.bin/vitest run tests/factory-intake-http.test.ts -t DRAFT-STATIC01
./node_modules/.bin/vitest run tests/web/content-plan-graphic.test.tsx -t DRAFT-STATIC01
```

Then affected type/build checks and actual ContentPlan action edit/save/reopen/carry/Apply review. Inspect real output: explicit static must remain static, an untouched untimed proposal must still animate, and supplied nonempty actions must keep their timing. Whole G5/Order03/factory/episodes/quality remain open.
