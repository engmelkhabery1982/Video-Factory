import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import path from 'node:path';
import fs from 'node:fs';
import { buildStoryboard, emptyHistory, getBrandPreset } from '@buildtrack/core';
import { DEMO_PROJECTS } from '../tests/fixtures/demo-projects.js';

const ROOT = path.resolve(process.cwd());
const BROWSER = path.join(ROOT, '.browser', 'chrome');
process.env.LD_LIBRARY_PATH = [path.join(ROOT, '.browser', 'lib'), path.join(ROOT, '.browser'), process.env.LD_LIBRARY_PATH]
  .filter(Boolean).join(':');

async function main() {
  const serveUrl = await bundle({ entryPoint: path.join(ROOT, 'packages/video/src/index.ts'), outDir: path.join(ROOT, '.remotion') });
  const sb: any = buildStoryboard({ input: DEMO_PROJECTS[0], history: emptyHistory() });
  const props = {
    scenes: sb.long.scenes, captions: sb.captions, brand: getBrandPreset('buildtrack'), format: 'long',
    ctaAnimation: sb.historyEntry.ctaAnimation, captionStyle: sb.historyEntry.captionStyle,
    ctaText: DEMO_PROJECTS[0].cta, productName: 'BuildTrack', logoSrc: null, audioSrc: null,
    burnedCaptions: true, mediaMap: {},
  };
  const comp = await selectComposition({ serveUrl, id: 'LongVideo', inputProps: props, browserExecutable: BROWSER });
  const out = path.join(ROOT, '.bench.mp4');
  const t0 = Date.now();
  let lastLog = 0;
  await renderMedia({
    composition: comp, serveUrl, codec: 'h264', outputLocation: out, inputProps: props,
    browserExecutable: BROWSER, chromiumOptions: { gl: 'swangle', headless: true },
    concurrency: 2, imageFormat: 'jpeg', jpegQuality: 92,
    frameRange: [0, 200],
    onProgress: ({ renderedFrames }) => {
      const now = Date.now();
      if (now - lastLog > 5000) {
        lastLog = now;
        const fps = renderedFrames / ((now - t0) / 1000);
        console.log(`${renderedFrames} frames  ${fps.toFixed(2)} fps  elapsed ${((now - t0) / 1000).toFixed(0)}s  ETA(3000f)=${((2998-renderedFrames)/fps/60).toFixed(1)}min`);
      }
    },
  });
  console.log(`DONE 200 frames in ${((Date.now() - t0) / 1000).toFixed(1)}s = ${(200 / ((Date.now() - t0) / 1000)).toFixed(2)} fps; size=${(fs.statSync(out).size/1e6).toFixed(2)}MB`);
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
