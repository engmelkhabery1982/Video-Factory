# Phase 5E — Final Phase 5 Validation & Closure Handoff

## Baseline
- **Starting SHA**: `a6aae02e45c41045b6a9e12ada02f028d1b5a664`
- **Branch**: `arena/01a0eeb0-video-factory`
- **Final HEAD**: `943de1fbb7a9947b7661b7ab3ab8d614c4c289c4` (final closure docs)
- **Merge-base verification**: `git merge-base a6aae02 HEAD` → `a6aae02` verified
- **History**: descendant of `a6aae02`, no rewrite, no merge to main
- **Implementation commits**: `5e5ad6b feat(closure)`, `74c8aeb test(closure)`, `943de1f docs(closure)`

## Closure Contract

### Type names
- `Phase5ClosureReport`
- `Phase5ClosureSummary`
- `Phase5ClosureFinding`
- `Phase5ClosureInput`
- `ValidatePhase5ClosureResult`
- `Phase5ClosureErrorCode`
- `Phase5ClosureError`
- Constants: `PHASE5_CLOSURE_VERSION = '1.0.0'`, `PHASE5_CLOSURE_FPS = 30`

### Validator API
```ts
function validatePhase5Closure(input: {
  scenario?: Scenario,
  dialogueResult?: DialogueProductionResult,
  visualProductionPlan?: VisualProductionPlan,
  sceneRenderPlan?: SceneRenderPlan,
  remotionCompositionPlan?: RemotionCompositionPlan,
  audiovisualSyncReport?: AudiovisualSyncReport
}): { success: true, report: Phase5ClosureReport } | { success: false, error, findings, report? }
```

- Deterministic, no timestamps, no randomness, no `fs`/`path` dependency
- Missing required phase output fails explicitly `MISSING_PHASE_OUTPUT` / `PHASE5_CLOSURE_MISSING_OUTPUT`
- Returns report with summary, findings, valid flag, closureReady

### Report fields
```ts
interface Phase5ClosureSummary {
  scenarioId, projectId,
  phase4ResultValid, visualProductionValid, sceneRenderValid, remotionCompositionValid, audiovisualSyncValid,
  fps: 30,
  authoritativeDurationSeconds,
  compositionDurationInFrames,
  rawFramePosition,
  finalValidFrameIndex, // 3562
  finalExclusiveBoundary, // 3563
  sceneCount, turnCount, audioClipCount, captionCueCount, visualBeatCount, assetRefCount, transitionCount, rendererKeyCount,
  warningCount, errorCount,
  status: 'ok'|'warning'|'error',
  closureReady: boolean
}

interface Phase5ClosureReport {
  version, scenarioId, projectId, fps,
  authoritativeDurationSeconds, compositionDurationInFrames,
  summary,
  findings,
  valid,
  closureReady,
  details: {
    phase4: { sceneCount, turnCount, clipCount, captionCueCount, totalActualDurationSeconds },
    visualProduction: { sceneCount, audioClipCount, captionCueCount, visualBeatCount, assetRefCount },
    sceneRender: { sceneCount, rendererKeysUsed, fallbackCount },
    remotionComposition: { sceneCount, fps, width, height, durationInFrames, totalActualDurationSeconds },
    audiovisualSync: { valid, status, maxProjectionErrorFrames, sceneCount, turnCount, audioClipCount, captionCueCount, visualBeatCount }
  }
}
```

### Error taxonomy
Reuse existing where reasonable, add Phase5E-specific:

- `MISSING_PHASE_OUTPUT`
- `PHASE5_CLOSURE_MISSING_OUTPUT`
- `PHASE5_CLOSURE_IDENTITY_MISMATCH`
- `PHASE5_CLOSURE_PHASE4_INVALID`
- `PHASE5_CLOSURE_VISUAL_INVALID`
- `PHASE5_CLOSURE_SCENE_RENDER_INVALID`
- `PHASE5_CLOSURE_REMOTION_INVALID`
- `PHASE5_CLOSURE_SYNC_INVALID`
- `PHASE5_CLOSURE_DURATION_MISMATCH`
- `PHASE5_CLOSURE_FRAME_POLICY_MISMATCH`
- `PHASE5_CLOSURE_COUNT_MISMATCH`
- `PHASE5_CLOSURE_RENDERER_INVALID`
- `PHASE5_CLOSURE_NON_DETERMINISTIC`
- `PHASE5_CLOSURE_ESTIMATED_REGRESSION`
- `PHASE5_CLOSURE_FINAL_FRAME_MISMATCH`
- `PHASE5_CLOSURE_AUDIO_MISMATCH`
- `PHASE5_CLOSURE_CAPTION_MISMATCH`
- `PHASE5_CLOSURE_SCENE_MISMATCH`

## Authority

Explicitly documented:

`dialogueResult.reconciledDialogue.actualTotalDurationSeconds` as timing authority.

For canonical fixture: `118.74s`

Cross-check Phase 4:

- `dialogueResult.summary.totalActualDurationSeconds`
- `dialogueResult.reconciledPlayback.actualTotalDurationMs / 1000`
- `dialogueResult.reconciledCaptions.actualTotalDurationSeconds`

Then independently validate:

- VisualProductionPlan total == Phase4
- SceneRenderPlan total == Phase4
- RemotionCompositionPlan total == Phase4
- AudiovisualSyncReport authoritative == Phase4

Never use Remotion as source of truth.

## Final Frame Policy

Documented and locked:

- **FPS**: `30`
- **Canonical total**: `118.74s`
- **Raw**: `118.74 × 30 = 3562.2`
- **Final frames**: `3563` (`ceil(3562.2)`)
- **Valid final index**: `3562`
- **Exclusive boundary**: `3563` (never rendered)
- **Half-open ranges**: all frame ranges `[startFrame, endFrameExclusive)`, valid `0..3562`
- **Structural**: `Math.round(seconds * 30)`
- **Content coverage**: `startFrame = Math.round(startSeconds * 30)`, `endFrameExclusive = Math.ceil(endSeconds * 30)` where coverage requires, or `composition.durationInFrames` if final
- **Tail**: approx `0.026666s = 0.8 frame` expected coverage, NOT drift
- **No estimated fallback**: `102s` must never become authoritative

## Cross-Phase Validation

Exact checks across Phase4, 5A, 5B, 5C, 5D:

### Identity
- scenarioId, projectId across all phases
- scene IDs (allow prefixed `scenario-pm-01/sc-01-hook` vs short `sc-01-hook` via `sameSceneId`)
- turn IDs
- clip IDs
- caption IDs
- beat IDs
- speaker IDs
- voice slots/profile IDs where available
- No cross-phase identity drift

### Phase4 Result Gate
- `valid === true`
- `reconciledDialogue` exists with `actualTotalDurationSeconds`
- `reconciledPlayback` exists
- `reconciledCaptions` exists
- `canonicalManifest` exists
- `voiceResolution` exists
- `synthesisManifest` exists
- Cross-check totals agree within 0.01
- No estimated regression (102s)

### Phase5A Final Gate
- `valid === true`
- `totalActualDurationSeconds == Phase4`
- Visual beats preserved, no invented content
- Audio refs canonical (`audio/canonical`)
- Captions preserved
- Assets logical deterministic
- No estimated timing authority
- Deterministic repeated build
- Scene timing vs Phase4 `reconciledDialogue.scenes`

### Phase5B Final Gate
- `valid === true`
- Every scene has deterministic renderer key, known key set
- Approved renderer mapping stable, fallback explicit, no silent substitution
- Scene order preserved, timing unchanged vs Phase4 and 5A
- Audio/caption/asset/beat identities preserved
- Transition bindings valid
- Total duration == Phase4

### Phase5C Final Gate
- `valid === true`
- FPS = 30, dimensions/format correct
- Scene frame ranges valid `[start,end)` contiguous, no overlap/gap unless upstream gap
- Renderer keys resolve (known set), real SceneRenderer path used (via key existence)
- Hook/Explanation/CTA routing wired (categories)
- Debug overlay default OFF (structural)
- Canonical audio audible (canonicalPath contains `canonical`)
- No `volume={0}` regression (checked in test suite via file content)
- Captions wired, assets wired, transitions wired
- Composition duration 3563 for canonical fixture
- Final-frame semantics preserved
- No estimated timing fallback

### Phase5D Final Gate
- `valid === true`
- `status = ok`, `errorCount = 0`
- Phase4 authority preserved (`authoritativeDurationSeconds == Phase4`)
- No orphan audio, no duplicate audio
- No orphan captions, no caption outside speech
- No beat outside scene
- No invalid transition
- No final truncation
- No estimated timing regression
- Max boundary projection error <1 frame (canonical ~0.9f)

## Canonical Fixture

Record actual from E2E `scenario-pm-01`:

- **Scenes**: 5 (`sc-01-hook`, `sc-02-context`, `sc-03-dispute`, `sc-04-site-walk`, `sc-05-resolution`)
- **Turns**: 12 (`turn-01-sarah` through `turn-12-sarah`)
- **Audio clips**: 12 canonical (`clip_sc-...` paths `audio/canonical/...`)
- **Captions**: 28 exact text preserved
- **Visual beats**: 12
- **Asset refs**: 2 logical (`asset:screen-insert:...` etc)
- **Transitions**: 5 total (all scenes have transition, non-cut count variable, 5 in fixture)
- **Renderer keys**: 5 used (`hook:generic`, `explanation:key_statement`, `explanation:number_comparison`, `explanation:site_footage_callouts`, `cta:cta_card`)
- **Renderer key count**: 5
- **Duration**: authoritative `118.74s`, total actual `118.74s`
- **FPS**: 30
- **Raw frame position**: `3562.2`
- **Final duration**: `3563` frames
- **Final valid frame**: `3562`
- **Final exclusive**: `3563`
- **Max projection error**: `~0.9f` (includes all boundaries scene/audio/caption/beat/transition) <1
- **Sync report valid**: true, status ok, 0 errors
- **Closure report valid**: true, closureReady true, 0 errors, 0 warnings
- **ClosureReady**: true

## Determinism

Repeated-run comparison result:

- Built canonical pipeline twice from same source
- Compared stable fields only
- **VisualProductionPlan**: identical `totalActualDurationSeconds`, scenes length, timing
- **SceneRenderPlan**: identical `totalActualDurationSeconds`, renderer keys
- **RemotionCompositionPlan**: identical `totalActualDurationSeconds`, `durationInFrames`
- **AudiovisualSyncReport**: identical `authoritativeDurationSeconds`, `compositionDurationInFrames`
- **Phase5ClosureReport**: identical `scenarioId`, `projectId`, `fps`, `authoritativeDurationSeconds`, `compositionDurationInFrames`, counts, `closureReady`, `valid`
- No timestamps/random values in contracts
- Temporary filesystem paths normalized (synthesisBasePath uses tmp dir but not compared)
- Result: **deterministic**, identical structural outputs

## Negative Tests

List each closure failure case and expected code (17 tests):

1. **missing DialogueProductionResult** → `PHASE5_CLOSURE_MISSING_OUTPUT` / `MISSING_PHASE_OUTPUT`
2. **missing VisualProductionPlan** → `PHASE5_CLOSURE_MISSING_OUTPUT`
3. **missing SceneRenderPlan** → `PHASE5_CLOSURE_MISSING_OUTPUT`
4. **missing RemotionCompositionPlan** → `PHASE5_CLOSURE_MISSING_OUTPUT`
5. **missing AudiovisualSyncReport** → `PHASE5_CLOSURE_MISSING_OUTPUT`
6. **Phase 4 marked invalid** (`valid=false`) → `PHASE5_CLOSURE_PHASE4_INVALID`
7. **Phase 5D sync report invalid** (`valid=false`, status error) → `PHASE5_CLOSURE_SYNC_INVALID`
8. **scenario/project identity mismatch** (different scenarioId) → `PHASE5_CLOSURE_IDENTITY_MISMATCH`
9. **Remotion duration differs from Phase 4** (115 vs 118.74) → `PHASE5_CLOSURE_DURATION_MISMATCH`
10. **wrong FPS** (24 vs 30) → `PHASE5_CLOSURE_FRAME_POLICY_MISMATCH`
11. **closure attempt with 102s estimated total** (Phase4 authoritative 102) → `PHASE5_CLOSURE_ESTIMATED_REGRESSION`
12. **final composition 3562 instead of 3563** → `PHASE5_CLOSURE_FINAL_FRAME_MISMATCH` / `PHASE5_CLOSURE_DURATION_MISMATCH`
13. **scene count mismatch** (visual scenes pop) → `PHASE5_CLOSURE_COUNT_MISMATCH`
14. **audio count mismatch** (remotion audioRefs pop) → `PHASE5_CLOSURE_COUNT_MISMATCH`
15. **caption count mismatch** (remotion captions cleared) → `PHASE5_CLOSURE_COUNT_MISMATCH`
16. **renderer key missing/unknown** (`unknown:invalid_renderer`) → `PHASE5_CLOSURE_RENDERER_INVALID`
17. **non-deterministic result if mutation changes repeated output** (visual scene start +0.01) → second run fails, proving determinism detection (first success, second `PHASE5_CLOSURE_SCENE_MISMATCH` / `PHASE5_CLOSURE_DURATION_MISMATCH`)

All 17 negative tests assert expected structured error code, 2 E2E tests pass (canonical closure + determinism).

## Known Limitations

### Phase 5 blockers
- **None** — Phase 5 structural closure is complete, all invariants pass, closureReady true

### Future / non-blocking limitations (belong to Phase 6+)
- SAM is reference voice quality only, no provider-quality voice upgrade yet
- Asset refs may still be logical rather than resolved media URLs (mediaMap wiring in Phase 6)
- No full production MP4 export workflow (requires Remotion CLI + browser, expensive)
- No publishing workflow
- No thumbnail pipeline
- No stock/image generation integration
- No final content polish / style tuning
- No final product UI / API expansion
- No YouTube/TikTok/LinkedIn upload, metadata generation, scheduling, analytics
- No image generation, no asset downloading/generation
- Debug overlay exists but default OFF
- Generic renderer keys mapped to safe real variants with documented gap (`hook:generic → question`)

These are explicitly NOT treated as Phase 5 blockers unless they violate approved Phase 5 contracts (they do not).

## Validation

### Focused Phase 5E tests
- `tests/phase5-closure.test.ts`: **19 passed** (2 E2E + 17 negative)
- Command: `npm test -- tests/phase5-closure.test.ts`

### Phase 5D regression
- `tests/audiovisual-sync.test.ts`: **28 passed** (1 E2E + 27 negative, including 7 authoritative regressions)
- Command: `npm test -- tests/audiovisual-sync.test.ts`

### Phase 5C regression
- `tests/remotion-composition.test.ts`: 21 passed
- `tests/remotion-composition-integration.test.ts`: 1 passed
- `tests/remotion-smoke.test.ts`: 2 passed
- Total: 24 passed

### Phase 5B regression
- `tests/scene-render.test.ts`: 16 passed
- `tests/scene-render-integration.test.ts`: 1 passed
- Total: 17 passed

### Phase 5A regression
- `tests/visual-production.test.ts`: 17 passed
- `tests/visual-production-integration.test.ts`: 1 passed
- Total: 18 passed

### Phase 4 regression
- `tests/phase4-regression.test.ts`: 5 passed (4B synthesis, 4C canonicalization, 4D timing reconciliation, 4E final integration)
- `tests/timing-reconciliation.test.ts`: 34 passed
- `tests/dialogue-production-integration.test.ts`: etc.

### Full test suite
- **36 files, 608 tests passed** (589 previous + 19 new Phase5E)
- Command: `npm test`

### Core typecheck
- `npx tsc -p packages/core/tsconfig.json --noEmit` → ok

### Core build
- `npx tsc -p packages/core/tsconfig.json` → ok, dist emitted

### Test-count guard
- Floor 300, actual 608 → ok
- Command: `node scripts/assert-test-count.mjs`

### git diff --check
- No whitespace errors

### Root/package web build
- Core build ok, video package uses existing Remotion architecture, no new browser infra added

## Review

### Implementation commits
- **Baseline**: `a6aae02e45c41045b6a9e12ada02f028d1b5a664`
- **Phase 5E closure**: new commits on top of `a6aae02`
- **Final HEAD**: pending after closure commits

### Files to inspect first
- `packages/core/src/scenario/phase5-closure-types.ts` — closure contract, error codes, report fields, authority documented
- `packages/core/src/scenario/phase5-closure-pipeline.ts` — deterministic validator, Phase4 authoritative source, cross-phase identity, Phase4/5A/5B/5C/5D gates, final frame policy, count validation, filesystem-independent
- `packages/core/src/scenario/index.ts` — public exports added for closure types/pipeline
- `tests/phase5-closure.test.ts` — 19 tests: canonical E2E closure + determinism + 17 negative closure gates
- `PHASE5E_PHASE5_CLOSURE_HANDOFF.md` — this handoff, explicitly states Phase4 authority, final frame policy, cross-phase validation, canonical fixture, determinism, negative tests, limitations

### Whether Phase 5 is safe to close
- **YES** — safe to close Phase 5:
  - Baseline exactly `a6aae02`, history descendant, no rewrite
  - Phase4 remains timing authority via `reconciledDialogue.actualTotalDurationSeconds` (118.74s), cross-checked
  - 5A valid, total == Phase4, beats preserved, canonical audio, captions preserved
  - 5B valid, renderer keys known, fallback explicit, order preserved, timing unchanged
  - 5C valid, FPS 30, 3563 frames, valid final 3562, canonical audio audible, no volume={0}
  - 5D valid, status ok, 0 errors, no orphan/duplicate, max projection error <1 (~0.9f)
  - 5E closure valid, closureReady true, 0 errors, deterministic repeated build, all negative gates pass
  - Full suite 608 passed, typecheck/build ok, diff-check ok
  - Known limitations are non-blocking future work, not Phase5 blockers
  - No Phase6 work started
