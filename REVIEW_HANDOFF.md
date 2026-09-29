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
