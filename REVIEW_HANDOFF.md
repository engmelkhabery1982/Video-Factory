# REVIEW_HANDOFF

**BuildTrack Video Factory** — local video production MVP.
Everything below was produced by running the app on this machine. Nothing is
mocked up and no file is a placeholder.

---

## 1. How to run it

**Windows:** double-click `START VIDEO FACTORY.bat`
**macOS / Linux:** `./START VIDEO FACTORY.sh`

The app opens at <http://localhost:3000>. `npm run doctor` reports on the
environment; `npm test` runs the suite.

---

## 2. What was built

| Area | Status |
|---|---|
| Local Web UI (create → script → storyboard → preview → QC → export) | working |
| Project persistence and reopen | working |
| Script analysis (rhetorical classification, evidence, key-number extraction) | working |
| Diversity engine (analysis-driven selection with reasons and alternatives) | working |
| Visual history across videos with weighted similarity | working |
| Scene editing, locking, single-scene regeneration | working |
| Caption generation, SRT/VTT/JSON, correction and retiming | working |
| 8 hooks, 12 explanations, 7 transitions, 8 backgrounds | working |
| Native 9:16 Shorts (3 per video, different angles) | working |
| Thumbnail concepts | working |
| Metadata kit (titles, description, pinned comment, CTA) | working |
| QC with blocking criticals and recorded override | working |
| Asset provenance and licence manifest | working |
| H.264 / AAC export with ffprobe verification | working |
| Remotion Studio preview | working |

### Deliberately not built (out of MVP scope)

ClickUp integration, publishing/auto-post, analytics, cloud rendering, user
accounts, payments, multi-user collaboration, voice cloning, stock-footage
search, and a mobile app. All were deferred by the brief.

---

## 3. Anti-repetition — the part that mattered most

The BuildTrack identity is fixed: one logo, one colour ramp, one type scale.
Everything else is treated as variable and is checked against the history of
videos you have already made.

| Rule | Enforced in | Behaviour |
|---|---|---|
| No same hook in consecutive videos | `core/diversity.ts` | hooks scored against the last two entries |
| No scene variant more than twice per video | per-video counter | a third use is blocked, and the beat is flagged |
| No transition three scenes running | last-two check | fourth consecutive use is blocked |
| Never the same scene order | rhetorical map drives the order | no fixed template exists in the code |
| Never always open with a logo card | first-scene pool excludes it | guaranteed on every video |
| No same CTA animation three videos running | CTA rotation | rotates across videos |
| No background beyond 15 continuous seconds | per-variant `maxContinuousSeconds` | background runner resets on change |
| Similarity vs last five videos | `core/history.ts` | **>65% blocks export** and re-proposes |

The engine is **analysis-driven, not random**. Each scene records:
`reason.detected` (what the beat was classified as), `reason.evidence` (the
signals in the script that led there), `reason.score` (the ranked candidates),
and `reason.alternatives` (what else was considered and why it lost).

When nothing structurally fits a beat, the engine **warns instead of forcing**:

> `Scene 7: no scene variant structurally fits a "myth" beat - review this
> section manually.`

---

## 4. Evidence

### 4.1 Tests

```
npm test
  Test Files  1 passed (1)
       Tests  50 passed (50)
```

The suite (`tests/diversity.test.ts`) covers the catalog minimums, decimal-safe
script analysis, rhetorical classification, natural headline condensation, the
Long and Short structural rules, every anti-repetition rule, cross-video
diversity, caption line limits and glossary handling, QC detection of each
reference-video failure mode, the export specification, the fixed brand layer,
and similarity behaviour.

### 4.1a Defects found by review, and fixed

These were not theoretical. Each one was found by looking at the actual output
or by running the type checker, and each now has a regression test.

| Defect | How it was found | Fix |
|---|---|---|
| **Shorts were 94.56s instead of ~24s** | ffprobe on the first export | ffmpeg was muxing without `-shortest`, so the 95s narration stretched every Short. Added `-shortest` plus an explicit `-t` cap from the storyboard duration. |
| **QC did not catch the 94s Short** | reading the QC report, which said WARN | the duration check only tested `> 0.5s`. It now verifies the file against the target range (Long 45–180s, Short 20–35s) and reports **critical**. |
| **`split_screen` printed the same sentence on both sides** | reading a rendered frame | a one-clause beat fell back to the same text twice, and the side labels literally read "LEFT" and "RIGHT". Two-sided variants now guarantee two distinct sides and meaningful labels. |
| **Hook headlines cut mid-phrase** ("That 10.5 percent gap is not a") | reading a rendered frame | `firstSentence` sliced at a fixed word count. It now cuts on a real sentence or clause boundary, treats a dot between digits as a decimal point, and drops trailing function words. |
| **Sub line repeated the headline verbatim** | reading a rendered frame | the sub line is derived from the same sentence, so it is only shown when it genuinely adds something. |
| **Content hugged the top of the frame** | reading a rendered frame | the long layout was `justify-content: flex-start`, leaving roughly half the frame dead. The block is now optically centred. |
| **The glossary rewrote readable text into acronyms** ("earned value management" → "EVM") | a failing test | captions must stay readable, so a spelled-out term is no longer replaced by an abbreviation. |
| **A `toast()` call passed a tone that does not exist** (`'warn'`) | `tsc --noEmit` on the web app | corrected to the real union; the strict web typecheck is now clean. |

### 4.2 Demo videos

Three required topics, same brand, deliberately different storytelling:

| | Video_01 | Video_02 | Video_03 |
|---|---|---|---|
| Topic | Executed 70% vs Accepted 59.5% | Why the Last 30% May Be the Hardest | Can You Trust the S-Curve? |
| Opening hook | Risk / Warning | Common Mistake | Question |
| Dominant backgrounds | dark_grid, light_technical, split_visual | full_typography, blueprint, light_technical, split_visual, dark_grid | dark_grid, light_technical, blueprint, split_visual |
| CTA animation | counter_up | slide_in | wipe_reveal |
| Caption style | highlight_box | side_panel | boxed_center |
| Similarity vs history | 0% | 40% | 46% |

All three are below the 65% similarity block threshold. Full results are in
`output/demo_summary.json`.

### 4.3 ffprobe verification

```
npm run verify
```

Re-reads every exported MP4 from disk and checks it against the delivery
specification — it does not trust the renderer's own report. See
`EVIDENCE/ffprobe.txt` for the recorded run.

### 4.4 Screenshots and stills

| File | What it shows |
|---|---|
| `EVIDENCE/ui-projects.png` | the project list and the anti-repetition history |
| `EVIDENCE/ui-storyboard.png` | scene editing with reasons and alternatives |
| `EVIDENCE/ui-qc.png` | the QC report |
| `EVIDENCE/contact-sheet-*.png` | frames sampled from the finished videos |
| `.stills/` | QA stills per scene type |

---

## 5. Reference videos as negative references

The four BuildTrack reference videos were **not modified and not deleted**. They
were used only as negative references. Every failure mode below is a QC check
in the app:

| Observed failure | Check that catches it |
|---|---|
| slow, drawn-out intro | hook duration must be 5–8s |
| static slides | static-scene and black-frame detection |
| repeated summary | duplicate-summary check; exactly one summary allowed |
| late, long CTA | exactly one CTA, 6–8s, and it must be last |
| clipped titles | title/safe-zone and caption-line checks |
| low bitrate | bitrate check against the spec |
| shrunken landscape Shorts | 9:16 native composition check; shorts are authored separately, never resized |
| small text | minimum type-size check |
| platform-UI collisions | safe-zone check for the right rail and bottom third |

---

## 6. Known limitations

1. **Render speed.** On a 2-CPU, 3 GB machine with no GPU, rendering runs at
   roughly 4 fps. A 95-second Long takes around 25 minutes; each 24-second Short
   about 6 minutes. This is a property of software rasterisation, not of the
   code. A machine with a GPU is substantially faster.
2. **No WebGL.** The visuals are CSS/SVG/DOM only, because SwiftShader
   initialisation fails in this environment. This affects nothing in the brief;
   it is why the backgrounds are drawn with gradients and SVG rather than shaders.
3. **Caption timing is estimated.** Word-count proportional alignment against
   the real voiceover duration. It is accurate to roughly ±0.4s. Whisper-based
   forced alignment was not possible because model downloads are blocked here.
   The Captions page lets you retime any cue by hand without losing sync.
4. **Similarity scoring is structural.** It compares the weighted mix of
   variants, transitions, backgrounds, positions, accents and montage rhythm. It
   does not do perceptual video comparison of the rendered pixels.
5. **Arabic is supported as project language and captions**, but the on-screen
   type scale was tuned for Latin. Arabic script shapes and RTL layouts need a
   dedicated pass before being called production-ready.
6. **Thumbnail concepts are generated frames**, not designed poster artwork.
   Three distinct concepts are produced; a designer would still finish them.

---

## 7. Unimplemented list

Everything below was consciously deferred, per the MVP scope:

- ClickUp integration
- Publishing and auto-posting
- Analytics
- Cloud rendering
- User accounts, payments, multi-user
- Voice cloning and paid TTS
- Stock-footage search and automatic asset download
- Mobile app
- Real-time collaboration
- Perceptual (pixel-level) similarity scoring
- Whisper-grade forced alignment for captions

---

## 8. Where everything is

| Path | Contents |
|---|---|
| `output/Video_0N/` | the exported deliverables for each demo |
| `output/demo_summary.json` | machine-readable summary of the three demos |
| `data/projects/` | saved projects — reopen these in the UI |
| `data/visual_history.json` | the anti-repetition memory |
| `EVIDENCE/` | screenshots, ffprobe output, test output |
| `.stills/` | per-scene QA stills |
