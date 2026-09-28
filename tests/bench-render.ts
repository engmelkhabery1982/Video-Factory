import { bundle } from '@remotion/bundler';
import { renderStill, selectComposition } from '@remotion/renderer';
import path from 'node:path';
import fs from 'node:fs';
import { buildStoryboard, emptyHistory, getBrandPreset } from '@buildtrack/core';
import { DEMO_PROJECTS } from '../tests/fixtures/demo-projects.js';

const ROOT = path.resolve(process.cwd());
const BROWSER = path.join(ROOT, '.browser', 'chrome');
process.env.LD_LIBRARY_PATH = [path.join(ROOT, '.browser', 'lib'), path.join(ROOT, '.browser'), process.env.LD_LIBRARY_PATH]
  .filter(Boolean)
  .join(':');

async function main() {
  const serveUrl = await bundle({
    entryPoint: path.join(ROOT, 'packages/video/src/index.ts'),
    outDir: path.join(ROOT, '.remotion'),
  });
  const sb: any = buildStoryboard({ input: DEMO_PROJECTS[0], history: emptyHistory() });

  for (const [label, scenes, format] of [
    ['long', sb.long.scenes, 'long'],
    ['short', sb.shorts[0].scenes, 'short'],
  ] as const) {
    const props = {
      scenes, captions: sb.captions, brand: getBrandPreset('buildtrack'), format,
      ctaAnimation: sb.historyEntry.ctaAnimation, captionStyle: sb.historyEntry.captionStyle,
      ctaText: DEMO_PROJECTS[0].cta, productName: 'BuildTrack', logoSrc: null, audioSrc: null,
      burnedCaptions: true, mediaMap: {},
    };
    const id = format === 'long' ? 'LongVideo' : 'ShortVideo';
    const comp = await selectComposition({ serveUrl, id, inputProps: props, browserExecutable: BROWSER });
    fs.mkdirSync(path.join(ROOT, '.stills'), { recursive: true });
    const t0 = Date.now();
    const N = 5;
    for (let i = 0; i < N; i++) {
      const frame = Math.round((comp.durationInFrames * (i + 1)) / (N + 1));
      await renderStill({
        composition: comp, serveUrl, output: path.join(ROOT, '.stills', `${label}-${frame}.png`),
        inputProps: props, frame, browserExecutable: BROWSER,
        chromiumOptions: { gl: 'swangle', headless: true },
      });
    }
    const dt = (Date.now() - t0) / 1000;
    console.log(`${label}: ${N} frames in ${dt.toFixed(1)}s = ${(dt / N).toFixed(2)}s/frame -> ${comp.durationInFrames} frames total ~= ${((comp.durationInFrames * dt) / N / 60).toFixed(1)} min`);
  }
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
