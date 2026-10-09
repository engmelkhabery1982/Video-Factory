# Phase 0A checkpoint — caption timing, target-specific QC, Short narration

> Newest checkpoint; the Phase 0 section below remains accurate except where noted here.

## Sync gate
Session branch `arena/01a0ed0c-video-factory` was already at the approved source `e10d556db1b5379558061efe5222bbf2256045b7` (= `origin/arena/01a0ed0c-video-factory`; clean tree, tree `357d215b` identical). Baseline: 71/71 tests, build passes.

## Fixes
1. **Burned captions (seconds vs frames).** `Captions.tsx` compared `useCurrentFrame()` (frames) with `cue.start/end` (seconds), so a 1–2 s cue was visible only on frame 1. The pure helpers in `packages/video/src/captions/timing.ts` now convert through `useVideoConfig().fps`. The entrance animation starts at `round(start*fps)`. Stored cues stay in seconds.
2. **Target-specific QC.** `targetStaticQc(storyboard, 'long'|'short_N')`:
   - A Short report covers only that Short's structure, pacing, hook and captions.
   - The Long report covers only the Long.
   - The project similarity gate is attached only when it blocks.
   - `staticQc` remains the explicit project-wide check; the export pre-gate now runs it as `target: 'project'`, writing `qc_project.*`.
   - `shortKeyNumberFindings`: only numbers the Short uses are checked, against the Short's own screen. A Short that uses none gets "not applicable". Long scenes are never used as evidence.
3. **No repeated Short narration.**
   - The spoken hook is one complete short thought (≤6 spoken words, ≤3 s), and the hook headline is that same text.
   - Normalised sentences are de-duplicated across the Short, including any body sentence that restates the hook.
   - Long sentences are split into balanced visual beats of ≤6 spoken words.
   - A spoken-word budget (68 at 2.2 words/s) keeps each Short speakable in 20–35 s.
   - The result is deterministic.
4. **Realistic narration rate.** The demo voice runs at natural speed 62, with at most a 10% nudge (speed 56). Above 34 s or 3.2 words/s the generator throws `Short narration is too long: <target> …`. Text is never cut.
5. **Timing.**
   - The generator writes `<Id>_short_N.timing.json` (exact per-scene speech durations). `fitShortToAudio` uses it when the texts match; otherwise it uses bounded weights (hook ≤3 s, body 1.5–3.2 s).
   - The hook's trailing pause is trimmed, and short beats are padded with silence to 1.55 s.
   - Long timing is untouched.

## Before → after (`EVIDENCE/phase0a/phase0a_before_after.json`)
- Duplicate narration sentences across the 9 demo Shorts: **14 → 0**
- `short_1` static-QC findings belonging to other Shorts (audio-fitted): **5 → 0**
- Demo Short voice speed: 30–46 (Phase 0) → 56–62 (`short_1`: 62, 2.15 words/s)
- `tests/phase0a.test.ts` cannot even load at `e10d556` (`phase0a_before_fix.txt`)

## Validation
- 89 tests passed (71 existing plus 18 new in `tests/phase0a.test.ts`).
- Test-count guard: stable floor 75 (documented in the script), no longer tied to the exact total.
- Core and web strict typechecks, build and API ad-hoc strict tsc: pass. Doctor: ready. `git diff --check`: clean.
- Lint: **not configured (gap)**.
- Video package: no typecheck is configured. An ad-hoc strict tsc reports errors that already existed in `Root.tsx`, `Explanations.tsx` and `Hooks.tsx`; none in the files changed here.

## Bounded render — Video_01 short_1 only
- `output/Video_01/shorts/Video_01_short_1_final.mp4` (gitignored): **27.77 s**, 1080×1920 h264 30 fps, AAC 48 kHz
- Timing: hook **2.93 s**, body **1.55–2.74 s**, CTA 5.05 s
- QC **PASS: 0 critical, 0 warn**; no findings from other targets
- Audio envelope correlates **1.00** with `Video_01_short_1.mp3` and **0.052** with the Long
- 12 cues, each inside its own `short_1` scene; caption text = spoken text = scene narration; 0 duplicate sentences; hook not repeated
- Caption style this render: `highlight_box`. Captions are visible in all 5 sampled frames (`caption_frames.json`; accent chip plus dark glyphs; none at t=0).
- Evidence in `EVIDENCE/phase0a/`:
  - Target-specific captions: `Video_01_short_1.srt`, `.vtt`
  - QC report: `qc_short_1.{json,md}`
  - Contact sheet: `Video_01_short_1_contact.jpg`
  - 5 full-resolution frames: `short_1_cue*.png`
  - Verification: `short_1_verification.json`

## Observations (not changed; out of scope)
- The hook variant in this render shows "BEFORE / AFTER" labels, not the hook headline, so the hook sentence appears only as the caption.
- The "EVIDENCE" card on body scenes repeats a generic line (existing content generator).
- At about 21 s the caption chip slightly overlaps the bottom of a card.
- Other Shorts: V01 short_2 hook measures 4.2 s → **fixed** by the stat-hook change (now "70 vs 59.5"); regenerated audio not re-measured per scene here. V02 short_2 hook 3.26 s (would warn). Not rendered, by design.

---

# Phase 0 checkpoint — target-specific audio and captions

> This section is the newest checkpoint. Earlier sections below describe the
> reviewed baseline (`ce55bf4`) and remain accurate except where noted here.

## Synchronization gate
- Auto-created branch: `arena/01a0ed0c-video-factory` @ `d465cd3e3eed9a7db3604efec8f13cfab1f71a85` (main "Initial commit"; clean tree, no own commits)
- Source: `origin/arena/01a0e973-video-factory` resolved to `ce55bf41572c86705f59f8b7eb3e38c16c3d7d3e` (exactly the reviewed commit; no newer commits)
- Session branch reset to the source; tree `26d5d15f46e3` identical to the source tree
- Baseline at source: 53/53 tests, core and web typecheck pass, build passes, doctor green after `npm run provision`

## The defect that was fixed
`exportProject` passed `st.captions` (Long captions) and one `o.audioFile` (Long narration) to every Short.

## Contract (`packages/core/src/targets.ts`)
- `resolveTargetMedia(project, targetId, audioMap)` → `TargetMedia {targetId, format, scenes, captions, audioFile, audioDurationSec, durationSec, narration}`. This one resolver feeds rendering, muxing, QC and metadata.
- `planTargets()` resolves every target independently. If a Short has no audio of its own (or points at the Long file), **only that Short** is blocked, with an error naming it, e.g. `Video_01 short_2 is missing its own narration audio…`.
- `ExportOptions.audioFile` was removed; `targetAudio: TargetAudioMap` is required. A legacy `audioFile`/`captions` key throws.
- Short captions are built per scene from that Short's narration inside the scene's own time window, so every cue references a Short scene and ends within the Short.
- When a Short has its own audio, it is timed to it: scene durations follow narration length, and total = audio + 0.3 s. Long timing is unchanged.
- Captions are written per target: `<Id>_long|short_N.{srt,vtt,json}`. The legacy `<Id>.{srt,vtt,json}` files are kept (Long only).
- The renderer is unchanged: silent Remotion render plus one audio file per target in `muxAndEncode`.

## Schema / compatibility
- `schemaVersion: 2`, added through `migrateProject()` in `loadProject`. The migration is additive only: it adds `meta.input.targetAudio` (defaults to `{}`) and `storyboard.shortCaptions`. Nothing existing is rewritten, and it refuses future versions. Covered by tests.
- `voiceoverFile` is Long audio only. A Long with no audio still exports silent, as before.
- Migrated v1 projects have no Short audio, so their Shorts are blocked until per-Short narration is supplied. This is intentional.
- The UI has no field yet for uploading per-Short narration (UI changes are out of scope). Set `meta.input.targetAudio` in the project JSON or via the API.

## Demo audio
`npm run voiceovers` now writes `<Id>.mp3` (Long) plus `<Id>_short_N.mp3` and a `.txt` of the exact spoken text for each Short. Each Short track is spoken from that Short's scene narration and sped up (SAM speed 30–46) until it fits in ≤34 s. It is never trimmed from the Long track. `run-demo` refuses a Short whose `.txt` no longer matches its scenes. All of this lives in `data/`, which is gitignored.

## Validation (this commit)
- Tests: **71 passed** (53 existing, unchanged, plus 18 new in `tests/targets.test.ts` and `tests/export-targets.test.ts`). The test-count floor was raised from 50 to 71.
- Core strict typecheck, web strict typecheck and production build: pass. Ad-hoc strict tsc of the API/demo runner: pass. Doctor: ready. `git diff --check`: clean. Lint: **not configured (gap)**.
- Regression proof: `tests/export-targets.test.ts` run against `ce55bf4` gives **5 failed / 1 passed** (`EVIDENCE/phase0/regression_before_fix.txt`; Short captions referenced Long scene ids, and `audioFile` was accepted). After the fix: 7/7 pass.

## Bounded render — Video_01 short_1 only
- `output/Video_01/shorts/Video_01_short_1_final.mp4` (gitignored): 33.60 s, 1080×1920, h264 30 fps, AAC 48 kHz 223 kbps, 8.0 Mbps
- QC: **WARN, 0 critical**. Warnings are pacing only: hook 4.6 s, three scenes over 3.2 s — a side effect of timing scenes to the narration.
- The MP4 audio envelope correlates 1.00 with `Video_01_short_1.mp3`, 0.058 with short_2 and 0.035 with the Long. Spoken text = caption text = scene narration. 16 cues, all short_1 scene ids, max end 33.56 s. (`EVIDENCE/phase0/short_1_verification.json`)
- Contact sheet: `EVIDENCE/phase0/Video_01_short_1_contact.jpg`

## Known limitations / observations
- Burned-in captions are not visible in the 12 contact-sheet frames. The Short captions are passed to the renderer correctly (tested), but the visible caption layer in the Short composition was not investigated (renderer work, out of scope).
- The Short hook's narration repeats the next two scenes' sentences (existing storyboard content), so the demo audio speaks it twice, faithfully.
- The SAM voice is fast on Shorts; it is a placeholder.
- Key-number QC still checks the Long scenes (a project-level check).
- No scenario, character, dialogue or multi-voice work was started.

---

# REVIEW_HANDOFF

Checkpoint and review document for the **BuildTrack Video Factory**.
This is a review-only document. The scenario-based / multi-character work
described in section 9 is **proposed, not implemented**.

---

## 1. Git coordinates

| | |
|---|---|
| Repository | https://github.com/engmelkhabery1982/Video-Factory |
| Review branch | `arena/01a0e973-video-factory` |
| Checkpoint commit | `fa9d7c1` — the commit that adds this document. The commit immediately after it (`c4ff6cb`) only edits this line, so the reviewed tree is `fa9d7c1` plus a one-line doc edit. |
| Previous checkpoint used for comparison | `51ee4ff` |
| Original baseline | `cc92f62` |
| Compare vs previous checkpoint | https://github.com/engmelkhabery1982/Video-Factory/compare/51ee4ff...arena/01a0e973-video-factory |
| Compare vs original baseline | https://github.com/engmelkhabery1982/Video-Factory/compare/cc92f62...arena/01a0e973-video-factory |
| Pull request | https://github.com/engmelkhabery1982/Video-Factory/pull/1 |
| Default branch | `main` (not merged, not modified) |

---

## 2. Changes since `cc92f62`

The full history from the original baseline, all on the remote branch:

| Commit | What it does |
|---|---|
| `c370e48` | Makes the demo reproducible (`npm run voiceovers` generates the narration offline), corrects the README/DEPENDENCIES claims, adds the CI workflow |
| `3192bc0` | Fixes visual defects found by rendering and inspecting the demo |
| `5296c0a` | Records local validation into `EVIDENCE/`, adds the draft-release upload script |
| `51ee4ff` | Fixes the CI test-count assertion, which failed on every run |
| `fa9d7c1` | This checkpoint: review handoff, re-captured UI evidence, and a fix to the screenshot capture script |

---

## 3. Current features

A local, offline video production tool. Paste a script, upload a voiceover,
get a storyboard, edit it visually, preview, QC and export one 1920x1080 Long
video plus up to three native 1080x1920 Shorts. No login, no cloud service, no
subscription, no watermark.

| Area | Status |
|---|---|
| Local Web UI, five-step workflow | working |
| Project persistence and reopen | working |
| Script analysis (rhetorical classification, evidence, key numbers) | working |
| Diversity engine with per-scene reasons and rejected alternatives | working |
| Visual history with weighted similarity, blocks export above 65% | working |
| Scene editing, locking, single-scene regeneration | working |
| Captions: SRT/VTT/JSON, glossary, hand correction and retiming | working |
| Asset library with licence and provenance fields | working |
| QC: technical, visual, content; criticals block export | working |
| H.264/AAC export verified with ffprobe | working |
| GitHub Actions CI (code + build only, no render) | working |

Visual catalog: **8 hooks, 12 explanations, 7 transitions, 8 backgrounds,
5 CTA animations, 5 caption styles.**

---

## 4. Render pipeline and its stages

`apps/api/src/services/pipeline.ts` → `exportProject()`, per target
(`long`, `short_1..3`):

1. **Storyboard** — `buildStoryboard()` in `packages/core/src/storyboard.ts`
   analyses the script and selects visuals, writing
   `visual_history.json` as it goes.
2. **Frame render** — `renderTarget()` in `apps/api/src/services/render.ts`
   uses Remotion to render frames through the local Chromium
   (`.browser/chrome`, provisioned from npm, never downloaded).
3. **Encode and mux** — `muxAndEncode()` runs ffmpeg: H.264 High,
   yuv420p, CFR 30 fps, plus the narration as AAC 48 kHz 224 kbps.
   Uses `-shortest` and an explicit `-t` cap from the storyboard duration.
4. **Technical QC** — `technicalQc()` / `mediaQc()` / `captionQc()` read the
   finished file with ffprobe and ffmpeg (black frames, silence, bitrate,
   duration against the target range).
5. **Contact sheet** — a 4x3 tile of the finished file for review.
6. **Thumbnails** — three frames pulled from visually distinct scenes.
7. **Captions, metadata, provenance** — SRT/VTT/JSON, publishing kit,
   asset licence manifest.

Measured on this host: roughly 13 minutes for a ~92 s Long, ~2 minutes per
24 s Short.

---

## 5. How things are represented

| Concept | Representation | Location |
|---|---|---|
| Scene | `Scene` with `role`, `variant`, `background`, `transitionIn`, `textPosition`, `accent`, `duration`, `startTime`, `narration`, `content`, `assetIds`, `reason`, `locked`, `userEdited` | `packages/core/src/types.ts` |
| Timeline | computed: `startTime` is a running sum of `duration`; no separate timeline object | `packages/core/src/storyboard.ts` |
| Audio | `ProjectInput.voiceoverFile: string \| null` — **one file per project** | `packages/core/src/types.ts` |
| Audio in the composition | a single `<Audio src={audioSrc} />` | `packages/video/src/compositions/VideoComposition.tsx` |
| Subtitles | `CaptionCue { id, start, end, text, sceneId, terms, userEdited }`, a flat timed list linked to scenes by id | `packages/core/src/captions.ts` |
| Assets | asset library with `licence`/`source`; scenes reference by `assetIds`, resolved to URLs via `mediaMap` | `apps/api/src/routes/assets.ts` |
| Visual variants | declarative registry with `fits[]` (rhetorical function) and `prefers[]` (background) | `packages/core/src/variants.ts` |
| Brand | fixed preset: logo, colours, fonts, type scale | `packages/core/src/brand.ts` |

### Single narrator

The current design **assumes exactly one narrator and one audio track** for
the whole project. `voiceoverFile` is a single path, the composition mounts a
single `<Audio>`, caption timing is aligned against that one continuous
narration, and ffmpeg muxes that one file. There is **no** concept of a
character, a speaker, a per-scene audio clip, or dialogue anywhere in the
model.

---

## 6. Validation results

All run locally on this host (Node v22.22.3, Linux, 2 cores).

| Check | Command | Result |
|---|---|---|
| Tests | `npm test` | **53 passed / 53**, 0 failed |
| Typecheck, core (strict) | `npm run build:core -- --noEmit` | **PASS**, 0 errors |
| Typecheck, web (strict) | `npx tsc --noEmit -p apps/web/tsconfig.json` | **PASS**, 0 errors |
| Production build | `npm run build` | **PASS** — core compiled, 37 modules, 264.29 kB JS (80.29 kB gzip) |
| Environment doctor | `npm run doctor` | **PASS** — 10 ok, 4 informational warns (data/ and output/ not yet created) |
| Lint | — | **No linter is configured.** This is a genuine gap, not a pass. |
| Startup smoke | `PORT=5177 node --import tsx apps/api/src/server.ts` | **PASS** — `/api/health` 200, `/` 200, `/api/projects` 200 |
| CI test-count assertion | `node scripts/assert-test-count.mjs` | **PASS** — 53 >= floor of 50 |
| Full video render | not run at this checkpoint | see section 8 |

The doctor also confirms ffmpeg, ffprobe, the local Chromium, libx264 and an
AAC encoder are all present.

---

## 7. Render processes stopped

| | |
|---|---|
| Process | `node --import tsx tests/run-demo.ts` (background) |
| Running at | Video_01, stage "Rendering long (14 scenes)" |
| Last progress seen | `long (final): 40%` at 11:41:00 |
| Output path | `output/Video_01/long/` (directory created, **no MP4 written yet**) |
| Cause of stop | sandbox reset, not a graceful stop |
| Reusable partial work | **None.** Remotion renders to a temporary buffer and only writes the final MP4 after all frames complete, so a 40% render leaves no reusable artefact. The re-encode, QC, contact sheet, thumbnail, caption and metadata stages never ran. |
| Output now present | **Nothing.** `output/` was removed by the reset. |

The storyboards and narration are regenerable (`npm run seed`,
`npm run voiceovers`) and take seconds, so nothing irreplaceable was lost.
Only wall-clock time.

---

## 8. Demo outputs: complete, partial or missing

**All missing.** `output/` is empty at this checkpoint.

The pipeline has been proven end to end in earlier runs on this same code
base — a Long was exported at 1920x1080, 30 fps, H.264/yuv420p, 95.93 s,
8360 kbps video, AAC 48 kHz 210 kbps, and a Short at 1080x1920, 24.15 s,
8403 kbps — but **those files were erased by a sandbox reset and are not in
this checkpoint.** They must be re-rendered and re-verified before any claim
about the current outputs can be made. `REVIEW_HANDOFF.md` deliberately makes
no claim about the present state of `output/`.

Anti-repetition for the three demo projects is deterministic given the same
history and is covered by the test suite; the live values come from
`output/demo_summary.json` once a render completes.

---

## 9. Proposed future work: scenarios and multiple characters

**Not implemented.** Listed so a reviewer can judge the change surface.

### Files that would need to change

| Concern | Files |
|---|---|
| Data model: replace `voiceoverFile: string \| null` with a list of audio tracks; add `characterId`/`speaker` to `Scene` | `packages/core/src/types.ts` |
| Script analysis: classify dialogue, character and scenario beats alongside the existing rhetorical functions | `packages/core/src/analyze.ts` |
| Storyboard: author scenario sequences, allocate per-scene audio slices, keep the anti-repetition rules working with more scenes | `packages/core/src/storyboard.ts` |
| Variant registry: add dialogue/split-character layouts, and let hybrid beats pick a scenario layout *and* an explanation layout | `packages/core/src/variants.ts` |
| Diversity engine: add rules over character casting and scene style, and make them feed the similarity score | `packages/core/src/diversity.ts` |
| Similarity: include casting and style mix so two videos with the same presenter are not "diverse" | `packages/core/src/history.ts` |
| Captions: per-speaker cues, speaker labels, and a line budget for dialogue | `packages/core/src/captions.ts` |
| Composition: mount several `<Audio>` sources, honour the existing `mediaMap` pattern | `packages/video/src/compositions/VideoComposition.tsx` |
| New scene components for dialogue and character framing | `packages/video/src/scenes/` (new file beside `Explanations.tsx`) |
| Upload and per-scene audio selection in the API | `apps/api/src/routes/projects.ts` |
| Encode: mix or concatenate per-scene clips; `-shortest` and the single `-i` mux must be reworked | `apps/api/src/services/render.ts` |
| Probe each clip's duration | `apps/api/src/services/media.ts` |
| QC: speaker consistency, dialogue pacing, and duration rules for multi-track audio | `packages/core/src/qc.ts` |
| Storyboard UI: pick a character/voice per scene | `apps/web/src/pages/Storyboard.tsx` |

### Existing extension points worth reusing

- **`VARIANT_LIBRARY` registry** — adding a layout is declarative
  (`id`, `label`, `fits[]`, `prefers[]`, `shortsSafe`). New dialogue layouts
  slot in without touching the selection engine.
- **`Scene.reason`** — `{ detected, evidence, score, alternatives }` already
  carries *why* a beat was staged this way. A character choice is another
  such decision and can be recorded the same way.
- **`Scene.assetIds` + `mediaMap`** — per-scene asset resolution is already
  indirect, which is exactly the shape a per-scene voice clip needs.
- **`media.ts` probing** — `durationOf()` already measures a single file.
- **The catalog/QA coupling** — the tests assert catalog minimums, so new
  variants are automatically covered once registered.
- **`textPosition` and `accent` per scene** — already per-scene variables,
  so dialogue scenes can be styled independently.

### Where this would regress

- **Muxing.** `-shortest` plus a single `-i` assumes one audio file. Several
  tracks mean a real mix or a concat step, and the current
  `muxAndEncode()` contract changes.
- **Caption timing.** Cue alignment is proportional to one continuous
  narration. Dialogue interleaves two voices, so forced alignment has to
  become per-clip, not per-project.
- **The 8.2 s body-scene cap.** Tight dialogue exchanges want 1.5–3 s beats.
  The cap was set to satisfy "a visual change every 5–8 s"; more, shorter
  scenes change every duration heuristic in `storyboard.ts`.
- **The 65% similarity gate.** Casting and style are strong signals. If they
  are added naively, exports could start blocking, which would look like a
  regression rather than a feature.
- **The 53 tests.** They pin catalog minimums, exact variant pools and
  per-function candidate counts. Widening pools for character support will
  break several assertions until they are updated deliberately.
- **QC duration ranges** assume one continuous audio bed.

---

## 10. Known limitations

1. **Render speed.** ~4 fps on a 2-core, 3 GB, GPU-less host: ~13 min per
   92 s Long. This is software rasterisation, not a code defect.
2. **No WebGL.** Visuals are CSS/SVG/DOM because SwiftShader will not
   initialise here.
3. **Captions are estimated**, word-count proportional to narration duration
   (about ±0.4 s). Whisper forced alignment was impossible because model
   downloads are blocked. Users can retime any cue by hand.
4. **Similarity is structural**, not perceptual: it compares the weighted mix
   of variants, transitions, backgrounds, positions, accents and rhythm, not
   rendered pixels.
5. **Arabic is supported** as a project language and in captions, but the type
   scale was tuned for Latin. RTL layout and Arabic shaping need a dedicated
   pass.
6. **Thumbnails are generated frames**, not designed poster artwork.
7. **No linter is configured.** Only `tsc` strictness guards the code style.
8. **The sandbox cannot upload Release assets** — `uploads.github.com` is
   unreachable while `api.github.com` works, so MP4s cannot be attached to a
   draft Release from here. `tools/publish-demo-assets.sh` does it from a
   normal network.

### Unimplemented by design (MVP scope)

ClickUp, publishing/auto-post, analytics, cloud rendering, accounts, payments,
multi-user collaboration, voice cloning, stock-footage search, mobile app,
perceptual similarity, Whisper-grade alignment, **and everything in section 9**.

---

## 11. Exact local commands

```bash
# 1. install (also provisions nothing yet)
npm ci

# 2. build the core library and the interface
npm run build

# 3. unpack the local headless renderer (needed before any render)
npm run provision

# 4. check the environment
npm run doctor

# 5. run the app -> http://localhost:3000
npm start

# --- validation ---
npm test                                    # 53 tests
npm run build:core -- --noEmit              # core typecheck
npx tsc --noEmit -p apps/web/tsconfig.json  # web typecheck

# --- demo ---
npm run voiceovers     # synthesise narration into data/voiceover/
npm run seed           # seed the three storyboards, no rendering
npm run demo           # synthesise + render + export all three
npm run demo:render Video_02        # one project only
npm run verify         # ffprobe every exported file
npm run evidence       # write EVIDENCE/ reports
```

On Windows, double-click `START VIDEO FACTORY.bat`.
On macOS/Linux, run `./START VIDEO FACTORY.sh`.

---

## 12. Manual review checklist

- [ ] `npm ci && npm run build && npm run doctor` — all green from a clean clone
- [ ] `npm test` — 53 passed
- [ ] `npm start` opens http://localhost:3000, all three health badges green
- [ ] Projects list shows the three demo projects and the anti-repetition log
- [ ] Opening a project shows scenes with type, text, duration, reason and alternatives
- [ ] Editing a scene and regenerating one scene preserves the other edits
- [ ] Locking a scene survives regeneration
- [ ] Captions can be corrected and retimed without breaking sync
- [ ] `npm run demo` completes and writes `output/Video_0N/{long,shorts,thumbnails,captions,metadata,qc,assets}`
- [ ] `npm run verify` reports every MP4 within spec
- [ ] Longs are 1920x1080, Shorts 1080x1920 — Shorts are natively vertical, never resized landscape
- [ ] No two demo videos exceed 65% similarity
- [ ] No two consecutive videos open with the same hook
- [ ] No scene variant appears more than twice in one video
- [ ] Captions are readable on a phone and stay clear of platform UI
- [ ] No blank frames, no text clipping, no repeated scene
- [ ] `EVIDENCE/` matches what is actually in `output/`


## Phase 0C — visual semantics, caption safe zones, text quality

- New core modules: `packages/core/src/semantics.ts` (intent, genuine contrast, `completeText`, fragment and filler detection, `displayText`, `isCueRedundant`) and `packages/core/src/layout.ts` (the `PORTRAIT` safe-zone contract used by layouts, captions and QC).
- Short beats: `key_statement` single-block layout, or `number_comparison` only when the sentence names two figures. On-screen text comes from the complete sentence; hook layout is chosen by intent; the filler takeaway is removed; the CTA is split with `ctaParts`.
- Captions: `chunkCaptionText` (phrase boundaries, orphan repair; shared by Long and Shorts). Compact burned cue when it duplicates the scene text.
- QC (critical): before/after misuse, hook text missing, placeholder or generic filler, fragment headline, repeated secondary text, safe-zone collision, orphan cue, cue beyond duration.
- Tests: `tests/phase0c.test.ts` (+32, 121 total). Test-count floor raised 75 -> 100.
- Evidence: `EVIDENCE/phase0c/` (Video_01 short_1 only; QC PASS, 0 critical).

## Phase 0C.1 — natural caption phrases and semantic section labels

- `buildShortCaptions` rebuilds the complete sentence once when adjacent beats share `content.source`. A cue may span the beat boundary and is linked to the scene it starts in. Scene timing, audio and emphasis are unchanged.
- `isCaptionFragment` (semantics.ts) flags a strict piece of a known sentence whose cut is not a sentence end, punctuation or a conjunction boundary. It runs as the critical QC check "Caption fragment".
- `sectionForScene`: steps → How it works; stat → Key number; comparison → The gap; question/warning → The question / problem; CTA → Next step. Plain statements fall back to the Short's title.
- `tests/targets.test.ts` #5 was adapted from per-scene to per-sentence-group matching, which spanning cues require. It is still an exact word-for-word check.
- Tests: `tests/phase0c1.test.ts` (+15, 136 total). Evidence: `EVIDENCE/phase0c1/`.

---

## VS1 — Commercial voice profile & rights gate

**Source gate:** `origin/main` was re-fetched before any edit and resolved to
`b235b002df4cab2237ef0a8093b1aeef225f6903`, matching the work order; the work
was committed to the Arena session branch `arena/c4cc1417-video-factory`.
**Commit:** `feat(voice): add commercial rights and consent publication gate`
**Scope:** voice contract only. No rendering, no model download and no network
call was performed or required; no UI or API surface changed.

### What a production voice must now prove

`VoiceProfile` gained an optional `publication: VoicePublicationProfile`
(`packages/core/src/scenario/voice-types.ts`) carrying, at minimum:

| Area | Field(s) | What it pins |
|---|---|---|
| Engine | `engine`, `engineId`, `engineVersion`, `modelId`, `modelRevision`, `runtimeId`, `runtimeVersion` | `kokoro \| chatterbox \| external`, the model id with its pinned revision, and the runtime pin |
| Reference audio | `acousticSource` | either `referenceAudio` (repo-relative path, SHA-256, duration, sample rate, channels) or a named `presetVoice` |
| Consent | `consent` | subject, scope, granted/recorded timestamps, revocation state, and — for a recorded speaker — the consent evidence |
| Rights | `rightsEvidence[]` | source/provider, licence name, first-party evidence URL, access date, commercial use |
| Audition | `audition` | `not_tested \| approved \| rejected` with approver and timestamp |
| Publication | `publicationState`, `origin`, `review`, `provenance`, `commercialClearance` | `draft \| review_only \| approved`, who authored it, the evidence migration, and an explicit commercial statement |

The Phase 4A `language`, `role` and `synthesisHints` fields are unchanged and
remain provider-neutral.

### The gate

`evaluateVoicePublicationGate()` (`voice-publication-gate.ts`) is the single
deterministic decision point. It is pure — no clock, no filesystem, no network —
so identical input always yields byte-identical findings. `allowed` is exactly
`errorCount === 0`; warnings are advisory and escalate to errors under
`strictFirstPartyEvidence`. Rule ids are stable (`VOICE-PUB-000…090`, plus
`VOICE-REG-040…050` for registry validation) and every finding carries a code
such as `MISSING_CONSENT`, `CONSENT_REVOKED`, `MISSING_RIGHTS_EVIDENCE`,
`COMMERCIAL_USE_NOT_PERMITTED`, `AUDITION_NOT_APPROVED` or
`PUBLICATION_STATE_NOT_APPROVED`.

Two rules are deliberate:

- **Silence about commerce is not permission.** `not_stated`, `unknown`,
  `conditional` and `prohibited` all block. A record stamped `approved` with no
  supporting evidence blocks too (`PUBLICATION_APPROVED_WITHOUT_EVIDENCE`), so a
  stamp alone can never publish a voice.
- **Production is blocked before anything is written.**
  `buildDialogueProductionPlan` runs the gate at step 4b — after voice
  resolution, before synthesis — so an unapproved voice returns structured
  `VOICE_PUBLICATION_BLOCKED` findings naming the slot, the profile id and the
  failed rule, and creates no audio file, sidecar or manifest.
  `synthesizeDialoguePlan(Sync)` runs it before the engine availability probe
  (which can load a model) whenever `enforcePublicationGate` is set.

### Migration of the legacy Kokoro fixtures

The eight Phase 4A fixtures declare no publication record, so
`migrateVoiceProfileForPublication()` (`voice-publication-migration.ts`) gives
them an explicit one. It is idempotent, non-mutating and keyed on a frozen
allowlist of the exact `{id, voiceSlot}` pairs plus a live slot check against the
pinned Kokoro preset map; a profile that merely reuses an id or a slot does not
migrate. Everything else — including a profile whose `publication` field is
present but malformed — becomes an unverified `draft` skeleton and is never
silently approved.

Limitations of the migrated record, recorded inside it and reported by the gate
as warnings (`AUDITION_APPROVAL_INHERITED`, `RIGHTS_EVIDENCE_NOT_FIRST_PARTY`):

- The audition approval is **inherited** from the accepted baseline
  (`EVIDENCE/final-product/audio-verification.json`), not from a new
  first-party listening test, and that artifact covers only three of the eight
  slots (`am_onyx`, `af_heart`, `af_nova`).
- The rights evidence was verified against the pinned local dependency
  (`node_modules/kokoro-js/LICENSE`, `package.json license = Apache-2.0`)
  rather than re-fetched from the provider — this repository makes no network
  calls. The model licence is the one `tools/provision-tts.mjs` already records
  for `onnx-community/Kokoro-82M-v1.0-ONNX`.
- Consent is recorded as `subject: 'model_provider_preset'`: these are preset
  voices shipped inside the model, so no human signature is fabricated.
- Under `strictFirstPartyEvidence` both warnings become blocking errors.

### Reuse invalidation

`SYNTHESIS_REUSE_SCHEMA_VERSION` is now **2**. The reuse key and the sidecar
carry the voice's declared acoustic identity (`voice-acoustic-identity.ts`:
engine family, model id, pinned revision, runtime pin and `acousticSourceId` =
`ref:<sha256>` / `preset:<id>` / `undeclared`) plus the engine's own model
revision and quantisation. Scheme-1 sidecars are ignored, so their clips are
synthesized once more. Rights, consent, audition and publication state are
deliberately **excluded** from the key: they decide whether audio may be
published, not which bytes a voice produces — revoking consent blocks production
through the gate while leaving valid bytes reusable.

### Backward compatibility

Every new field is optional, so existing scenario JSON, plans and audio records
validate unchanged and the Phase 4A/5/6 contracts are untouched. Voice
resolution migrates by default (opt out with `migrateLegacyPublication: false`);
the gate is opt-in at resolution (`requirePublicationApproval`) and opt-in at
synthesis (`enforcePublicationGate`), but **on by default** in the production
pipeline. `requireVoiceEngineAgreement` is off by default because the current
default synthesizer is the SAM reference mode while the Kokoro profiles document
Kokoro as their production engine — that is the documented Phase 4B baseline,
not a rights problem. `kokoro-dialogue-synthesizer.ts` keeps re-exporting its
engine constants, now defined in the I/O-free `kokoro-voice-identity.ts` so the
contract layer can document an engine identity without importing a Node-only
adapter.

### Validation (no renders, no model downloads)

- New focused suites: `tests/voice-publication-gate.test.ts` (56),
  `tests/voice-publication-migration.test.ts` (25),
  `tests/voice-acoustic-identity-reuse.test.ts` (12) — 93 tests covering every
  required case: approved own-voice passes; missing consent blocks; revoked
  consent blocks; missing or changed reference hash blocks and invalidates
  reuse; missing commercial evidence blocks; `review_only` blocks publication;
  rejected/not-tested audition blocks; engine/model/settings changes invalidate
  reuse; existing Kokoro fixtures migrate deterministically with no behaviour
  regression; serialization round-trips stably with no absolute paths.
- Existing voice / synthesis / reuse / timing / production suites: 215 passed,
  4 skipped, 0 failed.
- Full non-render suite (the three real-render files excluded): **78 test files,
  1277 passed, 5 skipped, 0 failed**.
- Full suite including renders (`npx vitest run`): 1278 passed, 1 failed, 22
  skipped (1301). The single failure is
  `tests/phase6d-real-package.test.ts` — "rendered a real Long and Short through
  the approved renderer" — which already failed on the pre-change baseline in
  this sandbox because the local Chromium provisioning (`.browser/`) has never
  been run here. It performs a real render and was out of scope for this phase.
- Strict typechecks: `packages/core`, `apps/web`, `apps/api`, `scripts` — all
  clean. Production build (`npm run build`) clean. `git diff --check` clean.
- The CI count guard was run on the committed tree:
  `node scripts/assert-test-count.mjs 300` → `ok - 1279 tests passed, at or
  above the floor of 300` (its JSON reporter counts one test more than the
  human reporter; the one failure it reports is the same pre-existing
  `phase6d-real-package` render test). The floor itself is unchanged — adding
  tests never requires editing it.

### Dependencies

`DEPENDENCIES.md` now lists `kokoro-js` (Apache-2.0) and its runtime
dependencies, plus the Kokoro model and the preset voices it ships — all of
which the previous revision omitted even though the Phase 4B audio path uses
them. This phase added no new dependency.

---

## VS2 — Chatterbox voice-clone synthesizer adapter & safe provisioning

### What this phase adds

Chatterbox is now a **real implementation of the existing `AudioSynthesizer`
contract** for cloning a consenting speaker's own voice — without replacing
Kokoro, without a second dialogue-production pipeline, and without any automatic
download. The adapter plugs into the existing orchestration: per-turn target
paths, the validated reuse sidecars, the VS1 publication gate, the ffmpeg
canonical normalizer and the canonical dialogue-audio manifest are all reused
unchanged.

Two engine contracts are implemented, from verified upstream facts (fetched
2026-10-08 from `pypi.org/pypi/chatterbox-tts/json` and the upstream GitHub
repository — recorded in `DEPENDENCIES.md`):

| Contract | Model | Languages | Settings |
|---|---|---|---|
| `chatterbox-turbo` | `ResembleAI/chatterbox-turbo` (350M) | `en` | unsupported upstream → declaring them is a hard error |
| `chatterbox-multilingual-v3` | `ResembleAI/chatterbox` (500M) | 23 ids | `exaggeration` 0.5 / `cfg_weight` 0.5 / optional `min_p` |

`chatterbox-tts==0.1.7` (MIT), Python 3.11 in an isolated venv, native 24 kHz
mono output normalized to the canonical 48 kHz mono PCM16 WAV, Perth neural
watermark on every generated file.

### New files

- `packages/core/src/scenario/chatterbox-voice-identity.ts` — I/O-free engine
  contracts, language mapping, voice-settings validation defaults, provisioning
  marker contract and parser.
- `packages/core/src/scenario/chatterbox-worker-protocol.ts` — the versioned JSON
  request/response contract (`chatterbox-worker-request/v1` /
  `chatterbox-worker-response/v1`), strict validators, the worker failure
  taxonomy mapped 1:1 onto structured codes, and the diagnostics redaction rules.
- `packages/core/src/scenario/chatterbox-path-safety.ts` — approved roots for
  references/outputs/scratch, portable-path checks, traversal rejection, symlink
  escape detection and repository-source protection.
- `packages/core/src/scenario/chatterbox-dialogue-synthesizer.ts` — the
  `AudioSynthesizer` adapter: gate → reference verification → provisioning →
  language → device → direct `spawn` (no shell) → response validation → raw
  integrity → canonical normalization → scratch cleanup.
- `tools/chatterbox/worker.py`, `requirements.txt`, `README.md` — the isolated
  Python worker, its pinned dependency metadata and its operational docs.
- `tools/provision-chatterbox.mjs` — explicit provisioning (`--check` default,
  `--apply` to install/download), never wired into install/test/build/start.
- `tests/fixtures/chatterbox-fake-worker.py` — a deterministic stdlib-only
  Python worker speaking the real protocol (CI never imports torch, never
  downloads a model); `tests/helpers/chatterbox-worker-fixtures.ts` plus the
  three focused suites.

### Bounded modifications

- `audio-synthesis-types.ts`: 20 new **blocking** error codes (additive only).
- `synthesize-dialogue.ts`: optional `settingsDigest` on
  `SynthesisEngineIdentity`, carried into the reuse key and sidecar **only when
  defined**. `SYNTHESIS_REUSE_SCHEMA_VERSION` stays **2**, and Kokoro/SAM
  identity objects and keys are byte-identical (pinned by a regression test that
  recomputes the scheme-2 material by hand).
- `index.ts` (exports), `tools/doctor.mjs` (Chatterbox section), `package.json`
  (`provision:voice-clone` only), `.gitignore` (`.chatterbox/`,
  `.voice-references/`), `DEPENDENCIES.md`, `README.md`, `tools/chatterbox/README.md`.

### The safety order, per clip (nothing is written before step 5)

1. request shape, exact text (≤ 5000 chars), portable target path;
2. the voice must declare **this exact contract** and a `cloned_reference_audio`
   source — otherwise `CHATTERBOX_VOICE_FALLBACK_BLOCKED`;
3. the VS1 publication gate (consent, rights, audition, publication state) —
   `VOICE_PUBLICATION_BLOCKED` before any file or process exists;
4. the reference recording's SHA-256 is recomputed and must match the approved
   profile (and the request's declared acoustic identity);
5. the provisioning marker, interpreter and worker script are verified, and the
   model revision must agree with the voice's declared pin;
6. the language must be supported by the contract;
7. the device policy must be satisfiable — CUDA by default; CPU only with an
   explicit, truthful `allowCpu` opt-in (otherwise `CHATTERBOX_CUDA_REQUIRED`);
8. only now is the worker spawned directly (`shell: false`, allow-listed env,
   `HF_HUB_OFFLINE=1`), with a bounded timeout, SIGTERM→SIGKILL termination and a
   validated versioned response;
9. the raw 24 kHz WAV is hash/header/silence-checked, normalized to canonical
   48 kHz mono PCM16, re-validated against the canonical contract, and the
   scratch file is removed on both success and failure.

### No silent fallback

An approved cloned voice is never silently produced by Kokoro, by another
Chatterbox model, by a preset voice or by a default. Engine-family, model-id,
runtime and revision mismatches are blocking findings with structured details
(`blockedCodes`, `category`, `remediation`). Reuse only happens for a complete
acoustic-identity match: engine, model id, resolved revision, reference SHA-256,
exact text, language, voice settings digest, canonical-format contract and
target path.

### Provisioning boundaries

`npm run provision:voice-clone` (check mode) reports OS, Python 3.11, isolated
env, disk space, GPU/CUDA and the expected locations, and writes nothing. Only
`--apply` creates `.chatterbox/env`, installs the pinned requirements, resolves
the **real** upstream model revision, downloads the snapshot and writes the
marker last. `npm install`, `npm ci`, `npm test`, `npm run build` and
`npm start` never download weights (asserted by tests over `package.json`).
Doctor reports Chatterbox as optional while unselected, as blocking checks once
selected (`--require-chatterbox`), and never downloads.

### Tests (78 new, all against the deterministic fake worker)

- `tests/chatterbox-synthesizer.test.ts` (58): request mapping; byte-exact text;
  language mapping; engine/model/revision; reference hash recomputed and
  forwarded; swapped/missing reference blocked; revoked consent and rights
  silence blocked before any file exists; traversal / absolute / outside-roots /
  source-protection / symlink-escape paths rejected; no Kokoro / other-model /
  preset / runtime-version fallback; missing marker / pinned-revision /
  contract / python / worker failures; CUDA-required and unapproved-CPU
  failures; unsupported language; turbo settings refusal; timeout;
  non-zero exit; invalid JSON; foreign schema; wrong protocol version; stdout
  overflow; empty/silent/corrupt output; reported-hash mismatch; unmarked
  success; worker engine-identity mismatch; CUDA-init and GPU-OOM mapping;
  diagnostics redaction; scratch cleanup; canonical output.
- `tests/chatterbox-reuse-invalidation.test.ts` (10): identical identity → same
  key; settings / reference hash / revision / contract changes each change the
  key; end-to-end sidecar reuse through `synthesizeDialoguePlan` (worker not
  called again, `synthesizedClipCount: 0`), settings change and reference change
  each re-synthesize every clip; Kokoro/SAM identity has no settings digest and
  the scheme-2 key material is reproduced byte-for-byte.
- `tests/chatterbox-provisioning-doctor.test.ts` (10): check mode is
  side-effect free and reports Python/GPU truthfully; unknown engine exits 2;
  default invocation never provisions; requirements pins verified; worker is
  offline-only and parses; no install/test/build/start hook references
  provisioning; `.chatterbox/` and `.voice-references/` are Git-ignored; doctor
  optional vs selected-and-blocking, with no directory ever created.

### Validation (no model download, no render)

- New + affected focused suites: **22 files, 412 passed, 4 skipped, 0 failed**.
- Full non-render suite (excluding the three real-render files):
  **81 files, 1355 passed, 5 skipped, 0 failed** (VS1 baseline: 78 files, 1277
  passed, 5 skipped — exactly +3 files and +78 tests).
- Strict typechecks: `packages/core`, `apps/web`, `apps/api`, `scripts` — clean.
  Production build (`npm run build`) clean. `git diff --check` clean.
- Doctor: default run reports Chatterbox as optional (the only hard failures are
  the pre-existing unprovisioned `.browser/` items); `--require-chatterbox`
  reports the missing marker/env/reference directory as blocking. Doctor created
  nothing and downloaded nothing.
- CI count guard on the frozen tree: `node scripts/assert-test-count.mjs 300` →
  `ok - 1357 tests passed, at or above the floor of 300` (its JSON reporter
  counts one more test than the human reporter). The one failing test in that
  run is the same pre-existing environmental failure as VS1 —
  `tests/phase6d-real-package.test.ts` "rendered a real Long and Short through
  the approved renderer" (`expected 'error' to be 'ok'`, 9 skipped): it performs
  a real render and needs the unprovisioned local Chromium. It was neither
  altered nor weakened, and is reported as failing, not as passed. The floor
  itself is unchanged; adding tests never requires editing the guard.

### Known limitations (stated, not hidden)

- This sandbox has **no NVIDIA GPU** (`nvidia-smi` absent), so the CUDA path is
  exercised through injected device detection and the fake worker. Real GPU
  synthesis was **not** executed in this phase, and nothing here claims
  otherwise.
- The upstream multilingual loader uses the floating `main` revision; the
  resolved commit is recorded at provisioning time and can never be fabricated.
  A future upstream change is therefore detectable but not preventable by this
  repository.
- The CPU path is deliberately unverified and requires an explicit opt-in.
- The fake worker proves protocol handling, path safety, integrity checks and
  the failure taxonomy — **not** audio quality or watermark behaviour of the real
  model (which was never downloaded).
- Provisioning (`--apply`) was not executed here because it downloads multi-GB
  weights; only the side-effect-free check mode was run.

---

## § VS3 — Voice & Audio inside the existing app

Full detail: `VS3_VOICE_AUDIO_HANDOFF.md`. Summary of the phase:

- **Scope:** the VS1 voice-reference contracts and the VS2 Chatterbox adapter are
  now wired into the application's API and UI, inside the existing project
  workflow (Captions page and Production/Storyboard page). No replacement app, no
  parallel voice-reference database, no duplicated synthesizer.
- **Engine availability** is truthful with the precise remedy
  (`available | not_provisioned | device_unsupported | blocked_by_approval |
  generation_failed`), Kokoro stays a separate explicit choice, and a cloned voice
  is never silently replaced by Kokoro, another engine or a default.
- **Three separate facts:** legal authorization (explicit confirmation + an
  auditable consent artifact), reference approval (decided by the shipped VS1
  publication gate, rights evidence required, silence is never permission) and
  generated-audio approval (bound to the identity digest *and* the artifact
  SHA-256). Upload grants nothing.
- **Preview generation** runs in a background job, synthesizes the complete
  narration/dialogue turn per speaker, measures the real duration, concatenates
  without re-timing and serves only the current artifact of that project. Planning
  is strict: a speaker without an assignment raises
  `VOICE-AUDIO-010-ASSIGNMENT-MISSING-REFERENCE`; no default voice is lent.
- **Render gate** (`clonedAudioRenderGate`) is consulted by the project export, the
  production build and the production export; blocked cloned audio answers
  409 `{ error, clonedAudioGate, blockReason }`, non-cloning projects are
  `notApplicable` and unchanged. `VOICE-AUDIO-060-TIMING-ALIGNMENT-PENDING` keeps
  cloned audio blocked until the documented integration point
  (`store.ts#generateStoryboard` / `targets.ts#readTiming`) is connected — the
  exact integration point is documented instead of being worked around.
- **Privacy:** private voice assets can never enter a delivery package
  (`PRIVATE_VOICE_AUDIO_MARKERS` in `plan-package.ts`); public projections carry a
  12-character hash prefix and no path.
- **Validation:** 68 new tests (API 30 / core 28 / UI 10); targeted + affected
  suites 17 files / 417 passed; full non-render suite **84 files, 1423 passed, 5
  skipped, 0 failed**; count guard `ok - 1425 tests passed, at or above the floor of
  300`; four strict typechecks clean; production build clean; `git diff --check`
  clean; doctor reports Chatterbox as optional and created/downloaded nothing;
  bounded real-HTTP smoke exercised the whole workflow up to the (correctly)
  blocked generation and export.
- **Two real defects were found by the new tests and fixed in the product:** the
  multipart reference-upload deadlock (the file part is now consumed inside the
  loop and the size limit is given to the parser), and the VS1 bridge authoring a
  bare publication record instead of a `VoiceProfile`, which made reference
  approval impossible.
- **Not done / not claimed:** real Chatterbox generation was **not** executed or
  tested (no weights, no environment, no inference); the fake worker is
  TEST/FIXTURE evidence only; the watermark and audio quality are unverified; the
  one failing test in the full suite is the pre-existing
  `tests/phase6d-real-package.test.ts` real-render test that needs the
  unprovisioned local Chromium (renderer untouched by this phase).

---

## § VS4 — External narration import, exact-audio approval, duration-driven timing

Full detail: `VS4_EXTERNAL_AUDIO_HANDOFF.md`. Summary of the phase:

- **Scope:** narration produced outside the app (for example a Kaggle WAV) can be imported, listened to, approved and connected to target timing without a local synthesis engine. No second upload system and no second approval database. Publishable bytes go through the existing target-audio upload into `voiceover/`. Declaration and approval live in the existing private `voice-audio/<id>/state.json`. Per-turn dialogue clips go through the existing `.production/<id>/audio/dialogue` contract.
- **UI:** Captions page, card "Narration from outside the app", beside the existing Target Audio and Voice & Audio panels. Two sources are explicit: generate inside the app, or import from outside. A declaration is not a rights check. Approve stays disabled until the operator confirms they listened to the whole file.
- **Approval** is bound to project, target, file SHA-256, spoken-script SHA-256, speaker identity and timing revision. Replacing audio, script, speaker or timing invalidates it. A Short never inherits the Long file. Entered engine/model/voice names are documented source info, not verification.
- **Timing** is the measured ffprobe duration. Per-scene times are verified alignment only when a sibling `.timing.json` matches every scene word for word; otherwise they are labelled estimates and are never called verified alignment. The timeline must cover the audio. A silent end card may follow the last word. Accepted audio is not trimmed to old scene durations. `muxAndEncode` no longer passes `-shortest` and refuses to encode when the plan is shorter than the narration.
- **Export gate** on `POST /api/projects/:id/export` blocks a final export until the import is approved and the timeline covers the audio. Projects with no import are unchanged. The Kokoro production-plan export does not mux this file and is not this gate.
- **Validation:** 79 new tests (core 33 / API 31 / UI 11 / render 4). Focused 8 files 121 passed; VS1–VS3 baseline 16 files 350 passed; full suite 91 files, 1504 passed, 22 skipped, 1 failed; non-render (excluding that file) 90 files, 1504 passed, 13 skipped, 0 failed. `ok - 1504 tests passed, at or above the floor of 300` (exit 0). The guard also printed `Tests failed: 1` — the same pre-existing phase6d real-render test. The guard checks the floor, not a zero-failure bar, so that failure is reported here and is not counted as passed. Its "Test files: 395" line is vitest's suite count (`numTotalTestSuites`), not the 91 files. Four strict typechecks clean; `npm run build` clean; `git diff --check` clean. Doctor reports Chatterbox as optional and not selected (nothing downloaded) and Chromium as missing. Bounded real-HTTP smoke: import fixture → 201 measured 8s estimated alignment → export 409 before approval → regenerate → listen → approve → ready → export accepted with the gate absent. No MP4, no Kaggle, no Chatterbox.
- **One defect the new test exposed and that was fixed, not weakened:** the size-limit test set `BUILDTRAKE_MAX_AUDIO_UPLOAD_BYTES` (typo), so the shared limit was never applied. It now sets `BUILDTRACK_MAX_AUDIO_UPLOAD_BYTES` and asserts no partial file remains. Temp files from a rejected declaration are removed, and client errors no longer include ffprobe paths.
- **Not done / not claimed:** no real Kaggle WAV, no Kaggle auth, no Chatterbox weights or inference, no local MP4 (Chromium unprovisioned), no browser screenshots. The one failing test in the full suite is the pre-existing `tests/phase6d-real-package.test.ts` real-render test (`expected 'error' to be 'ok'`). It was not edited and is not counted as passed.
- **Parent:** `9b33950fcca60adc6223ef4604b23a9e3863a773` on `arena/c4cc1417-video-factory`. The final SHA is this commit; it is re-read from the remote after push and is not rewritten into this file.

---

## § VS5 — Audio, caption and scene synchronization review

Full detail: `VS5_SYNCHRONIZATION_HANDOFF.md`.

- **Scope:** one timing review on the existing external-narration card. Caption and scene times can be corrected, saved on the storyboard, and explicitly approved. Export stays blocked while that approval is missing or stale. No second timeline and no second approval database.
- **Labels:** estimated stays estimated. A matching `.timing.json` is a script match, not acoustic verification. Manual approval is a separate fact.
- **Approvals:** a timing-only edit does not revoke the listening approval or the ownership statement. Replacing the audio or the spoken script invalidates both approvals for that target only. A visual-only scene edit does not invalidate either.
- **Not claimed:** no real Slima audio, no speech, no MP4, no browser screenshots, no production readiness. The non-render CI URL is in the VS5 handoff.

---

## § VS6 — Integrated audio readiness and safe export preparation

Full detail: `VS6_EXPORT_READINESS_HANDOFF.md`.

- **Scope:** the existing narration review and the existing export page show one server readiness summary. Final export revalidates it for the targets that request will render. No second timeline and no second approval store.
- **Distinction:** ready to attempt export is not publication approval, not a completed render, and not commercial-rights clearance. Estimated timing, a script-matched sidecar, and a manual timing approval are not acoustic verification.
- **Not claimed:** no real Slima audio, no speech, no MP4, no browser screenshots, no production readiness. The non-render CI URL is in the VS6 handoff. VS7 was not started.
