# Dialogue / Character Visual Production Handoff — Workstream C (Final Production Integration)

**Branch**: `arena/01a0f40b-video-factory`
**Baseline SHA**: `0ffccfcb78b967e9855fdfbe154e335b33313537` (merge of Workstream A + Workstream B)
**Nature**: closes ONLY the "dialogue scenarios still look like explanatory cards" gap. No visual-system redesign, no audio/timing change, no rendererKey taxonomy rewrite, no API/Web/audio/Phase 6 delivery changes, no full video render.
**Parallel workstream**: Freebuff owns Product Integration in parallel. Strict file ownership was respected (§7).

---

## 1. The gap that was closed

The Scenario / Phase 5 contracts already preserved everything a dialogue renderer
needs:

- `participantIds`, `speakerIds`, `activeSpeakerId`, `reactingCharacterId`
- `shot.shotType`, `shot.framing`, `shot.speakerFocus`, `shot.cameraMovement`, `shot.focusCharacterId`
- `intent`, `delivery`, `spokenText`
- `ReconciledCaptionCue.speakerId`

But `PlanSceneRenderer` converted **every** scene into the legacy generic
Hook / Explanation / CTA renderer. The engine understood dialogue and
characters; the final video still looked like explanatory cards with names
attached.

The renderer received **IDs only** — no name, role or narrative function — so it
had nothing to present a character with even if it had wanted to.

---

## 2. What was added

### 2.1 Render-facing character contract (core)

`packages/core/src/scenario/scene-render-types.ts`
- `SceneRenderCharacter` — a deterministic, read-only projection of
  `ScenarioCharacter`: `{ id, name, role, narrativeFunction, visualDescription }`.
  The Scenario model stays authoritative and is **not duplicated**: no
  behavioural state, no timing, no audio.
- `DIALOGUE_MIN_PARTICIPANTS = 2`.
- `isDialogueCapableScene(scene)` — the single shared detection rule used by
  both the core pipelines and the video renderer, so they can never disagree:
  **at least one `dialogue` beat AND at least 2 participating characters.**
- `SceneRenderPlan.characters` — every Scenario character, in Scenario order.
- `SceneRenderSpec.participants` — resolved presentation metadata, in
  `participantIds` order. IDs are preserved exactly; ids that do not resolve to
  a Scenario character are omitted here (they remain in `participantIds`).

`packages/core/src/scenario/scene-render-pipeline.ts`
- Projects `scenario.characters` once into the render shape and resolves each
  scene's participants. Pure projection; nothing invented, nothing rewritten.

`packages/core/src/scenario/remotion-composition-types.ts`
- `RemotionCompositionPlan.characters` and `RemotionSceneCompositionSpec.participants`
  carry the same data through Phase 5C unchanged.

`packages/core/src/scenario/remotion-composition-pipeline.ts`
- Copies `characters` and per-scene `participants` through.

**Flow is unchanged:** `Scenario character data → SceneRenderPlan → RemotionCompositionPlan → PlanSceneRenderer`.

### 2.2 Dialogue visual component (video)

`packages/video/src/scenes/DialogueScene.tsx` (new)
- Uses the existing brand/theme primitives (`FONTS`, `LAYOUT`, `SHORTS_UNSAFE`,
  `Theme`). No second visual system.
- **The current local frame selects the active beat** via `selectBeat()`, which
  clamps (before-first → first, past-last → last). All intervals come from
  `localStartFrame` / `localEndFrame`, which Phase 5C derived from the
  authoritative Phase 4 reconciled timing. **Timing is never re-estimated.**
- Pure, exported, unit-testable helpers: `resolveDialogueFocus`,
  `compositionForShot`, `isEvidenceBeat`, `cameraOffset`, `selectBeat`.
- Invisible `data-dialogue-*` diagnostic markers (same pattern as the existing
  `data-buildtrack-resolved-media`) carry no styling and make the shot/focus/
  plane decisions assertable.

`packages/video/src/scenes/PlanSceneRenderer.tsx`
- New `shouldRenderAsDialogue(scene)` — `isDialogueCapableScene(scene) && rendererCategory !== 'cta'`.
- `dialogue-capable scene → DialogueScene`, otherwise the **existing legacy
  `SceneRenderer`**. CTA/end-card scenes keep their existing CtaCard renderer.
- **The authoritative `rendererKey` is neither consulted nor rewritten** — it
  stays preserved for traceability and Phase 6 regression compatibility.

### 2.3 Speaker-aware captions (video)

`packages/video/src/captions/Captions.tsx`
- New `SpeakerAwareCaptionCue extends CaptionCue` with optional
  `speakerId` / `speakerName` / `speakerRole`. Because the extra fields are
  optional, every existing caller passing plain `CaptionCue[]` keeps working
  unchanged.
- A compact speaker identity (`● Name · Role`) renders as its **own element
  above** the caption text, in all six caption styles. The spoken text is never
  modified and never gains the speaker name.
- Non-dialogue captions (no resolved speaker) render pixel-identically to before.

`packages/video/src/compositions/VideoCompositionPlan.tsx`
- New exported pure `buildSpeakerAwareCaptionCues(plan)` — resolves
  `cue.speakerId` against `plan.characters`, copies `text` / `start` / `end`
  through untouched, deterministic ordering. Exactly **one** caption layer.

---

## 3. Character presentation (faceless professional channel)

No generated human photos, no network calls, no image generation. Each
participant is a stylised professional presentation:

- rounded silhouette with the character's initials, plus a stylised
  head-and-shoulders shape
- a role glyph badge derived from `narrativeFunction`
  (`challenger ▲`, `technical_authority ◆`, `decision_maker ■`, else `●`)
- a name plate, the professional role, and the narrative function tag
- **active speaker emphasis**: full opacity, accent ring + halo, larger plate
- **reacting character treatment**: reduced opacity, no ring, smaller plate
- distinct visual positioning per composition archetype
- a deterministic on-brand tint per character (stable hash of the character id),
  so cast members stay distinguishable without leaving the brand palette

`visualDescription` is available to the renderer for deterministic styling but
is not used to generate imagery.

---

## 4. Shot semantics — implemented and proven distinct

| shotType | Composition | Behaviour |
|---|---|---|
| `two_shot` | `two_shot` | Two characters visible, balanced framing; exactly one visual lead (the focused one); `framing` decides left/right placement |
| `close_up` | `close_up` | Focused/active character dominates the frame at lead scale; reaction present only as a small corner strip |
| `medium` | `medium` | Speaker prominent at lead scale with the secondary reaction context beside it |
| `over_the_shoulder` | `over_the_shoulder` | Reacting/secondary participant in the **foreground** (larger, `data-dialogue-plane="foreground"`), focused speaker **behind** (`"background"`, reduced opacity) |
| `wide` | `wide` | Both participants at moderate scale plus a broader environment/context band derived from `locationId` |
| `screen_insert` / `point_of_view` / `detail_macro` / unknown | `insert` | Evidence/insert context leads; participants remain as a compact strip so the conversation stays legible |

Additional steering:
- `speakerFocus === 'document'` or `'shared_display'`, or any `evidenceIds`,
  routes the beat to the `insert` (evidence) composition.
- `speakerFocus === 'reacting_character'` routes the visual lead to the reactor.
- `speakerFocus === 'group'` (the `wide` case) leaves neither participant dominant.
- `focusCharacterId` takes precedence when it resolves to a known participant;
  an unresolvable id degrades to the active speaker.
- `framing` (`center` / `rule_of_thirds_left` / `rule_of_thirds_right` /
  `symmetric`) steers placement.
- `cameraMovement` produces **subtle deterministic movement only**, a pure
  function of beat progress: `slow_push` scale 1→1.028, `slow_pull` 1.03→1.002,
  `pan_left`/`pan_right` ±14 px, `subtle_drift` ±7 px, `static` none. No timing
  or narrative change.

### Focus resolution precedence (deterministic)
1. `shot.focusCharacterId` when it resolves to a known participant
2. `speakerFocus === 'reacting_character'` → the reacting character
3. otherwise the active speaker

`reactingCharacterId` is the **only** source of the reaction identity. It is
never invented and never taken from `activeSpeakerId`; when it is `null` no
reaction plate is drawn.

---

## 5. Long + Short layout

Long (1920×1080): landscape row layouts, `LAYOUT.long.safe` (96 px) insets.
Short (1080×1920): **native portrait, not a cropped Long** —
- participants stack vertically
- top inset ≥ `SHORTS_UNSAFE.top.height + 24` (244 px), clear of the platform
  risk zone
- bottom inset ≥ 640 px, clear of the caption band, so captions never cover
  faces or role plates
- side inset `LAYOUT.short.safe` (72 px)
- evidence/media panels re-flow for portrait and stay legible

Both orientations assert `data-dialogue-orientation`, `data-dialogue-width`,
`data-dialogue-height` and the three safe insets.

---

## 6. Asset / media compatibility

- `mediaUrl` still reaches the dialogue scene and is passed through
  `PlanSceneRenderer` exactly as before.
- The evidence/insert panel renders the Phase 6B DOM contract verbatim:
  `data-buildtrack-resolved-media={mediaUrl}` plus
  `background-image: url(...)`, so canonical Phase 6B asset-visibility
  behaviour remains compatible.
- No `rendererKey` mutation is performed to show an asset.
- No change to Phase 6A `mediaMap` direction.
- With no mediaMap / no resolved URL, no media element is emitted and no URL is
  fabricated — the dialogue still renders.

---

## 7. Tests

`tests/dialogue-visual-production.test.ts` — **28 tests, 20 required gates**
(all 20 required gates plus 8 supporting gates: 3, 9b, 9c, 12b, 15b, 16b, plus
determinism and beat-selection coverage).

Remotion is mocked (no browser, no bundling, no video render). The mocked
`useCurrentFrame` is controllable, which is how "the current local frame
determines the active beat" is exercised directly.

| # | Gate | Proof |
|---|---|---|
| 1 | character metadata survives Scenario → SceneRenderPlan | plan `characters` equals Scenario order and fields; per-scene `participants` equals `participantIds` |
| 2 | character metadata survives → RemotionCompositionPlan | `plan.characters` deep-equals `SceneRenderPlan.characters`; per-scene `participants` deep-equal |
| 3 | dialogue scene detection works | truth table on `isDialogueCapableScene`; 4 real conversation scenes true, CTA scene false |
| 4 | generic non-dialogue rendering unchanged | no-beat scene renders the legacy headline, zero dialogue plates |
| 5 | two_shot → two-character layout | 2 plates, exactly one lead, both on the stage plane |
| 6 | close_up focuses active speaker | focused character is the sole lead, reaction is a single support plate |
| 7 | medium → active + reaction context | speaker leads, reaction still on screen |
| 8 | over_the_shoulder focus/reaction orientation | reactor on `foreground`, focused speaker on `background` |
| 9 | wide → broad two-character composition | 2 plates + location context band, `speakerFocus: group` |
| 10 | speaker switch changes active identity | beat A vs beat B: active speaker, lead plate and reaction all flip |
| 11 | reactingCharacterId respected | present → reaction plate; `null` → no plate invented |
| 12 | focusCharacterId respected | overrides the active speaker; `reacting_character` focus routes to the reactor; unknown id degrades to the speaker |
| 13 | speaker-aware caption resolves name/role | Sarah→"Sarah Jenkins"/"Project Manager", Marcus, David |
| 14 | caption text byte-identical | every cue's `text` deep-equals the reconciled cue; no name folded in |
| 15 | caption timing unchanged | `start`/`end` equal the reconciled seconds; monotonic, deterministic |
| 16 | mediaUrl still reaches dialogue scene | direct, via `PlanSceneRenderer`, and negative (no mediaMap) |
| 17 | Long dimensions safe | 1920×1080, landscape, 96 px insets, no dropped participants |
| 18 | Short dimensions safe | 1080×1920, portrait, top ≥244 px, bottom ≥640 px, side 72 px |
| 19 | rendererKey unchanged | unchanged before/after render for every scene |
| 20 | no audio/timing mutation | deep-equality of every scene and the whole plan across rendering; audio and beat windows explicitly verified |

### Still-frame rendering
Remotion's mocked-DOM harness (`happy-dom` + `react-dom`) is available cheaply
and is used throughout: every shot-semantics and layout gate above renders real
React output at a chosen local frame (speaker A active, speaker B active, Long
landscape, Short portrait). No browser/Chromium still render and **no complete
video render** was performed.

---

## 8. Regression & verification

| Check | Result |
|---|---|
| `tests/dialogue-visual-production.test.ts` (new) | **28 passed** |
| `tests/scene-render.test.ts` + integration | **17 passed** |
| `tests/remotion-composition.test.ts` + integration + smoke | **24 passed** |
| `tests/phase5-closure.test.ts` (Phase 5E) | **19 passed** |
| `tests/phase6a-renderer-assets.test.ts` + integration | **22 passed** |
| `tests/phase6b-plan-render.test.ts` (Phase 6B contract) | **44 passed** |
| Regression total | **154 passed / 0 failed** |
| `npx tsc -p packages/core/tsconfig.json --noEmit` | exit 0 |
| `npm run typecheck` (core + web) | exit 0 |
| `npm run build` | exit 0 |
| `git diff --check` | clean |

Full real-render tests (`phase6b-real-render`, `phase6c-real-short-render`,
`phase6d-real-package`) were **not** run, as instructed.

### Video-package typecheck note
`packages/video` has no `tsconfig.json`, so it is not strictly typechecked by
`npm run typecheck`. I typechecked it out-of-band against `tsconfig.base.json`
and confirmed **zero new errors**: the pre-existing baseline is 15 errors
(9 `Root.tsx`, 2 `Explanations.tsx`, 4 `Hooks.tsx` — duplicate object keys and
loose `Composition` prop typing), all in files this workstream did not touch,
and that count is unchanged. `DialogueScene.tsx`, `PlanSceneRenderer.tsx`,
`Captions.tsx` and `VideoCompositionPlan.tsx` are clean.

---

## 9. Confirmation of untouched areas

No changes were made to:
- `apps/api/**`, `apps/web/**`
- `package.json`, `package-lock.json`
- Scenario generator files (`script-scenario-generator.ts` and friends)
- Kokoro / audio synthesis files, voice registry / resolver
- Phase 6 delivery / package services
- `.github/**`, `scripts/phase6e-full-production-evidence.ts`
- `packages/core/src/types.ts` (the core `CaptionCue` contract) — the
  speaker-aware cue type lives in the video package instead
- `packages/core/src/scenario/plan-render-validation.ts` (Phase 6B
  `MEDIA_CONSUMING_RENDERER_KEYS`) — the rendererKey taxonomy is untouched

Files changed by this workstream:
```
packages/core/src/scenario/scene-render-types.ts            (character contract + detection rule)
packages/core/src/scenario/scene-render-pipeline.ts         (resolve + thread characters)
packages/core/src/scenario/remotion-composition-types.ts    (character fields)
packages/core/src/scenario/remotion-composition-pipeline.ts (thread characters)
packages/video/src/scenes/DialogueScene.tsx                 (NEW — dialogue component)
packages/video/src/scenes/PlanSceneRenderer.tsx             (dialogue routing, rendererKey preserved)
packages/video/src/captions/Captions.tsx                    (speaker-aware caption layer)
packages/video/src/compositions/VideoCompositionPlan.tsx    (speaker resolution, pure cue builder)
packages/video/src/Root.tsx                                 (emptyPlan gains characters: [])
tests/dialogue-visual-production.test.ts                    (NEW — 28 tests / 20 gates)
WORKSTREAM_C_DIALOGUE_VISUAL_HANDOFF.md                     (this document)
```

---

## 10. Known follow-ups (not blockers)

1. **`packages/video` has no tsconfig** — it is only typechecked transitively
   by the Remotion bundler. Adding one would surface the 15 pre-existing errors
   above. Out of scope here.
2. **No fixture scene uses `over_the_shoulder`** — that archetype is proven with
   a synthetic spec built from real character data (gate 8). A future scenario
   fixture exercising it end-to-end would be welcome.
3. **`captions` are a single global layer** — the speaker chip is resolved from
   the plan's character context. If a future composition ever renders captions
   per-scene, the same `SpeakerAwareCaptionCue` shape applies unchanged.
