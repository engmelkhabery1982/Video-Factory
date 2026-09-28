import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Independent ffprobe verification of every exported deliverable.
 * This deliberately re-reads the finished files from disk rather than trusting
 * the renderer's own report, because the brief requires the *files* to comply.
 */

const FFPROBE = path.resolve('node_modules/ffprobe-static/bin/linux/x64/ffprobe');
const OUT = path.resolve('output');

/** Brief section 15: the delivery specification, restated here as the contract. */
export const RULES = {
  long: { width: 1920, height: 1080, minSec: 60, maxSec: 180 },
  short: { width: 1080, height: 1920, minSec: 20, maxSec: 35 },
  fps: 30,
  videoCodec: 'h264',
  pixFmt: 'yuv420p',
  audio: { sampleRate: 48000, minKbps: 192, maxKbps: 256 },
};

export interface ProbeResult {
  file: string;
  kind: 'long' | 'short';
  ok: boolean;
  actual: Record<string, unknown>;
  failures: string[];
}

function probe(file: string): any {
  const raw = execFileSync(
    FFPROBE,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(raw);
}

export function verifyFile(file: string, kind: 'long' | 'short'): ProbeResult {
  const r = RULES[kind];
  const failures: string[] = [];
  const meta = probe(file);
  const v = (meta.streams ?? []).find((s: any) => s.codec_type === 'video');
  const a = (meta.streams ?? []).find((s: any) => s.codec_type === 'audio');
  const dur = Number(meta.format?.duration ?? 0);
  const fpsParts = String(v?.avg_frame_rate ?? '0/1').split('/');
  const fps = Number(fpsParts[1]) ? Number(fpsParts[0]) / Number(fpsParts[1]) : 0;
  const kbps = a ? (Number(a.bit_rate ?? 0) || (dur * Number(a.bit_rate ?? 0)) / 1000 || 0) : 0;
  const bitrateKbps = Math.round(Number(meta.format?.bit_rate ?? 0) / 1000);

  const actual = {
    width: v?.width ?? null,
    height: v?.height ?? null,
    fps: Number(fps.toFixed(3)),
    videoCodec: v?.codec_name ?? null,
    pixFmt: v?.pix_fmt ?? null,
    profile: v?.profile ?? null,
    durationSec: Number(dur.toFixed(2)),
    containerBitrateKbps: bitrateKbps,
    audioCodec: a?.codec_name ?? null,
    audioSampleRate: a ? Number(a.sample_rate ?? 0) : null,
    audioChannels: a?.channels ?? null,
    audioBitrateKbps: a ? Math.round(Number(a.bit_rate ?? 0) / 1000) : null,
    nbFrames: v?.nb_frames ?? null,
  };
  void kbps;

  if (actual.width !== r.width || actual.height !== r.height)
    failures.push(`resolution ${actual.width}x${actual.height} != ${r.width}x${r.height}`);
  if (Math.abs(Number(actual.fps) - RULES.fps) > 0.02) failures.push(`fps ${actual.fps} != ${RULES.fps}`);
  if (actual.videoCodec !== RULES.videoCodec) failures.push(`video codec ${actual.videoCodec} != ${RULES.videoCodec}`);
  if (actual.pixFmt !== RULES.pixFmt) failures.push(`pix_fmt ${actual.pixFmt} != ${RULES.pixFmt}`);
  if (actual.durationSec < r.minSec || actual.durationSec > r.maxSec)
    failures.push(`duration ${actual.durationSec}s outside ${r.minSec}-${r.maxSec}s`);
  if (!a) failures.push('no audio stream');
  else {
    if (actual.audioSampleRate !== RULES.audio.sampleRate)
      failures.push(`audio sample rate ${actual.audioSampleRate} != ${RULES.audio.sampleRate}`);
    const ak = Number(actual.audioBitrateKbps ?? 0);
    if (ak < RULES.audio.minKbps || ak > RULES.audio.maxKbps)
      failures.push(`audio bitrate ${ak}kbps outside 192-256kbps`);
  }

  return { file: path.relative(process.cwd(), file), kind, ok: failures.length === 0, actual, failures };
}

/** Every mp4 under output/, classified as long or short by its resolution. */
export function verifyAll(): ProbeResult[] {
  if (!fs.existsSync(OUT)) return [];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.mp4')) files.push(p);
    }
  };
  walk(OUT);
  return files
    .sort()
    .map((f) => {
      const meta = probe(f);
      const v = (meta.streams ?? []).find((s: any) => s.codec_type === 'video');
      return verifyFile(f, v && v.height > v.width ? 'short' : 'long');
    });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const results = verifyAll();
  if (!results.length) {
    console.log('No mp4 files found under output/.');
    process.exit(0);
  }
  const rows = results.map((r) => ({
    file: r.file,
    ok: r.ok ? 'PASS' : 'FAIL',
    res: `${r.actual.width}x${r.actual.height}`,
    fps: r.actual.fps,
    codec: `${r.actual.videoCodec}/${r.actual.pixFmt}`,
    dur: `${r.actual.durationSec}s`,
    vid: `${r.actual.containerBitrateKbps}kbps`,
    aud: r.actual.audioCodec ? `${r.actual.audioCodec} ${r.actual.audioSampleRate}Hz ${r.actual.audioBitrateKbps}kbps` : 'MISSING',
    failures: r.failures,
  }));
  console.table(rows.map(({ failures, ...rest }) => rest));
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.file}: ${r.failures.join('; ')}`);
  const passed = results.filter((r) => r.ok).length;
  console.log(`\nffprobe: ${passed}/${results.length} files meet the delivery spec.`);
  process.exit(passed === results.length ? 0 : 1);
}
