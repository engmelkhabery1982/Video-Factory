# BuildTrack Video Factory

A local, offline video production tool for BuildTrack. Paste a script, upload a
voiceover, get a storyboard, edit it visually, preview it, QC it, and export one
1920×1080 Long video plus up to three native 1080×1920 Shorts — with anti-repetition
enforced across every video you make.

Everything runs on your own machine. No login, no cloud service, no subscription,
no watermark, no publishing. The end user never sees JSON, code, or a terminal.

---

## Run it

**Windows** — double-click `START VIDEO FACTORY.bat`
**macOS / Linux** — run `./START VIDEO FACTORY.sh`

Both launchers do everything: install, provision the renderer, build, check the
environment, then start. If the machine is offline or an install has already
happened, just `npm start`.

The first run installs dependencies, prepares the local renderer and builds the
interface. After that it just starts the app and opens your browser at
<http://localhost:3000>.

### Manual equivalent

```bash
npm install        # dependencies (includes ffmpeg + ffprobe + local Chromium)
npm run provision  # unpack the local headless renderer
npm run build:web  # build the interface
npm start          # start the app
```

Check your machine at any time:

```bash
npm run doctor
```

### Requirements

| | |
|---|---|
| Node.js | 20 or newer |
| Disk | ~1.5 GB (renderer + Chromium) |
| RAM | 2 GB works; 4 GB+ is faster |
| Network | needed once, for `npm install` only |

---

## The workflow

1. **New project** — topic, audience, product, call to action, language.
2. **Script** — paste or import your script. Upload an MP3/WAV voiceover and any
   product shots or B-roll.
3. **Storyboard** — the engine classifies each beat of your script by rhetorical
   function and picks a visual for it. Every scene shows the reason it was chosen
   and the alternatives that were rejected. You can change the scene type, the
   text, the asset, the duration, the motion, lock a scene, or regenerate a single
   scene without losing your other edits.
4. **Preview** — the storyboard plays in the browser at real speed.
5. **QC** — technical, visual and content checks run automatically. Critical
   issues block the export until you record an override reason.
6. **Export** — Long video, up to three Shorts, burned-in and separate captions,
   three thumbnail concepts, titles/description/pinned comment/CTA, a QC report
   and an asset licence manifest.

### Security and exposure

The API and UI are one local Fastify process. It binds to **127.0.0.1** by
default and is therefore not reachable from the network; set `HOST` explicitly
(for example `HOST=0.0.0.0` in a container) only for a deliberate remote/proxy
setup. Every file-serving route (`/media/*`, `/output/*`, the built SPA) is
confined to its own root: dot-dot sequences, encoded separators and symlink
escapes are rejected, directory paths are never streamed, and the SPA is served
with directory listings and dotfiles disabled.

The product lockfile is frozen by the product's own guard
(`tests/production-style-history.test.ts`, gate 20), so the `@fastify/static`
line it pins cannot be upgraded in place. That package's advisories affect its
wildcard static route, so the runtime does not use it: the built UI is served by
a small in-house handler (regular files only, extension allowlist, no dotfiles,
no listings, containment-checked). The remaining `npm audit` findings are
development tooling (vitest / vite / esbuild — not part of the running app) and
the local TTS engine's transitive image libraries, which only ever read local
model files and operator-supplied text; nothing is fetched from the network at
synthesis time. Run `npm audit` to re-check before changing dependencies.

### Legacy projects

Projects created before the production engine (no production sidecar) remain
supported on their original pipeline: they open the legacy storyboard and use the
legacy export path. They are never silently migrated into the production view,
which has no production state to edit or export. New projects always use the
production authority (Scenario → production audio → Phase 5 → Phase 6A →
Phase 6C → Phase 6D). If a production-state read fails, the app falls back to the
legacy storyboard rather than showing an empty production view.

Projects are saved as you go. Close the tab, reopen it tomorrow, your project is
exactly where you left it.

---

## What comes out

```
output/Video_01/
  long/        Video_01_long_final.mp4        1920x1080, H.264, 30fps
  shorts/      Video_01_short_1_final.mp4     1080x1920 native vertical
               Video_01_short_2_final.mp4
               Video_01_short_3_final.mp4
  thumbnails/  concept_1.png concept_2.png concept_3.png
  captions/    .srt  .vtt  .json
  metadata/    titles, description, pinned comment, CTA
  qc/          qc_long.json, qc_short_1.json, ...
  assets/      provenance_and_licences.json
  project.json everything needed to re-open the project
```

---

## The anti-repetition rules

The brand is fixed: same logo, same colours, same fonts, same type scale. What
changes between videos is everything else, and the engine is not allowed to
repeat itself.

| Rule | How it is enforced |
|---|---|
| No same hook in consecutive videos | hooks are scored against the last two videos |
| No scene variant more than twice per video | variant counter per video |
| No transition three scenes running | last-two-transition check |
| Never the same scene order | the order is derived from the rhetorical map, not a template |
| Never always open with a logo card | logo-card opener is excluded from the first-scene pool |
| No same CTA animation three videos running | CTA animation rotates |
| No background beyond 15 continuous seconds | each background carries a `maxContinuousSeconds` and the runner is reset when it changes |
| Weighted visual similarity vs the last five videos | **above 65% the export is blocked** and the engine re-proposes |

The engine is analysis-driven, not random. It reads the beat, records the
evidence, checks the recent-usage constraints, and explains its choice. When
nothing suitable exists it **warns rather than forcing** a bad fit.

---

## Commands

| Command | What it does |
|---|---|
| `npm start` | run the app |
| `npm run doctor` | check the environment |
| `npm test` | run the test suite (53 tests) |
| `npm run provision:voice-clone` | check the optional Chatterbox voice-clone prerequisites (add `-- --apply` to provision once) |
| `npm run voiceovers` | synthesise the demo narration into `data/voiceover/` |
| `npm run demo` | synthesise narration, then build and export all three demo videos |
| `npm run demo:render Video_02` | one demo only (assumes narration exists) |
| `npm run stills` | render QA stills into `.stills/` |
| `npm run verify` | ffprobe every exported file against the delivery spec |
| `npm run evidence` | write test, doctor, ffprobe and QC results into `EVIDENCE/` |
| `npm run seed` | seed the three demo storyboards (no rendering) |
| `npm run build` | build core + web |

---

## Voice cloning (optional)

The factory can optionally clone a **consenting speaker's own voice** locally
with Chatterbox. It is not the default and nothing is installed or downloaded
for it by `npm install`, `npm test`, `npm run build` or `npm start`.

```bash
npm run provision:voice-clone                      # check only: reports, changes nothing
npm run provision:voice-clone -- --apply           # the only command that downloads
npm run doctor -- --require-chatterbox             # report it as a blocking requirement
```

What you need: Linux/macOS, Python 3.11, ≥ 12 GiB free disk, and an NVIDIA GPU
with CUDA for the default device policy (CPU is possible but unverified and must
be approved explicitly). The isolated Python env, the model weights and the
approved reference recordings live in the Git-ignored `.chatterbox/` and
`.voice-references/` directories and are never committed.

Before a single sample is produced, the voice must pass the commercial
publication gate: recorded consent from the speaker (`ownerConfirmed`, not
revoked), **documented first-party commercial rights** (a licence that is silent
about commerce is not permission), an approved audition, and a reference
recording whose SHA-256 still matches the approved profile. There is never a
silent fallback: an approved cloned voice is never quietly replaced by Kokoro or
by another Chatterbox model — mismatches are blocking errors that name the
engine, model, failure category and remediation. Every generated file carries
Resemble AI's Perth neural watermark. Actor generation and lip-sync are out of
scope. See `tools/chatterbox/README.md` for details and troubleshooting.

---

## Layout

```
apps/api     Fastify server: projects, storyboard, assets, render, QC, export
apps/web     the Local Web UI (React + Vite)
packages/core     script analysis, diversity engine, storyboard, captions, QC
packages/video    Remotion compositions, backgrounds, hooks, explanations
tools/        browser provisioning and the environment doctor
tests/        test suite, demo fixtures, renderers and verification
data/         your projects, assets and voiceovers (yours, not committed)
output/       the exported videos and reports
```

See `REVIEW_HANDOFF.md` for the demo results and `DEPENDENCIES.md` for the
full dependency and licence list.
