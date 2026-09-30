# Phase 6C — Plan-Based Long + Short Delivery Targets — Handoff

Delivers deterministic production **delivery-target** orchestration above the
approved Phase 6B renderer, for the plan-based production system only.

---

## 1. Baseline and branch

| Item | Value |
| --- | --- |
| Approved baseline | `c9ac48f5acecdc07a422c41d30efdad0e6a83c4d` |
| Branch | `arena/01a0f25c-video-factory` |
| `git rev-parse HEAD` after alignment | `c9ac48f5acecdc07a422c41d30efdad0e6a83c4d` (exact match, working tree clean) |
| Final HEAD | tip of `arena/01a0f25c-video-factory`; the fourth commit, `docs(delivery): hand off phase6c delivery targets`. Resolve with `git rev-parse arena/01a0f25c-video-factory`. |

**Alignment note.** The session branch was created by Arena from `main`
(`4816722`), which is a single orphan snapshot commit and is **not** an ancestor
of the Phase 6B lineage. The two histories are disjoint, so the baseline could
not be reached by merging. The branch was therefore pointed at the approved
baseline with `git reset --hard c9ac48f5…` **before any edit**, while it still
had no commits of its own and no upstream. No shared history was rewritten:
`main`, `arena/01a0f1a5-video-factory`, `arena/01a0f15b-video-factory` and
`freebuff/phase6a-renderer-assets` were never checked out, never modified and
never pushed. No force push, no rebase, no merge to `main`.

The baseline tree is a strict superset of `main`: the only 10 paths present in
`main` and absent from the baseline are archived Phase 3A/3C/3E
`.zip`/`.bundle`/`.patch` delivery artifacts and `metadata.json`.

---

## 2. Implementation commits

| # | SHA | Subject |
| --- | --- | --- |
| 1 | `661b9250b6ac9f4b15890ba63b75a882f354fedf` | `feat(delivery): add plan-based production delivery targets` |
| 2 | `b80cc54b16820c63af98284a42770395b44bca04` | `test(delivery): validate long and short target isolation` |
| 3 | `95ef69030a8175f05e7f3b7761d5f325552d7dd7` | `test(delivery): prove real short-format plan rendering` |
| 4 | tip | `docs(delivery): hand off phase6c delivery targets` |

---

## 3. Delivery target contract

All types live in `packages/core/src/scenario/delivery-target-types.ts`; the
logic lives in `packages/core/src/scenario/delivery-target-pipeline.ts`.

| Concept | Kind | Notes |
| --- | --- | --- |
| `DeliveryTargetId` | type | `'long' \| 'short_1' \| 'short_2' \| 'short_3'` |
| `ShortDeliveryTargetId` | type | `Exclude<DeliveryTargetId, 'long'>` |
| `DeliveryTargetFormat` | type | `'Long' \| 'Short'` |
| `DELIVERY_TARGET_ORDER` | const | `['long','short_1','short_2','short_3']` — the only ordering authority |
| `DELIVERY_TARGET_SPECS` | const | `Long → 1920×1080@30`, `Short → 1080×1920@30` (mirrors `REMOTION_LAYOUT`) |
| `MAX_SHORT_TARGETS` | const | `3` |
| `ProductionDeliveryTarget` | interface | one authoritative target |
| `ProductionDeliveryTargetSet` | interface | `version, long, shorts, targets, findings, summary, valid` |
| `ProductionDeliveryTargetFinding` | interface | `severity, code, message, targetId?, sceneId?` |
| `ProductionDeliveryTargetSetSummary` | interface | counts + `projectId` + `requestedTargetIds` + `deliveredTargetIds` |
| `BuildDeliveryTargetSetInput` | interface | `longPlan?`, `shortPlans?`, `mediaMapByTarget?` |
| `ProductionDeliveryRenderResult` | interface | `status, targetCount, succeededTargetIds, failedTargetIds, results, findings` |
| `ProductionDeliveryTargetRenderResult` | interface | per-target `success / renderResult / error` |
| `RenderProductionDeliveryTargetsInput` | interface | `targetSet, outputByTarget, quality?, brand?, frameRangeByTarget?, onProgress?` |
| `ProductionDeliveryTargetError` | class | small structured error (`code`, `targetId?`, `details?`) |
| `PRODUCTION_DELIVERY_VERSION` | const | `1.0.0` |

### Public functions

| Function | Module | Purpose |
| --- | --- | --- |
| `buildProductionDeliveryTargets(input)` | core pipeline | build the deterministic target set |
| `validateDeliveryTargetPlan(targetId, plan, mediaMap?)` | core pipeline | per-target format/dimension/fps + Phase 6B delegation |
| `validateDeliveryOutputPaths(targetIds, outputByTarget)` | core pipeline | caller-owned output-path policy |
| `deliveryTargetErrorsByTarget(findings)` | core pipeline | group error findings by target |
| `coveredDeliveryTargetIds(set)` | core pipeline | delivered **and** failed targets, canonically ordered |
| `sortDeliveryTargetIds(ids)` | core pipeline | canonical ordering helper |
| `isShortTargetId(id)` | core pipeline | type guard |
| `expectedFormatForTargetId(id)` | core types | `'long' → Long`, shorts → `Short` |
| `renderProductionDeliveryTargets(input)` | `apps/api/src/services/plan-delivery.ts` | real rendering, once per target |

### Target IDs and ordering

- IDs: `long`, `short_1`, `short_2`, `short_3`.
- Ordering is **always** `long → short_1 → short_2 → short_3` for the targets
  actually present. It is produced by filtering `DELIVERY_TARGET_ORDER`, never
  by object key order, insertion order or anything environment-derived. A test
  deliberately supplies `short_3, short_2, short_1` and asserts the canonical
  order comes back.
- A Short is *requested* when its id is an own key of `shortPlans`. A requested
  Short with a nullish plan is a structured error; a Short that was never
  requested is silently **omitted**, which is not an error.

---

## 4. Long target rules

| Rule | Value |
| --- | --- |
| id | `long` |
| `plan.targetFormat` | `Long` |
| dimensions | `1920 × 1080` |
| fps | `30` |
| duration | its own `plan.durationInFrames` |
| authoritative seconds | its own `plan.totalActualDurationSeconds` |
| audio | its own canonical `audioRefs` |
| captions | its own `captionCues` |
| assets | its own `assetRefs` + `mediaMapByTarget.long` |

The Long target is **never resized, cropped or trimmed** to derive a Short.

---

## 5. Short target rules

Every Short must be supplied as its **own approved Short-format**
`RemotionCompositionPlan`.

| Rule | Value |
| --- | --- |
| `plan.targetFormat` | `Short` |
| dimensions | `1080 × 1920` |
| fps | `30` |
| own | `durationInFrames`, `totalActualDurationSeconds`, `audioRefs`, caption timeline, `assetRefs`, `mediaMap`, renderer timing |

Explicitly **not** done: reusing Long audio, reusing Long captions, using the
Long duration, cropping Long frames, mutating Long dimensions, inferring a
missing Short plan, or generating Short content in this phase.

---

## 6. Project identity policy

- Every target in one delivery set must share the same `projectId`.
- A differing `scenarioId` is **allowed and preserved exactly** — a Short may be
  a separate approved scenario derived for the same production/project. The
  canonical set deliberately uses two different scenarioIds.
- On a `projectId` mismatch the offending target gets
  `DELIVERY_TARGET_PROJECT_MISMATCH` and is excluded. Identity is **never
  rewritten** — the surviving targets keep their own `projectId` and
  `scenarioId`.

---

## 7. Isolation guarantees

### mediaMap isolation

`mediaMapByTarget[targetId]` is used for that target only. A missing entry means
`{}` for that target — the Long map is never copied onto a Short. The Phase 6A
contract is unchanged: `logicalAssetRef → render URL`.

### Canonical audio isolation (Phase 6B audio policy preserved)

Each target carries its own Phase 4 `audioRefs`. Nothing muxes external
`targetAudio`, replaces plan audio, stretches narration, reuses Long audio for a
Short, or disables Remotion audio. `renderCompositionPlan` remains the renderer.

### Caption isolation

Each target renders `plan.scenes[].captionCues`. Legacy `storyboard.captions`
and `shortCaptions` are never consulted, and Short captions are never derived
from Long captions.

### Object isolation

Each target's plan is **deep-cloned** and then **deep-frozen**, so:

- the caller's input plan is never mutated *and never frozen*;
- one target can never mutate another;
- a mutation attempt on a delivered target throws, leaving everything intact.

---

## 8. Rendering API

`renderProductionDeliveryTargets(...)` in
`apps/api/src/services/plan-delivery.ts`:

- calls the approved Phase 6B `renderCompositionPlan(...)` **once per delivered
  target**;
- duplicates no Remotion logic;
- never calls legacy `renderTarget(...)` or `muxAndEncode(...)`;
- passes each target its own plan, mediaMap and canonical audio.

`frameRangeByTarget` was added to the input so §18's cost control can encode a
small inclusive sub-range. This is a new Phase 6C option only; it passes through
to the existing Phase 6B `PlanRenderInput.frameRange` and never changes a plan
or its timing authority.

### Failure isolation

| Status | Meaning |
| --- | --- |
| `ok` | every covered target rendered |
| `partial` | some targets rendered, some failed |
| `error` | no target rendered |

A failing target never erases the results of the others, and nothing is silently
substituted. Real-render proof is in §11.

### Output path ownership

The caller supplies `outputByTarget`. Phase 6C validates that every covered
target has a path and that no two targets write the same file
(`DELIVERY_TARGET_OUTPUT_MISSING` / `DELIVERY_TARGET_DUPLICATE_OUTPUT`). It does
**not** design the export package — that is Phase 6D.

---

## 9. Error taxonomy

Small and closed, deliberately not a second error framework:

```
DELIVERY_TARGET_MISSING_PLAN
DELIVERY_TARGET_FORMAT_MISMATCH
DELIVERY_TARGET_DIMENSIONS_MISMATCH
DELIVERY_TARGET_FPS_MISMATCH
DELIVERY_TARGET_PROJECT_MISMATCH
DELIVERY_TARGET_DUPLICATE_OUTPUT
DELIVERY_TARGET_INVALID_PLAN
DELIVERY_TARGET_OUTPUT_MISSING
DELIVERY_TARGET_RENDER_FAILED
```

Phase 6B's structural checks are **reused, never duplicated**: any
`validatePlanForRender` finding is surfaced as `DELIVERY_TARGET_INVALID_PLAN`
with the original Phase 6B code in the message (errors fatal, warnings not).

---

## 10. Canonical Long evidence (§15)

Plan built by the real Phase 4 → Phase 5 chain from `scenario-pm-01`.

| Property | Value |
| --- | --- |
| scenarioId / projectId | `scenario-pm-01` / `proj-hospital-expansion` |
| targetFormat | `Long` |
| dimensions | `1920 × 1080` |
| fps | `30` |
| `totalActualDurationSeconds` | **118.74** |
| `durationInFrames` | **3563** (valid frames `0..3562`) |
| scenes | **5** |
| canonical audio refs | **12** |
| caption cues | **28** |
| beats | **12** |
| asset usages | **2** |
| `totalEstimatedDurationSeconds` | `102` (the estimator is **not** the authority) |
| `validatePlanForRender(plan, mediaMap)` | `[]` |

No regression to 102s. The full 3563-frame Long render was **not** repeated; it
is already proven by Phase 6B (`PHASE6B_REAL_PRODUCTION_RENDER_HANDOFF.md`,
`EVIDENCE/phase6b`).

---

## 11. Real Short-plan build evidence (§14)

**Fixture policy:** no Short is produced by patching `width`/`height` on a
finished Long plan.

A significant finding shaped the fixture choice: the canonical
`progress-meeting` scenario **cannot** simply be retargeted to `Short`. Its
102s estimate trips `RULE-021-SHORT-DURATION-CEILING` (65s hard limit) at
`compileScenarioVisualPlan`, so no plan can be built from it. The same applies
to `claim-variation` (89.8s).

`schedule-risk` is the canonical fixture that **is** an approved Short scenario
(41.4s, 3 scenes, already `targetFormat: 'Short'`). It is copied immutably and
retargeted to the Long's `projectId` so both targets share one production while
each keeps its own `scenarioId` — exactly the §9 case. It is then run through
the normal approved pipeline:

```
Scenario → DialogueProductionResult → VisualProductionPlan
        → SceneRenderPlan → RemotionCompositionPlan
```

| Property | Value |
| --- | --- |
| scenarioId / projectId | `scenario-sched-risk-03` / `proj-hospital-expansion` |
| targetFormat | `Short` |
| dimensions | **1080 × 1920** |
| fps | **30** |
| `durationInFrames` | **1470** |
| `totalActualDurationSeconds` | **48.99** |
| scenes / beats | **3** / **7** |
| canonical audio refs | **7** |
| caption cues | **15** |
| asset usages | **0** |
| every scene | `1080 × 1920`, `Short` — the pipeline set it, not a patch |
| `validatePlanForRender(plan, {})` | `[]` |

This proves the existing Phase 5 pipeline can feed Phase 6C with a genuine
Short-format plan.

---

## 12. Real Short render evidence (§18)

`renderProductionDeliveryTargets(...)` → `renderCompositionPlan(...)` →
`VideoPlan` → real encoded MP4. Audio was served by a local HTTP server on
`127.0.0.1`; only the audit-only `canonicalPath` field was rewritten (asserted).

Probed output — **`.stills/phase6c/phase6c-short_1.mp4`** (60 frames):

| Property | Value |
| --- | --- |
| `compositionId` | `VideoPlan` |
| size | **594,407 bytes** (non-empty) |
| `codec_name` | **h264** |
| width × height | **1080 × 1920** |
| `r_frame_rate` | **30/1** |
| duration | 2.048 s (60 frames @ 30fps) |
| `hasAudio` / `audioCodec` | **true** / **aac** |
| `longestSilence` | 0 s (audible canonical dialogue, not silence) |
| `durationInFrames` reported | **1470** — the plan's authority, not the sub-range |
| `authoritativeDurationSeconds` | **48.99** |
| `mediaMapEntryCount` | **1** — the per-target mediaMap reached the renderer |

Companion Long proof (15-frame sub-range, `phase6c-long.mp4`): 294,288 bytes,
h264, **1920 × 1080**, 30/1, aac, `durationInFrames` **3563**,
`renderedFrameCount` **15**.

---

## 13. Failure-isolation evidence (§12, real renders)

Target set `long + short_1 + short_2(invalid dimensions)`:

| Target | Outcome | Evidence |
| --- | --- | --- |
| `long` | success | `phase6c-iso-long.mp4`, 191,150 bytes, 1920×1080, h264/aac |
| `short_1` | success | `phase6c-iso-short_1.mp4`, 195,959 bytes, 1080×1920, h264/aac |
| `short_2` | failure | `DELIVERY_TARGET_DIMENSIONS_MISMATCH`; **no file written** — blocked before rendering |

Overall status `partial`; `succeededTargetIds = ['long','short_1']`,
`failedTargetIds = ['short_2']`, results ordered `long → short_1 → short_2`.
Separately, a target with no output path fails with
`DELIVERY_TARGET_OUTPUT_MISSING` and writes nothing, while the other target
still renders.

---

## 14. Regression results

| Group | Files | Tests | Result |
| --- | --- | --- | --- |
| **Baseline full suite** (before Phase 6C) | 41 | 707 | passed |
| **Phase 6C — `phase6c-delivery-targets`** | 1 | **54** | passed |
| **Phase 6C — `phase6c-real-short-render`** | 1 | **5** | passed |
| Phase 6B — `phase6b-plan-render` | 1 | 44 | passed |
| Phase 6B — `phase6b-real-render` | 1 | 5 | passed |
| Phase 6A — `production-asset-resolution` | 1 | 28 | passed |
| Phase 6A — `phase6a-renderer-assets` | 1 | 15 | passed |
| Phase 6A — `phase6a-production-assets-integration` | 1 | 7 | passed |
| Phase 5C — `remotion-composition` + `…-integration` | 2 | 22 | passed |
| Phase 5D — `audiovisual-sync` | 1 | 28 | passed |
| Phase 5E — `phase5-closure` | 1 | 19 | passed |
| **Focused regression run** | **11** | **227** | **passed** |
| **Full suite after Phase 6C** | **43** | **766** | **passed** (+59 = 54 + 5) |

Tooling:

| Check | Command | Result |
| --- | --- | --- |
| Core typecheck | `npm run build:core -- --noEmit` | passed |
| Web typecheck | `npx tsc --noEmit -p apps/web/tsconfig.json` | passed |
| Production build | `npm run build` | passed |
| Test-count guard | `node scripts/assert-test-count.mjs` | **766 ≥ 300** passed |
| Whitespace | `git diff --check` | clean |

The Phase 6B full 3563-frame canonical render was **not** re-run.

The 20 required negative cases (§25) are all covered, plus extras: missing Long
plan, Long marked invalid, Long with Short format, Long wrong dimensions, Long
wrong fps, Short with Long format, Short wrong dimensions, Short wrong fps,
projectId mismatch, requested Short missing plan, duplicate output paths,
missing output path, invalid Short isolated from valid Long, mediaMap isolation,
no Long-plan mutation, no Short-plan mutation, deterministic repeated build,
canonical ordering, legacy `Scene[]`/`TargetMedia` rejected as plan authority,
and no Long audio/caption fallback into a Short.

---

## 15. Limitations

1. **Phase 6C does not create editorial Short content.** It does not extract,
   crop, trim, summarise or otherwise derive a Short from a Long scenario. It
   only delivers Long/Short `RemotionCompositionPlan`s that were already
   approved and supplied. Content extraction belongs to a later phase.
2. **Short fixtures reuse one approved Short scenario.** `short_1`, `short_2`
   and `short_3` are three independently-identified Short plans built by the
   real pipeline from the canonical `schedule-risk` Short fixture (§17
   explicitly does not require three different creative Shorts). They prove
   ordering, identity and isolation — not creative variety.
3. **`schedule-risk` is the only canonical fixture that compiles as a Short.**
   `progress-meeting` (102s) and `claim-variation` (89.8s) both exceed the 65s
   `RULE-021-SHORT-DURATION-CEILING`. A Long scenario therefore cannot be
   retargeted to Short without content work that is out of scope here.
4. **The canonical Short plan declares zero asset usages**, so pixel-level media
   visibility is not applicable to it. mediaMap reach is proven by
   `mediaMapEntryCount`; pixel-level media visibility is already proven on the
   Long by Phase 6B (`EVIDENCE/phase6b/sc02_media_visibility.json`).
5. **Output-path collision detection is textual** (separator-normalised), not
   resolved against the filesystem, so it stays free of cwd influence.
6. **Real renders need the provisioned Chromium** (`npm run provision`) and skip
   cleanly without it, matching the Phase 6B convention and the CI note that the
   render is deliberately not run there.
7. **Phase 6D work is untouched**: export package layout, final QC package,
   publishing metadata, contact sheets, SRT/VTT, thumbnails, delivery manifest,
   zip/archive, upload/publishing and analytics.

---

## 16. Exact files changed

**New**

| File | Purpose |
| --- | --- |
| `packages/core/src/scenario/delivery-target-types.ts` | contract, IDs, locked specs, error taxonomy, render types |
| `packages/core/src/scenario/delivery-target-pipeline.ts` | target build, per-target validation, identity policy, isolation |
| `apps/api/src/services/plan-delivery.ts` | `renderProductionDeliveryTargets` delegating to Phase 6B |
| `tests/phase6c-delivery-targets.test.ts` | 54 contract tests |
| `tests/phase6c-real-short-render.test.ts` | 5 real-render tests |
| `PHASE6C_DELIVERY_TARGETS_HANDOFF.md` | this document |

**Modified**

| File | Change |
| --- | --- |
| `packages/core/src/scenario/index.ts` | two `export *` lines for the new modules (minimal, as allowed) |
| `.gitignore` | added `.test-phase6c/` |

**Why `.gitignore` was unavoidable:** `buildDialogueProductionPlan` rejects
absolute paths (`basePath must be relative`), so test scratch audio must live at
a repo-relative path, and a repo-relative scratch directory must be ignored or
the generated audio would be committed. `.test-phase6c/` follows the existing
`.test-phase6b/` convention exactly. This is the only file changed outside the
§23 list.

**Explicitly NOT touched:** `apps/api/src/services/pipeline.ts`,
`packages/core/src/targets.ts`, `packages/core/src/qc.ts`, `apps/web/**`, all
Phase 6A sources, and the Phase 6B render contract. `LongVideo` and
`ShortVideo` remain available as backward-compatible legacy paths.

No Phase 6B defect was discovered, so no Phase 6B file was changed.

---

## 17. Safe to close Phase 6C?

**Yes.**

- Aligned to the exact approved baseline `c9ac48f5…` before any edit.
- Only Phase 6C work implemented; no Phase 6B redesign and no Phase 6D work.
- The contract is complete: IDs, ordering, Long rules, Short rules, identity
  policy, mediaMap/audio/caption isolation, per-target failure isolation,
  caller-owned output paths and determinism.
- Real Short-format rendering is proven end to end with probed encoded output.
- Full suite green: **766 passed / 43 files** (+59), plus core typecheck, web
  typecheck, production build, test-count guard and `git diff --check` clean.

No blockers or conflicts.
