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
cloning, no analytics, no accounts. The three demo voiceover files in
`data/voiceover/` were produced once during development and are shipped as
ordinary local MP3s, exactly as if they had been recorded.
