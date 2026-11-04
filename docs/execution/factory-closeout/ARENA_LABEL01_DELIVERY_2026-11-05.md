# VF-20261105-LABEL01 — actor-box label fit

5 November 2026 (Asia/Riyadh). **IMPLEMENTED / PENDING OWNER REVIEW.** New bounded Order03/G5 slice; ACTOR01 and the owner default-position fix are preserved, not repeated.

## Revisions
- Fetched `review/order03-working-20261104` and merged **--ff-only** to the requested base before editing: `b0ac8f49d30ea64637a9b13dffb552a882806c66`.
- Implementation: `84e1e148eab8969474bd15ff5a5c2fc5d35b2be1`; parent: `b0ac8f49d30ea64637a9b13dffb552a882806c66`.
- Session branch: `arena/25f29d2c-video-factory`. The final handoff records the following documentation-tip SHA/parent and verifies remote equality.
- Approved remote observed: `a2f5e69b1a31bb19d9ba8a331e07080381af619a` (read only). Installed owner SHA was not inspected; no equality claim. Pending Order02 and all selected-base owner fixes remain intact.

## Bounded change
One pure layout helper is used by the existing SVG and the existing inspector. It preserves exact substrings, including leading/trailing/repeated spaces, decomposed marks, Arabic diacritics and grapheme clusters. Wrapping prefers word boundaries; unbroken identifiers wrap at grapheme boundaries. Nothing is trimmed, normalised, reversed or truncated.

Font fitting uses the existing preferred size as an upper bound, padding on both axes and bounded deterministic search, **without an 8px floor**. SVG `textLength` / `lengthAdjust` bound line advances in the chosen existing font; `xml:space`, preformatted whitespace and bidi isolation retain spaces and RTL. No clipping mask or geometry adjustment hides overflow. This is the same scene body used by preview/export, not an alternative renderer.

The inspector uses the same layout with the existing scene safe area, pending box dimensions and the smallest base/animated scale. It warns below **2% of graphic height** (an advisory, not a phone-readability guarantee): enlarge the box or shorten the label. The warning is a separate note, never a validation failure or automatic edit. The 40-character maximum, box geometry, IDs, direction, actions/times, palette and other objects are unchanged. Other graphic families keep their existing font-fitting behavior.

## Exact LABEL01 changed files
- `packages/video/src/graphics/actorBoxLabelLayout.ts` — pure fitting/wrapping and readability helper.
- `packages/video/src/graphics/ProceduralGraphicSvg.tsx` — fitted actor-box tspans in the existing renderer.
- `apps/web/src/components/graphic/GraphicEditors.tsx` — non-blocking inspector note using current draft values.
- `tests/actor-box-label-layout.test.ts` — pure geometry, grapheme and text-preservation checks.
- `tests/web/actor-box-label.test.tsx` — SVG markup / happy-dom inspector regressions.
- `tests/editor-actor-authoring-http.test.ts` — additional LABEL01 verbatim save/reopen regression.
- `docs/execution/factory-closeout/STATUS.md` — bounded pending-review ledger row.
- `docs/execution/factory-closeout/ARENA_LABEL01_DELIVERY_2026-11-05.md` — this report.

## Actual checks
**Final: 9 files, 155 passed, 0 failed, 0 skipped; exit 0.** Focused group only, not a full historical suite.

```sh
./node_modules/.bin/vitest run tests/actor-box-label-layout.test.ts tests/web/actor-box-label.test.tsx tests/editor-actor-authoring-http.test.ts tests/web/actor-authoring.test.tsx tests/web/editor-graphic-panel.test.tsx tests/graphic-scene-identity.test.tsx tests/visual-language-graphics.test.ts tests/web/graphic-form.test.ts tests/editor-graphic-transaction-http.test.ts
```

Evidence labels/counts:
- **PURE 22**: 40-character English/Arabic, long identifiers, spaces/NBSP, decomposed Latin/Arabic marks, ZWJ clusters, narrow/short/extreme boxes, scales 0.2/0.75/1/3, both formats, finite padded line geometry and deterministic output. These assert calculated line bounds, not measured font-pixel bounds.
- **SVG MARKUP / DOM 13**: exact concatenated SVG text and RTL attributes; scaled/rotated geometry and actions unchanged; warning updates before Apply, does not stage edits or block valid Apply; existing 40-character validation still rejects 41. Static markup/happy-dom is not a real browser render.
- **HTTP 8** in the actor suite, including **one new LABEL01 case**: exact allowed labels save/reopen in tiny boxes with equal geometry/direction/actions/timing and shared render-plan data. Real `app.inject` routes on isolated synthetic data; no render is started.
- **Existing affected regressions 112**: actor authoring/default positions 20, inspector 10, scene identity/kinetic markup 7, graphic validator/evaluator 40, forms/static/RTL 28, canonical graphic HTTP 7.

All following commands exited **0**, using installed tools only:
```sh
npm run build:core
./node_modules/.bin/tsc -p apps/api --noEmit
npm run typecheck
./node_modules/.bin/tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution Bundler --jsx react-jsx --esModuleInterop --skipLibCheck packages/video/src/graphics/ProceduralGraphicSvg.tsx
npm run build:web
git diff --check
```

The regression run emitted an existing duplicate `fontFamily` warning in untouched `packages/video/src/scenes/Explanations.tsx`; no unrelated cleanup was made. Local logs: gitignored `.stills/label01-checks/`. The aggregate pre-push whitespace check also flagged an inherited blank line at EOF in owner `PLAN.md`; that file is identical to the requested base and was preserved. The LABEL01-only `git diff --check b0ac8f49d30ea64637a9b13dffb552a882806c66 HEAD` passes.

## Constraints and unresolved gates
**No install/ci/provision command, dependency change, browser/model/runtime/executable download, new service or provider call occurred in LABEL01.** The only fetch was repository source for the requested base / Git synchronization. No owner data/output/WAV/assets/timing changes, private uploads, alternate offline-video project or image/video acceptance artifact.

No test/type/build gate above was unavailable. **Real browser, actual Remotion preview/final export, font-pixel/Arabic visual quality and owner acceptance were not run here and remain owner-host gates**, as ordered. The deliberate 501 refusal checks in the reused HTTP suite are not render evidence. Tiny boxes may still require unreadably small text; the warning makes that limitation explicit rather than changing the content limits.

Next bounded owner review: use long English/Arabic labels, marked text, repeated spaces and one unbroken identifier in narrow/short boxes at small and large scale in both formats. Check actual preview/export glyphs and RTL, the inspector note, and unchanged canonical text/geometry/actions/times. Whole G5/Order03/factory/episode acceptance stays open.
