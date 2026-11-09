/**
 * Path strategy for the editor's FFmpeg boundary.
 *
 * Why this module exists (CLOSEOUT07, proven Windows defect): the editor export
 * rendered raw frames successfully, but the packaged FFmpeg could not open its
 * input because the file path was longer than the installed binaries accept. The
 * raw file really existed; only the *path to it* was unusable. The project
 * exported fine once disposable QA data was copied to a shorter root.
 *
 * The repair is a path strategy, not a storage relocation:
 *   - Canonical project ids, editor/draft revisions, the final media location and
 *     every media URL are unchanged.
 *   - Only disposable intermediate work (the Remotion raw render, the per-job
 *     audio copies) moves to a short, uniquely owned, bounded directory.
 *   - Owner files are never moved, renamed or deleted.
 *
 * The decision is pure and unit-testable; `openEditorRenderScratch` is the only
 * function that touches the filesystem.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/* ------------------------------------------------------------------ */
/* Measured path limits                                                */
/* ------------------------------------------------------------------ */

/**
 * `CreateProcess` receives the command line as UTF-16, so a Windows process
 * image can be launched with a command line beyond 32767 characters, but the
 * *environment block* and several CRT paths cap around 32767 wcharacters and
 * 260 for legacy MAX_PATH APIs. FFmpeg builds linked against legacy Win32 file
 * APIs (and most packaged static builds are) reject inputs beyond MAX_PATH.
 *
 * These are deliberately conservative: the goal is "the installed binaries can
 * certainly open this", not "the longest path that might work".
 */
/**
 * The longest path (in characters) accepted on Windows: 260 including the
 * terminating NUL. `fitsBudget` returns false only ABOVE this, so a path of
 * exactly this length is allowed.
 */
export const WINDOWS_MAX_PATH = 259;
/** POSIX PATH_MAX. One path component is additionally capped at 255 bytes. */
export const POSIX_MAX_PATH = 4095;

/** Where a given platform will put per-job render scratch. */
export interface ScratchRootChoice {
  root: string | null;
  source: 'explicit' | 'app-temp' | 'system-temp';
  /** True when the root is on the same volume as the final output (rename is atomic). */
  sameVolumeAsOutput: boolean;
  reason: string;
}

function isAbsoluteDirFor(value: unknown, platform: NodeJS.Platform): value is string {
  return typeof value === 'string' && value.length > 0 && pathFor(platform).isAbsolute(value);
}

function sameVolume(left: string, right: string, platform: NodeJS.Platform): boolean {
  const impl = pathFor(platform);
  const a = impl.parse(absoluteFor(left, platform));
  const b = impl.parse(absoluteFor(right, platform));
  if (platform === 'win32') return a.root.toLowerCase() === b.root.toLowerCase();
  return a.root === b.root;
}

/**
 * Choose the scratch root for one job.
 *
 * Precedence: an explicit `candidate` (the app's own data tree, e.g.
 * `<data>/editor-render-scratch`) when it fits, otherwise the OS temp directory,
 * which is short on every supported platform. A final output that already lives
 * somewhere short keeps its own volume so the commit can be a rename.
 */
export function chooseScratchRoot(input: {
  candidate: string | null;
  name: string;
  outputFile: string;
  platform?: NodeJS.Platform;
  tmpdir?: string;
}): ScratchRootChoice {
  const platform = input.platform ?? process.platform;
  const impl = pathFor(platform);
  const tmpdir = platform === process.platform ? (input.tmpdir ?? os.tmpdir()) : (input.tmpdir ?? '');
  const outputDir = impl.dirname(absoluteFor(input.outputFile, platform));

  const explicit = input.candidate;
  if (explicit && isAbsoluteDirFor(explicit, platform)) {
    const root = impl.join(explicit, input.name);
    if (fitsBudget(impl.join(root, 'raw-frames.mp4'), platform)) {
      return {
        root,
        source: 'explicit',
        sameVolumeAsOutput: sameVolume(root, outputDir, platform),
        reason: 'The app data root is short enough for the packaged binaries.',
      };
    }
  }
  const fallback = tmpdir ? impl.join(tmpdir, input.name) : '';
  if (!fallback || !fitsBudget(impl.join(fallback, 'raw-frames.mp4'), platform)) {
    // Every option is too long: say so instead of letting ffmpeg fail later.
    return {
      root: null,
      source: 'system-temp',
      sameVolumeAsOutput: false,
      reason: `No usable scratch root: both "${explicit ?? '(none)'}" and "${fallback}" are longer than the ${limitFor(platform)}-character limit this platform supports.`,
    };
  }
  return {
    root: fallback,
    source: 'system-temp',
    sameVolumeAsOutput: sameVolume(fallback, outputDir, platform),
    reason: explicit && explicit !== fallback
      ? 'The app data root is too long for the packaged binaries, so per-job scratch uses the short system temp directory. The final file stays where it is.'
      : 'Per-job scratch uses the short system temp directory.',
  };
}

function limitFor(platform: NodeJS.Platform): number {
  return platform === 'win32' ? WINDOWS_MAX_PATH : POSIX_MAX_PATH;
}

/**
 * The path flavour of the platform being *checked*, which is not always the
 * platform running the check (tests and diagnostics ask about win32 on Linux).
 * Using the host's `path` here measured the wrong string and hid long paths.
 */
function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** Absolute form of `candidate` under `platform`'s rules, without touching the host cwd. */
function absoluteFor(candidate: string, platform: NodeJS.Platform): string {
  const impl = pathFor(platform);
  if (impl.isAbsolute(candidate)) return impl.normalize(candidate);
  return impl.resolve(candidate);
}

/**
 * True when `candidate` is short enough for the installed binaries. Pure.
 *
 * On Windows this is the conservative MAX_PATH budget. On POSIX the whole path
 * must fit PATH_MAX and no single component may exceed 255 bytes, which is the
 * usual `ENAMETOOLONG` cause.
 */
export function fitsBudget(candidate: string, platform: NodeJS.Platform = process.platform): boolean {
  const impl = pathFor(platform);
  const absolute = absoluteFor(candidate, platform);
  if (absolute.length > limitFor(platform)) return false;
  for (const part of absolute.split(impl.sep)) {
    if (Buffer.byteLength(part, 'utf8') > 255) return false;
  }
  return true;
}

/**
 * The longest canonical project id that can still produce a usable scratch
 * directory, for diagnostics and for an early, precise refusal.
 */
export function scratchPathFor(projectId: string, jobId: string, projectDir: string): string {
  return path.join(projectDir, 'editor', 'export-work', jobId, 'raw-frames.mp4');
}

/* ------------------------------------------------------------------ */
/* Ownership, linking and cleanup                                      */
/* ------------------------------------------------------------------ */

/** Marker file name written inside every scratch directory this module creates. */
export const SCRATCH_MARKER = 'vf-render-scratch-owner.json';
export const SCRATCH_KIND = 'vf-editor-render-scratch-v1';
/** A scratch job directory is `pfx_<32 hex>` and nothing else. */
const JOB_DIR_NAME = /^(?:exp|edt)-[a-f0-9]{32}$/;

/**
 * No ancestor of `candidate` may be a symlink or junction, and the path itself
 * must be a real directory (or absent). Lexical containment alone does not
 * contain a junction, and a junction would let cleanup escape the scratch root.
 */
export function isUnlinkedPath(candidate: string): boolean {
  let current = path.resolve(candidate);
  for (;;) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
    const parent = path.dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

export interface RenderScratch {
  /** Absolute directory this job owns. Everything inside it is disposable. */
  dir: string;
  markerFile: string;
  /** True when the caller may delete the whole directory on the way out. */
  owned: boolean;
  choice: ScratchRootChoice;
}

/**
 * Create one owned scratch directory for a render job.
 *
 * Returns `null` when no safe root exists, so the caller refuses BEFORE paying
 * for a render rather than failing after minutes of work.
 */
export function openEditorRenderScratch(input: {
  name: string;
  /** Present for durable jobs; recovery must match this exact job before cleanup. */
  jobId?: string;
  outputFile: string;
  candidate: string | null;
  platform?: NodeJS.Platform;
  tmpdir?: string;
}): RenderScratch | null {
  if (!JOB_DIR_NAME.test(input.name)) {
    throw new Error('Refusing an unrecognised scratch directory name. Job names are generated, never supplied.');
  }
  const choice = chooseScratchRoot({
    candidate: input.candidate,
    name: input.name,
    outputFile: input.outputFile,
    platform: input.platform,
    tmpdir: input.tmpdir,
  });
  if (!choice.root) return null;
  const dir = choice.root;
  const parent = path.dirname(dir);
  if (!isUnlinkedPath(parent)) return null;
  fs.mkdirSync(parent, { recursive: true });
  if (!isUnlinkedPath(parent)) return null;
  fs.mkdirSync(dir, { recursive: false });
  if (!isUnlinkedPath(dir)) return null;
  const markerFile = path.join(dir, SCRATCH_MARKER);
  fs.writeFileSync(
    markerFile,
    JSON.stringify({ kind: SCRATCH_KIND, name: input.name, jobId: input.jobId, createdAt: new Date().toISOString() }),
    { flag: 'wx' },
  );
  return { dir, markerFile, owned: true, choice };
}

/**
 * Delete one owned scratch directory. Never a root, never an unowned directory,
 * never through a link. Unknown content, a malformed marker or a junction is
 * left exactly where it is.
 */
export function cleanupEditorRenderScratch(root: string | null, name: string): void {
  if (!root) return;
  if (!JOB_DIR_NAME.test(name)) return;
  const dir = path.resolve(root, name);
  if (path.dirname(dir) !== path.resolve(root)) return;
  if (!isUnlinkedPath(dir)) return;
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  const markerFile = path.join(dir, SCRATCH_MARKER);
  try {
    const markerStat = fs.lstatSync(markerFile);
    if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 512) return;
    const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8')) as { kind?: unknown; name?: unknown };
    if (!marker || marker.kind !== SCRATCH_KIND || marker.name !== name) return;
  } catch {
    return;
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/* Unique tokens                                                       */
/* ------------------------------------------------------------------ */

/** `pfx_<32 hex>`: bounded, generated, and safe as a single path component. */
export function newScratchName(prefix: 'exp' | 'edt'): string {
  return `${prefix}-${randomBytes(16).toString('hex')}`;
}

/**
 * Verify a path the binaries are about to be given. Called by the renderer right
 * before spawning ffmpeg/ffprobe, so an unsupported path is an explicit error
 * rather than an opaque binary failure.
 */
export function assertBinaryReachablePath(candidate: string, what: string, platform: NodeJS.Platform = process.platform): void {
  if (!fitsBudget(candidate, platform)) {
    throw new Error(
      `${what} path is ${path.resolve(candidate).length} characters, beyond the ${limitFor(platform)} this platform supports for the installed binaries: ${candidate}`,
    );
  }
  if (!fs.existsSync(candidate)) {
    throw new Error(`${what} does not exist: ${candidate}`);
  }
}
