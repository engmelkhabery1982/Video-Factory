import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Repository root.
 * __dirname = <root>/apps/api/src/services  ->  four levels up.
 */
export const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
export const DATA_DIR = process.env.BUILDTRAKE_DATA ?? path.join(ROOT, 'data');
export const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
export const ASSETS_DIR = path.join(DATA_DIR, 'assets');
export const OUTPUT_DIR = process.env.BUILDTRAKE_OUTPUT ?? path.join(ROOT, 'output');
export const HISTORY_FILE = path.join(DATA_DIR, 'visual_history.json');

export function ensureDirs() {
  for (const d of [DATA_DIR, PROJECTS_DIR, ASSETS_DIR, OUTPUT_DIR]) fs.mkdirSync(d, { recursive: true });
}

export function projectDir(videoId: string) {
  return path.join(PROJECTS_DIR, videoId);
}
export function projectFile(videoId: string) {
  return path.join(projectDir(videoId), 'project.json');
}
export function projectAssetDir(videoId: string) {
  return path.join(projectDir(videoId), 'assets');
}

/* ------------------------------------------------------------------ */
/*  Production audio path authority                                    */
/* ------------------------------------------------------------------ */

/**
 * The PROJECT-SCOPED production audio roots, relative to the process cwd.
 *
 * This is the single product authority for where production dialogue audio
 * lives. `buildDialogueProductionPlan` refuses absolute paths, so these are
 * deliberately relative (no machine-specific prefixes, no shared/fixture
 * directory, never `.tts-cache`).
 *
 * Every caller — the product API routes and the acceptance driver — must use
 * this helper instead of re-deriving the path, so acceptance can never look in
 * a stale directory again.
 */
export function productionAudioBasePaths(videoId: string): {
  /** project-scoped production audio root */
  root: string;
  /** per-turn dialogue WAV root (Kokoro output) */
  synthesisBasePath: string;
  /** normalized canonical audio root */
  canonicalBasePath: string;
} {
  const root = `.production/${videoId}/audio`;
  return {
    root,
    synthesisBasePath: `${root}/dialogue`,
    canonicalBasePath: `${root}/canonical`,
  };
}

/** Convenience: the production audio base paths as the plan builders want them. */
export function productionAudioPlanPaths(videoId: string): { synthesisBasePath: string; canonicalBasePath: string } {
  const { synthesisBasePath, canonicalBasePath } = productionAudioBasePaths(videoId);
  return { synthesisBasePath, canonicalBasePath };
}

/* ------------------------------------------------------------------ */
/* ffmpeg / ffprobe                                                    */
/* ------------------------------------------------------------------ */

/**
 * Both binaries come from npm packages that ship the executable INSIDE the
 * tarball, so they work on a machine with nothing installed and behind a
 * firewall that blocks the usual download hosts. A system ffmpeg always wins
 * if the operator has a newer one.
 */
export function ffmpegPath(): string {
  const env = process.env.BUILDTRAKE_FFMPEG;
  if (env && fs.existsSync(env)) return env;
  const sys = whichSync('ffmpeg');
  if (sys) return sys;
  const p = require('@ffmpeg-installer/ffmpeg') as { path: string; version: string };
  if (p?.path && fs.existsSync(p.path)) return p.path;
  throw new Error('ffmpeg not found. Set BUILDTRAKE_FFMPEG or install ffmpeg.');
}

export function ffprobePath(): string {
  const env = process.env.BUILDTRAKE_FFPROBE;
  if (env && fs.existsSync(env)) return env;
  const sys = whichSync('ffprobe');
  if (sys) return sys;
  const p = require('ffprobe-static') as { path: string };
  if (p?.path && fs.existsSync(p.path)) return p.path;
  throw new Error('ffprobe not found. Set BUILDTRAKE_FFPROBE or install ffprobe.');
}

function whichSync(cmd: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, cmd + e);
      try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Headless browser for Remotion                                       */
/* ------------------------------------------------------------------ */

export function chromePath(): string {
  const candidates = [
    process.env.BUILDTRAKE_CHROME_PATH,
    path.join(ROOT, '.browser', 'chrome'),
    whichSync('google-chrome'),
    whichSync('chromium'),
    whichSync('chrome'),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  throw new Error('No headless browser found. Run `npm run provision` first.');
}

/**
 * The self-contained browser ships its own shared libraries. They must be on
 * LD_LIBRARY_PATH before Chromium is spawned, otherwise it cannot start.
 * Must run BEFORE the first render, in the same process.
 */
export function prepareBrowserEnv() {
  const libDir = path.join(ROOT, '.browser', 'lib');
  const rootDir = path.join(ROOT, '.browser');
  if (process.platform !== 'win32' && fs.existsSync(libDir)) {
    const cur = process.env.LD_LIBRARY_PATH ?? '';
    const parts = [libDir, rootDir, cur].filter(Boolean);
    process.env.LD_LIBRARY_PATH = Array.from(new Set(parts)).join(path.delimiter);
  }
  if (process.platform === 'win32' && fs.existsSync(path.join(ROOT, '.browser'))) {
    const cur = process.env.PATH ?? '';
    process.env.PATH = `${path.join(ROOT, '.browser')};${cur}`;
  }
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function run(cmd: string, args: string[], opts: { maxBuffer?: number } = {}): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string; message: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? err.message };
  }
}

export async function runOrThrow(cmd: string, args: string[], opts: { maxBuffer?: number } = {}) {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) {
    throw new Error(`${path.basename(cmd)} failed (${r.code}):\n${r.stderr.slice(-4000)}`);
  }
  return r;
}

export async function probe(file: string) {
  const r = await runOrThrow(ffprobePath(), [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    file,
  ]);
  return JSON.parse(r.stdout) as {
    streams: Record<string, any>[];
    format: Record<string, any>;
  };
}

export function pickStream(json: any, kind: 'video' | 'audio') {
  return (json.streams ?? []).find((s: Record<string, any>) => s.codec_type === kind) ?? null;
}
