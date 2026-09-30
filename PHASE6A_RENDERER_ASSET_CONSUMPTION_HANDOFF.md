# Phase 6A — Parallel Track B: Remotion Renderer Asset Consumption Handoff

## Branch Safety / Baseline

- **Approved Phase 5 baseline**: `d7062a37864e5db5e4810e90ce10931ae9d7ce73` — confirmed on `origin` before any edit (`git rev-parse --verify d7062a3…^{commit}` → exists; `git log --oneline -1` → `d7062a3 docs(closure): correct phase5 closure history metadata`).
- **Branch**: `freebuff/phase6a-renderer-assets`, created directly from the approved baseline (`git checkout -b freebuff/phase6a-renderer-assets d7062a37864e5db5e4810e90ce10931ae9d7ce73`).
- **`git rev-parse HEAD` immediately after creation**: `d7062a37864e5db5e4810e90ce10931ae9d7ce73` (equals approved baseline).
- **Working tree before first edit**: clean (`git status --porcelain` empty).
- Not on `main`, not on `arena/01a0eeb0-video-factory`. No branch with this name existed at creation time. No force push, no history rewrite, no merges.
- **Parallel file ownership respected**: only the three permitted paths were modified/added (see Files). Core scenario modules, `apps/api/**`, Phase 5 handoffs/contracts, and the future Core asset resolver were never touched.

## Implementation Commits / HEAD

- `82c1771` — `feat(video): consume resolved production asset media map`
- `22e3412` — `test(video): cover production asset renderer wiring`
- Final HEAD after docs commit: recorded in the **Resulting HEAD** section below (self-reference inside a commit of itself is impossible by construction; this section is updated by the docs commit).

## Files Changed

| File | Change |
| --- | --- |
| `packages/video/src/compositions/VideoCompositionPlan.tsx` | Added exported pure helper `resolveSceneMediaUrl(scene, mediaMap?)`; destructured `mediaMap` from props; per-scene `mediaUrl={resolveSceneMediaUrl(scene, mediaMap)}` passed to `PlanSceneRenderer` inside the existing `<Sequence>` placement. Import of `RemotionSceneCompositionSpec` added for the helper's parameter type. |
| `packages/video/src/scenes/PlanSceneRenderer.tsx` | Replaced meaningless expression `mediaUrl ?? (scene.assetRefs[0]?.assetRef ? null : null)` with `mediaUrl ?? null` (clean propagation into the already-supporting `SceneRenderer`). One line. |
| `tests/phase6a-renderer-assets.test.ts` | New focused test file (15 tests, 2 describes). |

No other files changed. No dependencies added. `SceneRenderer.tsx` untouched (already supports `mediaUrl` → `Background` / `Explanation`).

## mediaMap Semantics (contract consumed, not defined)

```ts
mediaMap?: Record<string, string>  // Record<logicalAssetRef, renderableUrlOrPath>
```

- Owned by the Core production asset resolver (Parallel Track A); the renderer only consumes it.
- Keys are **logical asset references** exactly as they appear in `scene.assetRefs[].assetRef` (e.g. `asset-iva-progress-chart`).
- Values are **renderable URLs or paths** as supplied by Core (e.g. `http://127.0.0.1:3000/media/asset/asset-progress-chart-real`).
- `VideoCompositionPlan` accepts it via the already-declared `VideoCompositionPlanProps.mediaMap` (Phase 5C) and now actually consumes it per scene.

## Scene Lookup Rule (`resolveSceneMediaUrl`)

```ts
export function resolveSceneMediaUrl(
  scene: Pick<RemotionSceneCompositionSpec, 'assetRefs'>,
  mediaMap?: Record<string, string>,
): string | null
```

1. If `mediaMap` is undefined → `null` (safe no-map operation).
2. Iterate `scene.assetRefs` **in their existing order** (order from the Phase 5C pipeline, never reordered).
3. Return the **FIRST** ref whose `mediaMap[assetRef]` is a **non-empty string** (`typeof url === 'string' && url.length > 0`).
4. Otherwise return `null`.

Explicitly NOT done: fuzzy matching, inference, treating `assetRef` itself as a URL, reordering refs, choosing random media, mutating scene/plan/map, substituting media from another scene or an unrelated asset. Pure: same inputs → same output, every call.

## First-Resolved-Ref Rule

The existing renderer supports one `mediaUrl` per scene. For Phase 6A: **the first successfully resolved logical ref in existing `assetRefs` order wins** and becomes the scene's single `mediaUrl`. Remaining refs stay in the plan untouched (never removed). Multi-media scenes are explicitly out of scope.

## Unresolved Behavior

If no `assetRef` of a scene has a value in `mediaMap` → `mediaUrl = null`. The scene continues rendering through its existing non-media visual path via `SceneRenderer` → `Background` (variant plate) / `Explanation` (variant plate). No error, no warning, no substitution from another scene, no unrelated asset. Missing/invalid asset findings remain owned by the Core resolver (Track A).

## Canonical Asset-Ref Evidence

`asset-iva-progress-chart` is produced by the real Phase 5C pipeline. Live execution of the chain `getProgressMeetingScenario → compileScenarioVisualPlan → buildDialogueProductionPlan → buildVisualProductionPlan → buildSceneRenderPlan → buildRemotionCompositionProps` on this baseline printed:

```
sc-01-hook          | hook:generic                     | refs: []
sc-02-context       | explanation:key_statement        | refs: [{"assetRef":"asset-iva-progress-chart","order":0,"cueKind":"screen_insert_title","cueId":"scenario-pm-01/sc-02-context/cue/screen_insert_title"},{"assetRef":"asset-iva-progress-chart","order":1,"cueKind":"screen_insert_description","cueId":"scenario-pm-01/sc-02-context/cue/screen_insert_description"}]
sc-03-dispute       | explanation:number_comparison    | refs: []
sc-04-site-walk     | explanation:site_footage_callouts| refs: []
sc-05-resolution    | cta:cta_card                     | refs: []
```

Independent static evidence: `tests/scenario-visual-plan.test.ts` line 264: `expect(insert.assetRef).toBe('asset-iva-progress-chart')` (Phase 3B `screen_insert_title` cue of the progress-meeting fixture). The dual-ref scene `sc-02-context` is exactly the shape tests 5/6/12 exercise (first ref in order wins).

## Tests / Regressions

New: `tests/phase6a-renderer-assets.test.ts` — **15 passed** (`npx vitest run tests/phase6a-renderer-assets.test.ts`, happy-dom, no Chromium, no MP4 render):

1. exact logical ref → supplied URL
2. `asset-iva-progress-chart` resolves correctly (canonical contract shape)
3. unrelated map keys ignored (no fuzzy match / inference)
4. unresolved asset → `null`, no cross-scene substitution
5. multiple refs → first resolved in existing plan order
6. empty-string URL ignored, later ref wins
7. no mediaMap safe (`undefined` and `{}`)
8. plan/scene/map not mutated (structural deep-equal against clones)
9. frame/timing/audio/caption/transition data unchanged by lookup
10. repeated lookup deterministic (5× identical results)
11. scene with no assetRefs → `null`
12. order follows `assetRefs`, not map key insertion order
13–15. DOM-level (real components, only Remotion frame/config context + `Sequence` placement mocked): resolved URL appears in rendered DOM through the existing Background/Explanation media path; unresolved scene renders non-media path; empty-string map value behaves as unresolved; no-mediaMap render emits no `url(http…`.

Regressions (all pass):

| Gate | Result |
| --- | --- |
| Phase 5C Remotion tests (`tests/remotion-composition.test.ts`, `-integration`, `remotion-smoke.test.ts`) | pass (incl. final-frame 3563 evidence, 5 scenes, renderer keys resolved) |
| Phase 5D sync tests (`tests/audiovisual-sync.test.ts`) | pass |
| Phase 5E closure tests (`tests/phase5-closure.test.ts`) | pass |
| Focused run of all five | 5 files, 71 tests passed |
| Full `npm test` | **37 files, 623 tests passed** (37 = 36 baseline files + new Phase 6A file) |
| Typecheck | `tsc -p packages/core/tsconfig.json --noEmit` clean; changed video files clean under `tsconfig.base.json` strict options (`--noEmit`, `jsx react-jsx`). Note: repo has no `packages/video` tsconfig and its typecheck script only covers core + web; strict-invoking the whole `SceneRenderer` import graph surfaces pre-existing baseline errors in **untouched** `Explanations.tsx` / `Hooks.tsx` (files forbidden to Phase 6A). My two changed files contribute zero errors. |
| Build | `npm run build` (core tsc + web vite) passed |
| Test-count guard | `node scripts/assert-test-count.mjs` → 623 passed, floor 300 OK |
| `git diff --check` | clean (no whitespace/conflict-marker errors) |

## Single-Media-Per-Scene Limitation (current compatibility limitation)

The renderer supports exactly one `mediaUrl` per scene. `resolveSceneMediaUrl` therefore returns only the first successfully resolved ref in existing `assetRefs` order. Additional refs (e.g. the second `asset-iva-progress-chart` ref of `sc-02-context`, or future multi-asset scenes) keep their map entries but are not visually consumed yet. Remaining refs are **not** removed from the plan. Multi-media scene support would require a renderer change and is deliberately deferred.

## Safe-to-Integrate Status

**Safe to integrate.** The change is additive and contract-only: when `mediaMap` is absent, empty, or missing a scene's refs, every scene renders exactly as at the approved baseline (`mediaUrl = null` → existing non-media path). Timing, FPS, frame boundaries, final-frame policy, canonical audio, captions, transitions, rendererKey, brand, format, and sequence placement are untouched — proven by the passing Phase 5C/5D/5E suites and the full 623-test suite. No forbidden file was modified; no dependency was added. Track A's Core resolver can be merged independently; its output plugs into `VideoCompositionPlanProps.mediaMap` as documented above.
