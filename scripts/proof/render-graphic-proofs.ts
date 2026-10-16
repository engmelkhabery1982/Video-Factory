/**
 * Offline frame proof for procedural graphics. Not the Remotion browser render (no Chromium in this sandbox).
 *
 * Pipeline, per frame: the SAME ProceduralGraphicSvg component the Remotion scene uses -> SVG markup (react-dom/server)
 * -> rasterised by sharp (librsvg) -> encoded by Remotion's bundled ffmpeg (libx264). The shared core evaluator gives
 * every frame state. The output is labelled as a frame proof in the manifest.
 *
 * Usage: node --import tsx scripts/proof/render-graphic-proofs.ts <outDir-outside-repo> <evidenceDir-in-repo>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import sharp from 'sharp';
import { assertValidGraphic } from '../../packages/core/src/editor/graphics.ts';
import { ProceduralGraphicSvg } from '../../packages/video/src/graphics/ProceduralGraphicSvg.tsx';
import { PROOF_FPS, proofScenes, type ProofFormat, type ProofScene } from '../../tests/fixtures/graphic-proof-specs.ts';

const outDir = path.resolve(process.argv[2] ?? '/home/user/graphic-proofs');
const evidenceDir = path.resolve(process.argv[3] ?? 'evidence/graphic-proofs');
const compositor = path.resolve('node_modules/@remotion/compositor-linux-x64-gnu');
const ffmpeg = path.join(compositor, 'ffmpeg');
const ffprobe = path.join(compositor, 'ffprobe');
const SIZES: Record<ProofFormat, { w: number; h: number }> = {
  landscape: { w: 1920, h: 1080 },
  portrait: { w: 1080, h: 1920 },
};
/** Stills kept as evidence, in seconds of the proof clock. Two or more per proof, to show motion. */
const EVIDENCE_TIMES: Record<string, number[]> = {
  educational: [1.2, 3.2, 9.0],
  procedural_2d: [1.0, 3.5, 6.5],
  mixed_religious: [2.0, 5.0, 8.5],
};

/** Fixture illustration (not generated): a plain closed book and a brass oil lamp in an empty warm room. No text. */
function illustrationSvg(w: number, h: number): string {
  const s = Math.min(w, h) / 1000;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs><linearGradient id="wall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5a3b28"/><stop offset="1" stop-color="#2a1b12"/></linearGradient>
  <radialGradient id="glow" cx="0.3" cy="0.45" r="0.6"><stop offset="0" stop-color="#ffcf7a" stop-opacity="0.55"/><stop offset="1" stop-color="#ffcf7a" stop-opacity="0"/></radialGradient></defs>
  <rect width="${w}" height="${h}" fill="url(#wall)"/>
  <rect width="${w}" height="${h}" fill="url(#glow)"/>
  <rect x="0" y="${h * 0.72}" width="${w}" height="${h * 0.28}" fill="#3d2616"/>
  <rect x="${w * 0.22}" y="${h * 0.5}" width="${280 * s}" height="${44 * s}" rx="${6 * s}" fill="#6b3f22"/>
  <rect x="${w * 0.22 + 14 * s}" y="${h * 0.5 - 8 * s}" width="${252 * s}" height="${12 * s}" fill="#8a5630"/>
  <circle cx="${w * 0.66}" cy="${h * 0.5 - 36 * s}" r="${46 * s}" fill="#c9a04a"/>
  <rect x="${w * 0.66 - 22 * s}" y="${h * 0.5 - 4 * s}" width="${44 * s}" height="${30 * s}" fill="#b08a3e"/>
  <ellipse cx="${w * 0.66}" cy="${h * 0.5 - 90 * s}" rx="${16 * s}" ry="${34 * s}" fill="#ffd27a"/>
</svg>`;
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(evidenceDir, { recursive: true });
  const manifest: Record<string, unknown>[] = [];
  for (const format of ['landscape', 'portrait'] as ProofFormat[]) {
    const { w, h } = SIZES[format];
    const scenesByProof = proofScenes(format);
    for (const [proof, scenes] of Object.entries(scenesByProof) as Array<[string, ProofScene[]]>) {
      const profile = proof === 'mixed_religious' ? 'religious' : 'educational';
      for (const s of scenes) {
        if (s.kind === 'graphic') assertValidGraphic(s.graphic, { durationSec: s.durationSec, format, contentProfile: profile as 'religious' | 'educational' });
      }
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `gfx-${proof}-${format}-`));
      let frame = 0;
      const evidence: Array<{ tSec: number; file: string; sha256: string }> = [];
      const wanted = new Set(EVIDENCE_TIMES[proof] ?? []);
      let clock = 0;
      for (const scene of scenes) {
        const n = Math.round(scene.durationSec * PROOF_FPS);
        for (let i = 0; i < n; i++) {
          const local = i / PROOF_FPS;
          const svg = scene.kind === 'graphic'
            ? renderToStaticMarkup(React.createElement(ProceduralGraphicSvg, { graphic: scene.graphic, timeSec: local, width: w, height: h }))
            : illustrationSvg(w, h);
          const png = await sharp(Buffer.from(svg)).png().toBuffer();
          const file = path.join(tmp, `frame_${String(frame).padStart(5, '0')}.png`);
          fs.writeFileSync(file, png);
          const t = clock + local;
          for (const want of [...wanted]) {
            if (Math.abs(want - t) < 0.5 / PROOF_FPS + 1e-9) {
              const dest = path.join(evidenceDir, `${proof}-${format}-t${want.toFixed(1)}.png`);
              fs.copyFileSync(file, dest);
              evidence.push({ tSec: want, file: path.relative(process.cwd(), dest), sha256: createHash('sha256').update(png).digest('hex') });
              wanted.delete(want);
            }
          }
          frame++;
        }
        clock += scene.durationSec;
      }
      const mp4 = path.join(outDir, `${proof}-${format}.mp4`);
      execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-framerate', String(PROOF_FPS), '-i', path.join(tmp, 'frame_%05d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
      const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', mp4]).toString());
      const v = probe.streams.find((x: { codec_type: string }) => x.codec_type === 'video');
      const sha = createHash('sha256').update(fs.readFileSync(mp4)).digest('hex');
      manifest.push({
        proof, format, width: v.width, height: v.height, fps: PROOF_FPS, frames: frame,
        durationSec: Number(probe.format.duration), mp4File: mp4, mp4Sha256: sha, mp4Bytes: fs.statSync(mp4).size,
        evidenceStills: evidence,
        label: 'FRAME PROOF: procedural graphic, synthetic FIXTURE content, offline rasterisation (sharp/librsvg) and libx264. Not the Remotion browser render. Not owner acceptance.',
      });
      fs.rmSync(tmp, { recursive: true, force: true });
      console.log(`${proof} ${format}: ${frame} frames, ${v.width}x${v.height}, ${Number(probe.format.duration).toFixed(2)} s, ${sha.slice(0, 16)}`);
    }
  }
  fs.writeFileSync(path.join(evidenceDir, 'manifest.json'), JSON.stringify({ generatedBy: 'scripts/proof/render-graphic-proofs.ts', fps: PROOF_FPS, proofs: manifest }, null, 2) + '\n');
}

main().catch((err) => { console.error(err); process.exit(1); });
