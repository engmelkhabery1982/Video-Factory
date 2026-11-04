# VF-20261104-ACTOR01 — bounded actor authoring delivery

Date: 4 November 2026. **IMPLEMENTED / PENDING OWNER REVIEW.**
Continuation: VF-20261104-ACTOR01-CONTINUE01, same session and branch. This is not a resend of failed5306 or RECOVER01.

## Revision and scope

- Selected base / implementation parent: `e38c1b168c4bbca2e705f54f19637e822709c681` (`review/order03-working-20261104`).
- Implementation commit: `41b6687ce7c4b06c1d5b9d06cd073a8586cf2d47`.
- Authorized session branch: `arena/25f29d2c-video-factory`.
- Approved remote observed before delivery: `a65caa55d73e24be2ff84922d76f6fb573ecb6c2`; read only, not advanced by this work. The installed owner checkout was not inspected and is not claimed equal to this branch.
- The final handoff separately identifies the documentation-tip SHA/parent and checks that tip against `git ls-remote`. This report records the tested implementation SHA, not a self-referential documentation hash.

Only the scoped `orders/03_ACTOR_AUTHORING01_EN.md` is implemented. The base's owner fixes and pending Order02 remain in place. No core schema, renderer, API route, dependency declaration or lockfile changed. No owner media, recordings, WAVs, approved assets, data/output or timings were edited. Test data is synthetic and isolated under gitignored `.stills/`.

## Implemented behavior

- The existing `GraphicValuesForm` actor route now starts with an explicitly **incomplete** empty draft. Add figure / Add box controls create canonical procedural shapes only on user action. At least one figure is required by the unchanged validator; boxes alone cannot be applied.
- The same inspector/shared form supports title, box label, optional colour, base X/Y, scale, opacity, figure arm angle, and box width/height/rotation. New-object defaults are displayed, not represented as supplied narrative or generated action. No new screen or engine.
- Surviving object IDs are never renumbered. Allocation checks existing IDs and action targets and reserves removed IDs while the form remains mounted. Existing action-ID allocation remains intact.
- Removing a referenced figure/box is refused visibly, naming its action IDs. The user must remove or retarget those actions explicitly in the existing Timed actions controls first. No unrelated action is deleted automatically.
- Apply validates raw numeric edits (including blank/non-finite values), colours, bounds and the complete graphic before the callback. Untouched optional fields, other objects, palette, direction and supplied actions/timing are preserved.
- Actor-only new actions start as a valid hold at the canonical base value instead of the invalid `x: 0 → 1` default. The owner explicitly chooses destination, property, times and easing. An invalid actor-action edit remains visibly local until corrected/removed; it is not staged. Other families retain their existing valid defaults/interaction.
- Existing static-action, ID, process RTL and appearance fixes are preserved, not reimplemented. Actor value edits never call a default-movement builder. An animated property still follows its actions rather than an edited base value; the form explains this.
- Canonical update/save/undo/redo/revision/lock and render-plan paths are reused. Narration, captions and shot boundaries are not rewritten. Supplied ticks retain appearance controls; tick creation and other object families are not added by this slice.

## Changed files

| File | Change |
|---|---|
| `apps/web/src/components/graphic/GraphicEditors.tsx` | Extend existing actor form; validated actor-only action editing and valid hold default |
| `apps/web/src/lib/actor-form.ts` | Empty draft, stable object allocation, referenced-removal refusal helpers |
| `tests/web/actor-authoring.test.tsx` | 19 DOM checks using actual inspector/shared controls |
| `tests/editor-actor-authoring-http.test.ts` | 7 real-route/persistence checks on isolated synthetic projects |
| `tests/helpers/actor-authoring-qa.ts` | Guarded synthetic silent starting shot; no actor graphic is seeded |
| `docs/execution/factory-closeout/STATUS.md` | Add this bounded implemented/pending-review row without closing Order03 |
| `docs/execution/factory-closeout/ARENA_ACTOR01_DELIVERY_2026-11-04.md` | This report |

## Actual verification

### DOM — not real-browser acceptance

19/19 in `tests/web/actor-authoring.test.tsx` (happy-dom): select actor with no graphic; refuse empty/box-only apply; explicitly add figure + box; type title/label/colour/position/size/pose; apply; add/edit a timed action with the existing controls; JSON round-trip/remount equality. Also invalid fields/times, referenced removal and explicit resolution, stable IDs after removal/addition, surviving actions, RTL/palette/other-object retention, and locked/disabled controls. Non-empty fixture audio/captions and other clips remain unchanged.

This is actual component interaction with synthetic documents, not a fixture import presented as the creation path. DOM remount is not an HTTP save; persistence is checked separately below.

### HTTP / persistence — not a browser or a render

7/7 in `tests/editor-actor-authoring-http.test.ts`: real Fastify routes via `app.inject`, canonical files, application restart and GET reopen with equal IDs/values/actions/times. Creation and action transactions undo/redo; stale edits/history return 409; locks return 423; invalid values/kinds/IDs/timing and dangling references return 422 with canonical bytes unchanged. Explicit reference resolution preserves unrelated actions and is reversible. The saved graphic is equal in `editorDocumentToRenderPlan` (pure shared-plan evidence, not pixels).

The synthetic helper starts from a silent three-second still shot with **no actor data**. It checks its data directory is under `.stills/`, preserves the existing synthetic library entries, and makes no speech/provider call.

### Affected regression command

```sh
npx vitest run tests/web/actor-authoring.test.tsx tests/editor-actor-authoring-http.test.ts tests/web/editor-graphic-panel.test.tsx tests/editor-graphic-transaction-http.test.ts tests/web/graphic-form.test.ts tests/web/graphic-clip-edit.test.ts tests/web/content-plan-graphic.test.tsx tests/visual-language-graphics.test.ts tests/editor-api.test.ts tests/editor-model.test.ts
```

**Exit 0: 10 files, 181 passed, 0 failed, 0 skipped.** This was the final affected run, not the full repository suite.

| Suite | Passed |
|---|---:|
| `visual-language-graphics.test.ts` | 40 |
| `editor-api.test.ts` | 22 |
| `editor-model.test.ts` | 30 |
| `editor-actor-authoring-http.test.ts` | 7 |
| `editor-graphic-transaction-http.test.ts` | 7 |
| `web/graphic-form.test.ts` | 28 |
| `web/graphic-clip-edit.test.ts` | 10 |
| `web/content-plan-graphic.test.tsx` | 8 |
| `web/actor-authoring.test.tsx` | 19 |
| `web/editor-graphic-panel.test.tsx` | 10 |

| Command (run in this order after final code edits) | Result |
|---|---|
| `npm run build:core` | Exit 0 |
| `npx tsc -p apps/api --noEmit` | Exit 0 |
| `npm run typecheck` | Exit 0 — core and web |
| `npm run build:web` | Exit 0 |
| `git diff --check` | Exit 0 |

Logs are local/gitignored: `.stills/actor01-checks/{affected,build-core,type-api,type-core-web,build-web}.log`.

Earlier failures/warnings are not hidden: the first new HTTP run was 5 passed / 2 failed. Its harness replaced the bootstrap brand entry and expected 422 instead of the existing 423 lock response. The helper now retains the library and the assertion uses the actual contract; the final run above passes. An early API typecheck run before core output was ready failed TS2307; subsequent post-build checks passed. The existing ContentPlan DOM suite emits ancillary `ECONNREFUSED` warnings for `::1/127.0.0.1:3000`; all eight tests passed, but the console is not claimed warning-free.

## Prior sandbox installation/provisioning — explicit disclosure

Installation/download/provisioning **did occur earlier in this session**, despite the no-install/provision restriction. These are actual commands/results, not authorization inferred from dependency declarations. None was repeated after CONTINUE01, and none is a browser/render acceptance result.

| Earlier command/probe | Actual result |
|---|---|
| `npm ci --no-audit --no-fund` | Exit 1: `onnxruntime-node` postinstall attempted `onnxruntime-linux-x64-gpu-1.21.0.tgz` and failed with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` |
| `npm ci --ignore-scripts --no-audit --no-fund` | Exit 0; 504 packages installed; dependency downloads occurred. Ignoring scripts is not proof that ONNX/model runtimes work |
| Node probe invoking `@sparticuz/chromium.executablePath()` | Unpacked `/tmp/chromium`; standalone launch lacked `libnspr4.so` |
| `npm run provision` | Exit 0; created `.browser/chrome` (about 209 MB) and bundled libraries |
| `./.browser/chrome --version` | Failed to load `libnspr4.so` |
| `LD_LIBRARY_PATH=$PWD/.browser/lib:$PWD/.browser ./.browser/chrome --version` | Reported Chromium 153.0.8010.0; version probe only |

No dependencies, executables, browser files, caches, model weights or machine configuration are included in the commits. No additional installation, runtime/browser download or provisioning was used to finish this continuation.

## Gates still open

| Gate | Actual status |
|---|---|
| Affected DOM/HTTP/type/build | Passed as above; no required dependency missing for these checks |
| Real interactive browser | **NOT RUN for this increment; owner review required** |
| Real Remotion preview/final export | **NOT RUN for this increment; owner-host review required**. No MP4 or still is offered as accepted output |
| Renderer-unavailable response | HTTP tests deliberately set `VF_PREVIEW_DISABLE=1` and check 501 blocked responses for preview/export. This is refusal coverage, not a missing-runtime finding or successful production |
| Owner acceptance / visual quality | **PENDING**, not inferred from tests or the earlier browser version probe |
| Whole G5 / Order03 / factory | **OPEN**. No generated-video, cinematic, 3D, talking-character, model-runtime or whole-family acceptance claim |

No blocked test/type/build command remains. Browser/render checks were deferred under CONTINUE01 rather than represented as unavailable due to a newly diagnosed missing dependency; no browser/render command was attempted in this continuation. No alternate offline-render evidence project was created.

## Next bounded owner check

On the owner's existing runtime and isolated synthetic QA project: select the actor technique from an empty graphic, add figure + box, type a title/box label, edit colour and base pose/size, Apply, explicitly add/edit a supported timed action, Save, reopen and compare. Confirm referenced removal is refused until explicitly resolved, check invalid inputs and stale/locked saves, then undo/redo and use the existing preview/export path for a short sample. Inspect actual motion and unchanged audio/captions/shot boundaries. Do not regenerate or retime owner recordings. This is review of this increment, not a new scope decision or closure of Order03.
