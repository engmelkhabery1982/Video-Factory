# VF-20261105-NUMERIC-LABEL01 — 5 November 2026

**IMPLEMENTED / PENDING OWNER REVIEW.** Bounded numeric text containment in the existing Order03/G5 SVG and inspector. No whole-G5/Order03/factory/episode or visual-quality acceptance claim.

## Identity and scope

- Session branch: `arena/25f29d2c-video-factory` only.
- Implementation: `250573db057c2278beb42877433ecbce39471033`.
- Implementation parent / required pre-edit FF base: `6e16f2f5c7969890c743638d1030b8d639935893` (base parent `980f1e8aafb9ef5e64a4cc853df544208337af10`).
- Prior delivered `9c2dae67ca785f53f34986a769e7ed5eca5761f8`, accepted LABEL01/owner English-punctuation fix and pending Order02 retained. The restored, byte-identical old delivery files were preserved in local stash `c74a243b58dc721f3a0bda467fbbad733eb3e2b5` before the FF, not reapplied over the accepted tree.
- Remote observations before documentation: session `9c2dae67ca785f53f34986a769e7ed5eca5761f8`; working review `6e16f2f5c7969890c743638d1030b8d639935893`; approved `b16077bb4216a88b7fcec223af0239be27fbf653`. Installed owner checkout **not inspected**; do not infer equality. Final delivery-tip SHA and `ls-remote` equality are reported after the documentation commit/push, not predicted here.

## Implementation

Pairwise midpoint separators allocate disjoint per-bar text cells on the appropriate X/Y axis, including valid bars sharing X. Regions stay inside the frame, remain centred on the saved bar X, and reserve the existing title band. Category/value text uses the accepted grapheme-preserving wrap/fit helper, with its actor default and owner bidi behavior unchanged. SVG tspans preserve whitespace and exact `exactValueLabel` output, with bounded horizontal advances; no truncation, number rounding or validator/count-limit changes.

Bar rectangles, canonical positions/values/decimals/units/scaleMax/IDs/order, static or supplied actions and times are not rewritten. Only text placement is clamped when space above a bar is insufficient. The numeric inspector shows a separate, nonblocking small-text note using the same safe-frame/layout calculation. Numeric form seeding now reuses the exact formatter rather than a potentially rounding `toFixed`; Apply patches saved objects by their existing IDs instead of rebuilding their geometry/defaults. Removing a referenced row retains its actions and is refused by unchanged canonical validation rather than silently deleting them.

### Exact files in this increment

Production:
- `packages/video/src/graphics/numericLabelLayout.ts` — pure cell/region layout and advisory.
- `packages/video/src/graphics/actorBoxLabelLayout.ts` — optional preferred size; unchanged actor default/bidi.
- `packages/video/src/graphics/ProceduralGraphicSvg.tsx` — numeric bounded tspans only; existing bar geometry and other-family branches retained.
- `apps/web/src/lib/graphic-form.ts` — exact numeric seeding and ID-preserving numeric patch helper.
- `apps/web/src/components/graphic/GraphicEditors.tsx` — existing numeric form advisory/Apply integration.

Tests:
- `tests/helpers/numeric-label-cases.ts` — shared actual-source PURE assertions/synthetic values.
- `tests/numeric-label-source-check.mjs` — installed Node built-in runner/TS source resolution; no substitute renderer or dependency mocks.
- `tests/numeric-label-layout.test.ts` — same assertions for Vitest.
- `tests/web/numeric-label.test.tsx` — four SVG-markup and two inspector-DOM regressions, **not executed here**.
- `tests/editor-graphic-transaction-http.test.ts` — one added exact numeric save/reopen regression, **not executed here**.

Documentation: this report and `docs/execution/factory-closeout/STATUS.md`. Implementation diff: **10 files, 450 insertions / 14 deletions**. No dependency/lock/core-validator changes, private assets or generated media.

## Actual checks and unavailable gates

| Evidence | Exact action / result |
|---|---|
| PURE, actual source | `node --experimental-transform-types --test tests/numeric-label-source-check.mjs` — Node **v22.22.3**, final **17 passed, 0 failed, 0 skipped**, exit **0**. Built-in TS transformation is **not a typecheck**. |
| PURE coverage | First assertion demonstrates the old fixed-font overflow risk using conservative advance estimates and validator-accepted data, not measured pixels. Then exact text/grapheme boundaries, finite padded containment, disjoint regions, both formats/directions, 6 landscape/4 portrait bars, minimum X/Y spacing, frame edges/title-band fallback, animated progress/opacity, exact decimals/units, static/supplied actions and unchanged actor/kinetic/process behavior. |
| Initial test correction | First run: **12/15 passed, 3 failed** because the tests incorrectly demanded a tiny-text warning for every long landscape chart. Corrected to assert the actual layout threshold and use genuinely tiny frame-edge geometry for mandatory-warning checks; no fitting threshold or validator was weakened. Intermediate 15/15 and final expanded 17/17 passed. |
| Whitespace/scope | `git diff --check` and `git diff --cached --check` — exit **0** for this increment. Dependency/core diff and outgoing filename checks are separate from runtime tests. |
| Availability probes | `test -x node_modules/.bin/{vitest,tsc,vite,tsx}` individually: all **absent**. PATH lookup found Node/npm, not those executables. No install/download attempted. |
| Vitest / SVG markup / DOM / HTTP | **UNAVAILABLE / NOT RUN**, not passed. The new markup/DOM and HTTP assertions have no execution evidence on this host. No happy-dom result is presented as a browser render. |
| Type/build | **UNAVAILABLE / NOT RUN**: core/API/web typechecks, TSX compilation, `npm run build:core`, `npm run typecheck`, `npm run build:web`; installed tsc/Vite/workspace dependencies are absent. Historical LABEL01 green results are not evidence for this increment. |
| Browser / Remotion / owner quality | **NOT RUN / PENDING OWNER HOST**. No preview server, browser provisioning, alternate offline-video project, still/MP4 proof or historical audio/render rerun. |

Pre-push aggregate whitespace check (`git diff --check 9c2dae67ca785f53f34986a769e7ed5eca5761f8 HEAD`) stopped before push with exit **2** on inherited `PLAN.md:74` blank EOF. Its blob is byte-identical to required base `6e16f2f`; numeric-only `git diff --check 6e16f2f5c7969890c743638d1030b8d639935893 HEAD` is **0**. The base-only diff also flags the old `STATUS.md:132` blank EOF; appending this ledger entry makes that an interior blank, not a new numeric issue. Owner PLAN was preserved; final push checks allow only this exact verified inherited warning, not new whitespace failures.

Affected Vitest command for the existing owner environment (**not run here**):

```sh
./node_modules/.bin/vitest run tests/numeric-label-layout.test.ts tests/web/numeric-label.test.tsx tests/editor-graphic-transaction-http.test.ts tests/visual-language-graphics.test.ts tests/graphic-scene-identity.test.tsx tests/web/graphic-form.test.ts tests/web/editor-graphic-panel.test.tsx tests/actor-box-label-layout.test.ts tests/web/actor-box-label.test.tsx
```

Pure-run log is local/ignored: `.stills/numeric-label01-checks/pure.log`. No installations, provisioning, providers, new services, spending, permissions expansion, media/data/output/WAV/timing edits, deploy, force-push or approved/main advancement occurred in this slice. The previous ACTOR01 provisioning breach remains a breach, not authorization.

## Remaining owner gate

Run the affected dependency-based tests/type/build checks on the existing owner environment, then actual numeric UI edit/save/reopen and shared preview/export in landscape/portrait and LTR/RTL. Inspect long categories, Arabic marks, exact long values/units and animation at minimum spacing; confirm accepted actor punctuation remains correct. This is the next bounded review, not a request for a new scope decision or permission to install here.

Calculated padded line boxes / SVG advances are not measured font-ink bounds or rendered acceptance. Extremely constrained text can be tiny despite exact containment; the advisory does not guarantee phone readability. Existing overlapping/off-frame bar geometry is not automatically repaired. Whole G5/G6/G7, Order03, factory, episodes and quality remain open.
