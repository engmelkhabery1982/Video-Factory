/**
 * Resolve ffprobe the same way the application does, without importing the
 * API platform module. That import freezes data and output paths at load time.
 * This module does not provision, download, or print a private path.
 *
 * Order: BUILDTRAKE_FFPROBE, then the older BUILDTRACK_FFPROBE name, then PATH,
 * then the bundled ffprobe-static executable. A configured path that is missing
 * is a failure, not a silent fallback.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

export type FfprobeSource = 'BUILDTRAKE_FFPROBE' | 'BUILDTRACK_FFPROBE' | 'PATH' | 'bundled' | 'missing';

export interface FfprobeResolution {
  executable: string | null;
  source: FfprobeSource;
  problem: string | null;
}

export interface FfprobeLookup {
  env: NodeJS.ProcessEnv;
  exists: (file: string) => boolean;
  which: (command: string) => string | null;
  bundled: () => string | null;
}

const CONFIGURED_MISSING = 'The configured ffprobe executable is missing or not usable. Set BUILDTRAKE_FFPROBE to an ffprobe binary, or unset it to use PATH or the bundled executable.';
const NOT_FOUND = 'ffprobe was not found. Set BUILDTRAKE_FFPROBE to the ffprobe executable, or install ffprobe on PATH. A duration was not guessed.';

export function resolveFfprobeExecutable(lookup: FfprobeLookup): FfprobeResolution {
  const configured = lookup.env.BUILDTRAKE_FFPROBE;
  if (configured) {
    if (lookup.exists(configured)) {
      return { executable: configured, source: 'BUILDTRAKE_FFPROBE', problem: null };
    }
    return { executable: null, source: 'missing', problem: CONFIGURED_MISSING };
  }
  const legacy = lookup.env.BUILDTRACK_FFPROBE;
  if (legacy) {
    if (lookup.exists(legacy)) {
      return { executable: configured ?? legacy, source: 'BUILDTRACK_FFPROBE', problem: null };
    }
    return { executable: null, source: 'missing', problem: CONFIGURED_MISSING };
  }
  const onPath = lookup.which('ffprobe');
  if (onPath) return { executable: onPath, source: 'PATH', problem: null };
  const bundled = lookup.bundled();
  if (bundled && lookup.exists(bundled)) return { executable: bundled, source: 'bundled', problem: null };
  return { executable: null, source: 'missing', problem: NOT_FOUND };
}

export function whichOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = (env.PATH ?? '').split(path.delimiter);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* ignore unreadable PATH entries */
      }
    }
  }
  return null;
}

/** Bundled executable from ffprobe-static. Loaded only when PATH has none. */
export function bundledFfprobePath(): string | null {
  try {
    const mod = require('ffprobe-static') as { path?: string };
    return typeof mod?.path === 'string' && mod.path ? mod.path : null;
  } catch {
    return null;
  }
}

export function resolveAppFfprobe(env: NodeJS.ProcessEnv = process.env): FfprobeResolution {
  return resolveFfprobeExecutable({
    env,
    exists: (file) => {
      try { return fs.existsSync(file); } catch { return false; }
    },
    which: (command) => whichOnPath(command, env),
    bundled: bundledFfprobePath,
  });
}

/** A probe that failed, or printed a non-duration, is not a duration. */
export function parseProbeDuration(stdout: string): number | null {
  const value = Number(String(stdout ?? '').trim());
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}
