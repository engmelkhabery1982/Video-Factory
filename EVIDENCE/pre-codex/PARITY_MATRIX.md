# Parity matrix — legacy workflow vs production workflow (pre-Codex)

Scope: what the repository's operator-facing documents (`REVIEW_HANDOFF.md`,
`EVIDENCE/final-product/README.md`, the Phase handoffs) claim, mapped against
the **live source in this repository at the product-closure commit**.

Status vocabulary (deliberately strict):

| Status | Meaning |
| --- | --- |
| **production** | Implemented in the production engine (`Scenario → production dialogue audio → Phase 5 plan → Phase 6A asset resolution → Phase 6C render → Phase 6D package`) and reachable from the production UI/API for production projects. |
| **legacy-only** | Implemented only on the original Storyboard path (`storyboard.scenes[]`, `storyboard.captions`, `storyboard.targetAudio`, the legacy `VisualHistory` log). It still works for legacy/reference projects, but it is **not** the authority for a production project. Never described here as "implemented" for production. |
| **superseded** | The legacy feature existed; a production authority replaces it. The legacy code remains for backward compatibility only. |
| **not implemented** | No working code path; a deliberate later capability. |

Evidence column: the file that establishes the claim. Where a claim is
legacy-only, the production replacement is named in the "Production authority"
column.

## 1. Script, planning and generation

| Capability | Status | Evidence | Production authority |
| --- | --- | --- | --- |
| Project input (topic, script, numbers, CTA, brand preset) | production | `apps/api/src/routes/projects.ts` `POST /api/projects`, `PUT /api/projects/:id` | `packages/core/src/scenario/script-scenario-generator.ts` |
| Long + Short scenarios with characters, evidence, captions, timings | production | `generateProductionScenariosFromProjectInput` (`packages/core/src/scenario/script-scenario-generator.ts`) | same |
| Legacy Storyboard generation (`Scene[]`, variants, transitions, hooks) | legacy-only | `apps/api/src/services/pipeline.ts` `exportProject`, `POST /api/projects/:id/storyboard` | Scenario generation (above) |
| Anti-repetition across videos | production | `packages/core/src/scenario/scenario-style-history.ts`, `apps/api/src/services/production-state.ts` (`production_history.json`) | production casting/style history |
| Legacy visual history (`visual_history.json`: hook variant, CTA animation, caption style, scene order) | legacy-only (preserved) | `apps/api/src/services/store.ts` (`loadHistory`), `packages/core/src/visual-history` consumer in the legacy pipeline | production history (above); surfaced in the UI as "Legacy/reference projects only" |
| Voice-assignment supersession (persona → voice slot) | production | `packages/core/src/scenario/script-scenario-generator.ts` `VOICE_SLOT_BY_PERSONA`; documented in §4 | generated `voiceSlot` per character is the authority; the legacy manual voice picker does not affect production audio |

## 2. Editing

| Capability | Status | Evidence | Production authority |
| --- | --- | --- | --- |
| Scene edit / regenerate scene | production | `PATCH /api/projects/:id/production/scenes/:target/:sceneId`, `patchProductionScene` (`apps/api/src/services/production-engine.ts`) | production scene patch (invalidates builds/artifacts/readiness) |
| Dialogue (turn) edit incl. `spokenText` | production | `PATCH /api/projects/:id/production/turns/:target/:turnId`, `patchProductionTurn` | re-synthesis on the next build (per-turn WAV path is overwritten; see §4) |
| Scene lock / unlock | production | `patchProductionScene` lock contract; `SCENE_LOCKED` (409) | unlock-only contract: `{locked:false}` alone unlocks; a locked scene rejects `{locked:false, …edit}` |
| Single-scene regeneration ("re-roll this scene") | production (deterministic equivalent) | `POST /api/projects/:id/production/scenes/:target/:sceneId/reroll` → `rerollProductionScene` (`apps/api/src/services/production-engine.ts`); UI button on the Production Storyboard | rotates ONLY the scene's visual treatment (shot, framing, camera movement) to the next combination in the canonical cycles that still validates. Dialogue, evidence, captions and audio timing are untouched; locked scenes refuse with `SCENE_LOCKED` (409). Covered by `tests/product-closure-focused.test.ts` |
| Legacy `POST /regenerate-scene/:sceneId` (Storyboard variant re-roll) | legacy-only | `apps/api/src/services/pipeline.ts` | production re-roll (above) |
| Legacy caption editing (`PATCH /captions/:cueId`, `POST /captions/rebuild`) | superseded | `apps/api/src/routes/projects.ts`, `apps/web/src/pages/Storyboard.tsx` | production captions are reconciled from the production audio (`GET /api/projects/:id/production/captions/:target`); the Captions page in production mode does not offer manual timing edits |

## 3. Media and assets

| Capability | Status | Evidence | Production authority |
| --- | --- | --- | --- |
| Asset library (upload, tags, status, source/license) | production | `POST /api/assets` (order-independent multipart), `apps/api/src/routes/assets.ts` | same |
| Bind a library asset to a generated media slot | production | `PUT /api/projects/:id/production/assets/:target/:logicalRef` | `setProductionAssetBinding`; only genuine generated slots are accepted (`ASSET_REF_NOT_IN_SCENARIO`, 422) |
| Clear a binding (legacy/stale included) | production | `DELETE` on the same route | `setProductionAssetBinding(..., null)` |
| Eligible assets for generated slots | production (images only) | `assetBindingEligibility` (`apps/api/src/routes/assets.ts`), `GET /api/projects/:id/production/assets` (`eligibleRule`, `ineligible[]`) | active + unblocked + real source/license + MIME `image/*`; non-image kinds (`broll`, `sfx`, `font`, `document`) are excluded with a reason |
| B-roll **video** in generated slots | **not implemented** (deliberate) | `NON_IMAGE_ASSET_KINDS` exclusion; no video code path for generated slots | future capability; never claimed in UI |
| Asset `usedIn` after real use | production | `production-engine.ts` final-build hook + `usedInUpdatesFromPlans` | only after a successful final production with zero blocking findings |

## 4. Audio

| Capability | Status | Evidence | Production authority |
| --- | --- | --- | --- |
| Per-turn production dialogue audio (Kokoro, local model) | production | `packages/core/src/scenario/kokoro-dialogue-synthesizer.ts`, `dialogue-production-pipeline.ts` | project-scoped `.production/<videoId>/audio/{dialogue,canonical}` |
| Voice slots per character (≥2 distinct voices, deterministic) | production | `VOICE_SLOT_BY_PERSONA` / `VOICE_SLOT_BY_KEY` in the generator | generated `voiceSlot`; **supersedes** the legacy manual voice assignment for production audio |
| Canonical 48 kHz mono PCM16 normalization | production | `packages/core/src/scenario/audio-probe.ts`, `audio-normalization*` | canonical manifest per target |
| Timing authority = reconciled actual audio durations | production | `packages/core/src/scenario/reconcile-timing.ts` | captions and playback are reconciled from the produced audio |
| Legacy `targetAudio` (manually uploaded per-target voiceover) | legacy-only | `apps/api/src/routes/target-audio.ts`, `apps/web/src/components/TargetAudioPanel.tsx` | hidden in production mode (`Captions.tsx` production branch does not render it) |
| Stale audio reuse after a dialogue edit | **prevented by construction** | `synthesize-dialogue.ts` always (re)synthesizes to a deterministic per-turn path and overwrites it (no synthesis cache exists in the repo — verified by search) | covered by `tests/production-regeneration-invalidation.test.ts` |

## 5. Rendering, delivery and QC

| Capability | Status | Evidence | Production authority |
| --- | --- | --- | --- |
| Production preview build (plan-based, production audio, reduced quality) | production | `POST /api/projects/:id/production/preview` → job | `startProductionJob` (`kind: 'preview'`) |
| Production final export (plan-based + Phase 6D package) | production | `POST /api/projects/:id/production/export` → job | `startProductionJob` (`kind: 'final'`) |
| Job polling for production builds | production | `GET /api/projects/:id/production/jobs/:jobId` | production job registry |
| Phase 6D deterministic package (manifest, checksums, per-target QC) | production | `packages/core/src/scenario/delivery-package-pipeline.ts` | package contract untouched by the product kit |
| Production product kit (publishing kit, provenance, readiness, thumbnails, contact sheets) | production | `apps/api/src/services/production-deliverables.ts` | separate kit with its own `manifest.json` + `checksums.sha256`; the Phase 6D package keeps its own |
| ≥3 thumbnails from the completed Long MP4 + contact sheets | production | `writeThumbnailsAndSheets` (ffmpeg `extractPoster` / `contactSheet`) | extracted from the rendered MP4, never re-rendered |
| Legacy export (`POST /api/projects/:id/export`, `exportProject`) | legacy-only | `apps/api/src/routes/projects.ts`, `apps/api/src/services/pipeline.ts` | production export; the production Export page never calls it |
| Legacy target-specific QC (`POST /api/projects/:id/qc`, `runQc`) | superseded | `apps/api/src/services/pipeline.ts` | production readiness QC (`buildProductionReadiness`, `readiness.json`); the legacy dimensions it replaces are listed in `supersededLegacyQcDimensions` |
| Readiness can never be READY with a blocking finding | production | `buildProductionReadiness` (`readyForProductionDelivery` requires kind `final`, zero errors and package `ready`) | `tests/production-deliverables.test.ts` |
| Stale builds/artifacts/QC/ready cleared on regeneration | production | `generateProductionState` invalidation + `isStaleAgainstInput` guards on preview/export/build | `tests/production-regeneration-invalidation.test.ts` |

## 6. Operator surfaces

| Surface | Production project | Legacy/reference project |
| --- | --- | --- |
| Project list (`ProjectList.tsx`) | production status (stale/needs regeneration), targets, build/artifact counts, readiness tag, real `production_history` casting table | legacy status, scenes/shorts, artifacts, legacy visual history table (labelled) |
| Production Storyboard (`ProductionStoryboard.tsx`) | production authority for wording, scene/turn edits, binding picker with images-only rule | n/a |
| Captions (`Captions.tsx`) | reconciled production captions per target, no manual timing edits, no `TargetAudioPanel`, points at the Production Storyboard for wording | original legacy caption editor unchanged |
| Export (`Export.tsx`) | production status/readiness/preview/final/job polling + production artifacts, package and kit links | original legacy export/QC page unchanged |
| Assets (`Assets.tsx`) | library management (shared) | same |
| Storyboard (`Storyboard.tsx`) | legacy editor (still reachable; explicit "Legacy project" labelling on the production-aware pages) | legacy editor |

## 7. Known gaps (explicit, not hidden)

1. **Single-scene regeneration** — implemented as a deterministic production
   equivalent (visual-treatment re-roll, see §2). It deliberately rotates only
   the visual treatment: dialogue/evidence/timing stay with the Scenario and
   audio authorities, so the legacy Storyboard's "re-roll everything about a
   scene" behaviour is intentionally *not* reproduced.
2. **B-roll video assets for generated slots** — deliberately excluded (images
   only); no UI claim to the contrary.
3. **Manual voice assignment in production** — superseded by generated voice
   slots; the legacy panel is hidden in production mode instead of pretending to
   affect the production mix.
4. **Legacy visual history as production authority** — explicitly not the case:
   production generation consumes `production_history.json`; the legacy log is a
   fallback only for projects that have no production observations yet.
