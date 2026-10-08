# Dependencies and licences

Everything below is installed from npm. Nothing is downloaded at render time and
no asset of unknown licence is ever fetched automatically.

## Runtime

| Package | Licence | Why |
|---|---|---|
| `remotion` 4.0.529 | Remotion License (free for individuals and small companies; a company licence is required for larger for-profit organisations — see `node_modules/remotion/LICENSE.md`) | React-based video rendering |
| `@remotion/renderer` 4.0.529 | Remotion License | headless frame rendering |
| `@remotion/bundler` 4.0.529 | Remotion License | webpack bundle for the compositions |
| `@remotion/cli` 4.0.529 | Remotion License | `npm run remotion:studio` preview |
| `react` / `react-dom` 19 | MIT | UI and composition runtime |
| `fastify` 5 | MIT | local API server |
| `@fastify/static` 8 | MIT | serves the built UI and media |
| `@fastify/multipart` 9 | MIT | asset and voiceover uploads |
| `@ffmpeg-installer/ffmpeg` 1.1 | LGPL-2.1 | ffmpeg binary, installed as an npm package |
| `ffprobe-static` 3.1 | MIT | ffprobe binary for QC and verification |
| `@sparticuz/chromium` 153 | MIT | supplies the Chromium build unpacked into `.browser/` |
| `vite` 6 | MIT | builds the Local Web UI |
| `@vitejs/plugin-react` 4 | MIT | React plugin for Vite |
| `@fontsource-variable/inter` 5.3 | SIL Open Font License 1.1 | heading and body type |
| `@fontsource/jetbrains-mono` 5.3 | SIL Open Font License 1.1 | numeric type |
| `typescript` 5.9 | Apache-2.0 | build-time type checking |
| `tsx` 4.23 | MIT | runs the TypeScript API server and tools directly |
| `sam-js` 0.3 | see `node_modules/sam-js/README.md` (SAM is a reimplementation of a 1982 public-domain speech synthesiser) | offline placeholder narration for the demo |
| `kokoro-js` 1.2.1 (exact pin; declared in the root `devDependencies`) | Apache-2.0 (`node_modules/kokoro-js/LICENSE`) | production dialogue speech: the local, cache-only TTS adapter |
| `@huggingface/transformers` 3.8.1 (via `kokoro-js`) | Apache-2.0 | model loading and cache-only inference for Kokoro |
| `phonemizer` 1.2.1 (via `kokoro-js`) | Apache-2.0 | grapheme-to-phoneme conversion for Kokoro |
| `onnxruntime-node` 1.21.0 / `onnxruntime-web` (via `kokoro-js`) | MIT | ONNX execution of the Kokoro model on CPU |

## Production speech model (downloaded once, never at render time)

| Model | Licence | Source |
|---|---|---|
| `onnx-community/Kokoro-82M-v1.0-ONNX` | Apache-2.0 (recorded by `tools/provision-tts.mjs`, which pins this exact model id) | downloaded by `npm run provision:tts` into the gitignored `.tts-cache/models`; **no model file is committed to this repository** |
| Kokoro preset voices (`voices/*.bin`, 28 en-US/en-GB presets) | Apache-2.0, shipped inside the `kokoro-js` package | installed by `npm ci`, read from `node_modules` at synthesis time |

Synthesis itself runs with `allowRemoteModels = false`: once provisioned, no
network is touched, and a missing cache fails loudly instead of silently
downloading or falling back to another voice.

## Development only

| Package | Licence | Why |
|---|---|---|
| `vitest` 2.1 | MIT | test runner |
| `puppeteer-core` 25.12 | Apache-2.0 | drives the local Chromium for UI screenshots |
| `@types/node` 22 | MIT | Node type definitions |

## Bundled binaries

| Binary | Licence | Source |
|---|---|---|
| ffmpeg | LGPL-2.1 (compiled with `--enable-gpl`) | `@ffmpeg-installer/linux-x64` / `ffmpeg-installer-win32-x64` npm packages |
| ffprobe | GPL-2.0 (ffmpeg build) | `ffprobe-static` npm package |
| Chromium | BSD-3-Clause | `@sparticuz/chromium` npm package, unpacked by `tools/provision-browser.mjs` into `.browser/` |

No system `apt`/`brew` install is required. `npm install` plus
`npm run provision` is enough on a machine with no admin rights.

## Fonts

Inter and JetBrains Mono are bundled through `@fontsource-*` under the
**SIL Open Font License 1.1**, which permits commercial use and embedding in
video output. Both are installed as npm packages; neither is downloaded from a
font CDN at render time.

## Assets

All visuals in the demo output are generated from code — no stock footage, no
scraped imagery, no unknown-licence downloads. Product logos used in the demo
are the local `BUILTRACK_LOGO_SVG` shipped in `packages/core/src/brand.ts`.

For your own uploads, every asset carries a `licence` and `source` field. The
app records them in `output/<Video>/assets/provenance_and_licences.json` and
refers to assets whose licence is unknown only after you confirm it in the Asset
Library.

## No paid services

No cloud rendering, no stock-footage search, no paid text-to-speech, no voice
cloning, no analytics, no accounts.

## Voice rights, consent and commercial publication (VS1)

Every production voice now carries an auditable commercial profile
(`VoicePublicationProfile` in `packages/core/src/scenario/voice-types.ts`):
engine identity (engine family, model id, pinned revision, runtime pin), the
acoustic source (a reference recording identified by safe relative path +
SHA-256 + duration + sample rate + channels, or a named preset voice shipped
inside a pinned model), recorded owner consent with scope and revocation state,
first-party commercial-rights evidence with licence name, evidence URL and
access date, an audition decision, and a publication state
(`draft | review_only | approved`).

`evaluateVoicePublicationGate()`
(`packages/core/src/scenario/voice-publication-gate.ts`) is the single
deterministic decision point. `buildDialogueProductionPlan` runs it before any
audio is synthesized, so an unapproved voice produces structured
`VOICE_PUBLICATION_BLOCKED` findings and writes nothing.

Two rules worth stating explicitly:

- **A licence that does not prohibit commerce is not permission.** Commercial
  use must be recorded as `permitted` on first-party evidence. `unknown`,
  `not_stated`, `conditional` and `prohibited` all block, and an `approved`
  publication stamp on a record with missing evidence blocks too.
- **No cloning engine is installed.** Nothing in this repository clones a
  private individual's voice today: the shipped production voice path is the
  local Kokoro presets above, whose migrated consent record names the model
  provider (`subject: 'model_provider_preset'`) rather than inventing a human
  signature. The `chatterbox` engine family and the cloned-reference contract
  exist so that if such an engine is ever added, the recording's consent,
  reference hash and rights evidence must be authored and auditioned before it
  can publish — and the synthesis reuse key changes whenever the reference
  recording, engine, model revision or synthesis settings change.

The eight legacy Phase 4A Kokoro fixtures stay publishable through an explicit,
deterministic migration (`voice-publication-migration.ts`) instead of being
grandfathered silently. Their audition approval is flagged `inherited: true`
because it rests on the accepted baseline run
(`EVIDENCE/final-product/audio-verification.json`) rather than on a new
listening test, and their rights evidence was verified against the pinned local
dependency rather than re-fetched from the provider (this repository makes no
network calls). The gate reports both facts as warnings, and as blocking errors
under `strictFirstPartyEvidence`. A new or custom voice with no authored
evidence migrates to a `draft` skeleton and is never marked approved.

## The demo narration is generated, not shipped

`data/` is gitignored, so **no MP3 is committed to this repository**. Earlier
documentation claimed the three demo voiceovers were shipped; they were not, and
a fresh clone of `npm run demo` would have failed with `Missing narration`.

They are now generated on demand instead:

```bash
npm run voiceovers
```

This reads the three demo scripts in `tests/fixtures/demo-projects.ts` and
writes a local narration track per project to:

| Path | Duration |
|---|---|
| `data/voiceover/Video_01.mp3` | ~95 s |
| `data/voiceover/Video_02.mp3` | ~96 s |
| `data/voiceover/Video_03.mp3` | ~90 s |

The synthesiser is SAM (Software Automatic Mouth, 1982) compiled to JavaScript.
It runs entirely offline and free, and it is a genuinely old, recognisable voice.
It exists so the export pipeline can be exercised end to end on a clean machine
— **it is a placeholder, not a demo of audio quality.**

If you want the demo to use your own narration, drop your own files at exactly
those three paths, with the same file names, in **MP3 or WAV** format. The script
skips any file that already exists, and the pipeline treats any MP3 or WAV
identically. A normal user never runs this script at all: they record their
narration and upload it through the New Project page.
