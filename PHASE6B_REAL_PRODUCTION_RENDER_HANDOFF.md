# Phase 6B — Real Production Render Pipeline Handoff

## Baseline

`6bba88e3dac353d8e24de246340a52beb87c905f`
(`docs(assets): close phase6a production asset integration`)

Branch: `arena/01a0f1a5-video-factory` (this session's auto-created branch).
`git rev-parse HEAD` immediately after alignment returned exactly the baseline
SHA, working tree clean. `main`, `arena/01a0f15b-video-factory` and
`freebuff/phase6a-renderer-assets` were not touched. No force push, no history
rewrite, no merges.

> Note: the first tool call of this session reported HEAD `4816722` on `main`.
> The approved baseline `6bba88e3` lives on a different lineage and is **not** a
> descendant of it. The branch was aligned to `6bba88e3` before any edit, which
> is the baseline this work is built on and the one all evidence below refers to.
> `4816722` is not an ancestor of this branch.

## Render API

| Item | Value |
| --- | --- |
| Function | `renderCompositionPlan(input)` — `apps/api/src/services/render.ts` |
| Composition id | `VideoPlan` (`PLAN_RENDER_COMPOSITION_ID`) |
| Input | `PlanRenderInput` (`packages/core/src/scenario/plan-render-types.ts`) |
| Output | `PlanRenderResult` |
| Errors | `PlanRenderError` + `PlanRenderErrorCode` |

`PlanRenderInput`:

```ts
{
  plan: RemotionCompositionPlan;   // authoritative production plan
  outputFile: string;              // .mp4
  mediaMap?: Record<string, string>; // Phase 6A report.mediaMap, verbatim
  brand?: unknown;
  format?: 'long' | 'short';
  captionStyle?: string;
  burnedCaptions?: boolean;
  frameRange?: [firstFrame, lastFrameInclusive] | null; // test/preview only
  quality?: 'preview' | 'final';
  onProgress?: (p: number, note?: string) => void;
}
```

`PlanRenderResult`:

```ts
{
  outputFile; compositionId; scenarioId; projectId;
  fps; width; height; durationInFrames;   // durationInFrames = the PLAN's
  renderedFrameCount;                     // frames THIS call encoded
  authoritativeDurationSeconds;           // plan.totalActualDurationSeconds
  renderedWithAudio; mediaMapEntryCount; renderTimeMs;
}
```

No timestamps are added — the surrounding runtime contract does not require them.

Companion API: `renderPlanStill({ plan, output, frame, mediaMap, ... })` renders a
single frame through the same `VideoPlan` composition (evidence stills).

Error codes actually used: `PLAN_RENDER_INVALID_INPUT`, `PLAN_RENDER_INVALID_PLAN`,
`PLAN_RENDER_COMPOSITION_NOT_FOUND`, `PLAN_RENDER_FAILED`,
`PLAN_RENDER_OUTPUT_MISSING`, `PLAN_RENDER_AUDIO_MISSING`,
`PLAN_RENDER_MEDIA_NOT_VISIBLE`, `PLAN_RENDER_TIMING_MISMATCH`,
`PLAN_RENDER_INVALID_FRAME_COUNT`. No new error framework.

### Not the legacy path

The plan path never uses `LongVideo` / `ShortVideo`, `Project.storyboard` or
`Scene[]` as an authority, and never muxes a separate narration file. A source
assertion in `tests/phase6b-plan-render.test.ts` pins this. `exportProject(...)`,
`renderTarget(...)`, `muxAndEncode(...)` and `renderThumbnails(...)` are
unchanged and their tests still pass.

## Timing — LOCKED, not recalculated

| Fact | Value |
| --- | --- |
| Authoritative duration | **118.74 s** (`plan.totalActualDurationSeconds`, from Phase 4 actual reconciled timing) |
| FPS | **30** |
| Raw frame value | 3562.2 |
| `durationInFrames` | **3563** (exclusive boundary) |
| Valid frame indices | **0 .. 3562** |
| Phase 3A estimator value | 102 s → 3060 frames — **NOT used** |

`renderCompositionPlan` uses `plan.durationInFrames` as-is and asserts the
selected composition's `fps`, `width`, `height` and `durationInFrames` equal the
plan's, throwing `PLAN_RENDER_TIMING_MISMATCH` otherwise. Durations are never
recomputed from a legacy scene sum, `Math.round(seconds * fps)`, storyboard
timings or an audio file probe. `validatePlanForRender` additionally rejects a
plan whose `durationInFrames` differs from `ceil(totalActualDurationSeconds * fps)`
**and** rejects a plan whose frame count equals the estimator-derived value.

Scene spans observed (unchanged from Phase 5):
`[0,710) [710,1316) [1316,2332) [2332,2858) [2858,3563)` — final scene ends
exactly at 3563.

## Audio

- **Canonical source**: the Phase 4 canonical dialogue clips carried by the plan
  as `scene.audioRefs[].canonicalPath` (12 refs on the canonical plan, one per
  dialogue turn).
- **Remotion behaviour**: `VideoCompositionPlan` renders each ref inside its
  scene `Sequence` with `<Audio>`; the plan path never mutes (`volume={0}`),
  replaces, retimes, stretches or re-muxes it.
- **Render settings**: `enforceAudioTrack` is on whenever the plan declares audio
  (`canonicalAudioExpected`). It is only off for a plan that declares no audio at
  all, so it can never remove real audio.
- **Verification**: after encoding, the file is analysed with the repo's
  `analyseFile` (ffprobe + ffmpeg). If the plan declared audio and the file has
  no audio stream, the render throws `PLAN_RENDER_AUDIO_MISSING`.
- **Rendered output contains an audio stream**: yes — confirmed on both the
  sub-range render and the full canonical render (AAC LC, 48 kHz, stereo).

> Transport detail (§16): production serves canonical audio through the API; the
> tests map the audit-only `canonicalPath` field to their local fixture server
> URL (`toRenderableAudioUrl`) so the render stays offline. Only that one field
> changes; timing, ids and everything else stay verbatim.

## Assets

- **Input**: `mediaMap: Record<logicalAssetRef, renderableUrlOrPath>` — exactly
  `ProductionAssetResolutionReport.mediaMap` from Phase 6A, passed straight into
  the composition props. No re-resolution, no asset library query inside the
  renderer, no re-keying to assetIds, no fuzzy matching.
- **Canonical asset**: `asset-iva-progress-chart`
- **Canonical target scene**: `sc-02-context`
- **Actual rendererKey**: `explanation:key_statement` (unchanged)
- **AssetRefs on the scene**: two refs for the same logical asset —
  `screen_insert_title` (order 0) and `screen_insert_description` (order 1).

### Why the asset was invisible, and the fix

Phase 6A proved resolution + wiring, but `explanation:key_statement` printed only
the statement text; `mediaUrl` reached `Explanation` and was dropped. The
smallest semantically correct fix was applied **inside** the approved renderer:

> `packages/video/src/scenes/Explanations.tsx` — in `case 'key_statement'`, when
> a resolved `mediaUrl` exists the statement block is placed beside an
> asset plate (`data-buildtrack-resolved-media`) in the same content block.
> Without a resolved URL the branch is skipped and the output is byte-identical
> to before.

Not changed: renderer taxonomies, `rendererKey`, `visualTreatment`, narration,
captions, timing, scene identity, content or background. `key_statement` was
registered as a media-consuming renderer in the Phase 6B contract
(`MEDIA_CONSUMING_RENDERER_KEYS`), and `assertSceneMediaVisible` /
`validatePlanForRender(plan, mediaMap)` now throw `PLAN_RENDER_MEDIA_NOT_VISIBLE`
if a scene's media resolves but its renderer cannot show it.

### Proof the canonical scene visibly renders it

`EVIDENCE/phase6b/sc02_media_visibility.json` — three **real rendered stills** of
the real canonical `sc-02-context` (frame 750, inside `[710,1316)`), same plan,
same `rendererKey`, only the resolution differs:

| Still | mediaMap | sha256 (12) |
| --- | --- | --- |
| resolved | `{asset-iva-progress-chart: .../progress-chart.png}` | `684d30703479` |
| alt | same ref → different fixture file | `35321bed454e` |
| unresolved | `{}` | `2bdc443148d8` |

All three digests differ ⇒ the resolved media is genuinely consumed on screen,
and the test fails if the asset is resolved but visually ignored. The frame is
in `EVIDENCE/phase6b/canonical_sc02_context_frame.jpg`. An additional DOM-level
test renders the real `PlanSceneRenderer` for the canonical scene and asserts the
resolved URL and the asset plate appear while `rendererKey` stays
`explanation:key_statement`.

## Real render evidence

### Short real render (automated, `tests/phase6b-real-render.test.ts`)

| Item | Value |
| --- | --- |
| Output | `.stills/phase6b/evidence-canonical-sc02.mp4` (sub-range frames 710–769, 60 frames) |
| Composition | `VideoPlan` |
| Dimensions | 1920×1080 |
| FPS | `30/1` |
| Video codec | `h264` (High), `yuvj420p`, `nb_frames=60`, stream duration 2.000 s |
| Audio codec | `aac` (LC), 48000 Hz, 2 ch, `nb_frames=96`, duration 2.048 s |
| Container | `mov,mp4,m4a,3gp,3g2,mj2`, 2.048 s, 415 633 bytes, 1 623 566 bit/s |
| File sha256 | `241fc791d7b3d80aeca8d3fa2396cab987082cd6ccfbcc12419458d12c4fc20b` |
| ffprobe/analysis | video+audio streams present, audio present, longest silence 0 s, black seconds 0 s |
| `PlanRenderResult` | `compositionId=VideoPlan`, `durationInFrames=3563`, `renderedFrameCount=60`, `authoritativeDurationSeconds=118.74`, `renderedWithAudio=true`, `mediaMapEntryCount=1` |

Container/stream rounding (2.048 s container vs 2.000 s of video) is normal
AAC/container priming, not Phase 5 timing drift.

### Full canonical render (manual/validation run)

**Performed.** The complete `scenario-pm-01` plan was rendered end to end.

| Item | Value |
| --- | --- |
| Command | `node --import tsx .tmp-probe/full-render.ts` (same code path as `renderCompositionPlan`, no `frameRange`) |
| Output | `.stills/phase6b/full-canonical.mp4` |
| Composition | `VideoPlan` |
| Frames | **3563 / 3563** — covers the full exclusive timeline, no truncation |
| Dimensions / fps | 1920×1080 @ 30 |
| Video | `h264` High, `yuvj420p`, `30/1`, `nb_frames=3563`, duration **118.767 s** |
| Audio | `aac` LC, 48000 Hz, 2 ch, duration 118.827 s |
| Container | 118.827 s, 17 439 404 bytes, ~1.17 Mbit/s, sha256 `edcd2f61e821d4c19dbc067fbb0750c741b4f505b56554e08b8ee694cfcd7a92` |
| Render time | 1416.6 s (~23.6 min) on a 2-core sandbox |
| `PlanRenderResult` | `durationInFrames=3563`, `renderedFrameCount=3563`, `authoritativeDurationSeconds=118.74`, `renderedWithAudio=true` |
| Artifacts | `EVIDENCE/phase6b/full_render_result.json`, `EVIDENCE/phase6b/full_render_ffprobe.json` |

Duration covers the authoritative 118.74 s correctly (118.767 s of video =
3563 frames / 30 fps, the expected 0.8-frame coverage tail — not drift) and
nothing is truncated before it.

The full canonical MP4 was an ignored runtime artifact and was lost when the
Arena workspace restarted; its committed evidence artifacts survive.

The 17 MB MP4 itself is intentionally **not** committed: the repository ignores
rendered media (`data/`, `output/`, `.stills/`, `*.mp4` scratch) and prior
phases follow the same convention (no `.mp4` exists anywhere under `EVIDENCE/`).
The reproducible command, the `PlanRenderResult` and the full ffprobe/analysis
JSON are committed instead, and the collector (`npm run evidence:phase6b`)
regenerates them.

## Regression

| Gate | Result |
| --- | --- |
| Phase 6A — `production-asset-resolution.test.ts` | pass |
| Phase 6A — `phase6a-renderer-assets.test.ts` | 15 passed |
| Phase 6A — `phase6a-production-assets-integration.test.ts` | 7 passed |
| Phase 5C — `remotion-composition.test.ts`, `-integration`, `remotion-smoke.test.ts` | pass |
| Phase 5D — `audiovisual-sync.test.ts` + timing reconciliation | pass |
| Phase 5E — `phase5-closure.test.ts` | pass |
| Phase 4 — `phase4-regression.test.ts` | pass |
| Focused Phase 5C/5D/5E/Phase 4 run | 7 files, 77 tests passed |
| Focused Phase 6B contract suite | 1 file, 44 tests passed |
| Focused Phase 6B real render | 1 file, 5 tests passed (36.2 s) |
| Full `npm test` | **41 files, 707 tests passed** (39/658 at baseline; +44 +5) |
| Typecheck | `npm run build:core -- --noEmit` clean; `tsc --noEmit -p apps/web/tsconfig.json` clean |
| Build | `npm run build` (core tsc + web vite) passed |
| Test-count guard | `node scripts/assert-test-count.mjs` → 707 passed, floor 300 OK |
| `git diff --check` | clean |

Baseline capture before any edit: full `npm test` → 39 files, 658 tests passed.

## Files changed

| File | Change |
| --- | --- |
| `packages/core/src/scenario/plan-render-types.ts` | **new** — Phase 6B render contract (`PlanRenderInput`, `PlanRenderResult`, `PlanRenderError`, codes, locked canonical timing constants) |
| `packages/core/src/scenario/plan-render-validation.ts` | **new** — pure structural validation + media-visibility gate |
| `packages/core/src/scenario/index.ts` | re-exports the two new modules |
| `apps/api/src/services/render.ts` | **new** plan render path (`renderCompositionPlan`, `renderPlanStill`, `videoPlanInputProps`, `normaliseFrameRange`, `assertRenderedOutput`, `remotionWebpackOverride`); legacy path untouched |
| `apps/api/src/services/node-builtin-shim.cjs` | **new** — inert Node-builtin stand-in for the browser bundle |
| `packages/video/src/scenes/Explanations.tsx` | canonical asset-visibility fix in `case 'key_statement'` |
| `tests/phase6b-plan-render.test.ts` | **new** — 44 focused contract tests |
| `tests/phase6b-real-render.test.ts` | **new** — 5 real render/encode tests |
| `tests/phase6b-evidence.ts` | **new** — evidence collector (`npm run evidence:phase6b`) |
| `tests/fixtures/render/*` | **new** — deterministic offline fixtures (2 PNG charts, 1 WAV clip) |
| `EVIDENCE/phase6b/*` | **new** — render evidence + ffprobe/analysis JSON + canonical frame |
| `.gitignore` | ignore `.remotion-probe/`, `.tmp-probe/`, `.test-phase6b/` scratch |
| `package.json` | `evidence:phase6b` script |

No dependency was added.

### New file: `apps/api/src/services/node-builtin-shim.cjs` (bundle defect)

`@buildtrack/core` is both the browser-facing plan contract and the Node library
that owns the Phase 4 audio tooling and scenario fixtures, so it imports
`node:fs` / `node:path` / `node:url` / `node:module` / `node:child_process`; three
modules touch those APIs at module-evaluation time. The Remotion bundle is built
by webpack for Chromium, which rejects the `node:` URL scheme outright
(`UnhandledSchemeError`) — **the bundle failed and no render of any kind could
run**. `remotionWebpackOverride` rewrites `node:` → bare specifiers (via webpack,
resolved through `@remotion/bundler`'s own hard dependency — no new dep) and
points the bare builtins at inert stand-ins. Nothing in the render path executes
them; Node execution (API, tests, pipeline) keeps the real builtins. This defect
predates Phase 6B and blocked the "existing real Remotion rendering infrastructure"
the brief assumes is available.

## Limitations / deferred to 6C+

- **`exportProject(...)` was not rewritten.** Phase 6B establishes the validated
  plan-render API; the legacy export still renders `LongVideo`/`ShortVideo` and
  muxes narration with FFmpeg. Target orchestration and delivery packaging remain
  6C/6D work.
- **Delivery bitrates/presets** are untouched: `preview` 4 M / `final` 16 M H.264,
  no second FFmpeg encode. Target-specific presets are 6C/6D.
- **`frameRange`** exists for cheap real renders; it is not a delivery mode.
- **Audio tests use a local fixture clip.** The tests map `canonicalPath` to a
  fixture URL because the sandbox has no API media server; production serves the
  plan's own canonical paths. The mapping touches only that field.
- **The canonical scene's asset plate is a still image.** Video assets and
  per-scene multi-media (the scene declares the same ref twice) still render as
  one plate. Multi-media scenes remain the Phase 6A limitation.
- **Full render at ~24 min/canonical video** on this 2-core sandbox. A 4-core
  machine is roughly 2× faster. CI stays browser-free by design.
- **`renderPlanStill`** is an evidence/verification helper, not part of the
  delivery contract.
- Phase 6C was **not** started.
