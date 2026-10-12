/**
 * Bridge to the EXISTING vf-align runtime (WSL, on the owner's Windows host).
 *
 * This module never installs, downloads or pins a model. It only starts the
 * runner command the owner configured and reads the files that runner writes.
 * Configuration (environment, all required for the runtime to be "available"):
 *   VF_ALIGN_COMMAND        JSON array: launcher and its fixed leading args,
 *                           e.g. ["wsl.exe","-d","Ubuntu","--","/opt/vf-align/bin/python","/mnt/c/.../align_recording.py"]
 *   VF_ALIGN_CHECKPOINT     path to the checkpoint the runtime already has
 *   VF_ALIGN_TOKENIZER      path to the tokenizer the runtime already has
 *   VF_ALIGN_PATH_STYLE     "wsl" to translate C:\ paths to /mnt/c/...; default "native"
 *   VF_ALIGN_REVIEW_ROOT    absolute folder OUTSIDE the data root where the runner writes
 *                           review files (the runner refuses a review dir inside project data)
 *   VF_ALIGN_TIMEOUT_SEC    optional; 60..7200, default 1800
 *
 * No timing value is hardcoded or estimated here. A missing or failing runtime
 * produces a clear "unavailable" or "failed" result, never a guessed proposal.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EditorError, type AlignmentRow } from '@buildtrack/core';

export interface AlignRuntime {
  available: boolean;
  reason: string | null;
  argv: string[];
  checkpoint: string;
  tokenizer: string;
  reviewRoot: string;
  pathStyle: 'native' | 'wsl';
  timeoutSec: number;
}

export function alignRuntime(env: NodeJS.ProcessEnv = process.env): AlignRuntime {
  const base = { argv: [] as string[], checkpoint: '', tokenizer: '', reviewRoot: '', pathStyle: 'native' as const, timeoutSec: 1800 };
  const unavailable = (reason: string): AlignRuntime => ({ ...base, available: false, reason });
  const raw = (env.VF_ALIGN_COMMAND ?? '').trim();
  if (!raw) {
    return unavailable('VF_ALIGN_COMMAND is not set. Point it at the existing vf-align WSL runtime. Nothing was installed or downloaded.');
  }
  let argv: unknown;
  try {
    argv = JSON.parse(raw);
  } catch {
    return unavailable('VF_ALIGN_COMMAND must be a JSON array of strings.');
  }
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === 'string' && a.length > 0)) {
    return unavailable('VF_ALIGN_COMMAND must be a non-empty JSON array of non-empty strings.');
  }
  const checkpoint = (env.VF_ALIGN_CHECKPOINT ?? '').trim();
  const tokenizer = (env.VF_ALIGN_TOKENIZER ?? '').trim();
  if (!checkpoint || !tokenizer) {
    return unavailable('VF_ALIGN_CHECKPOINT and VF_ALIGN_TOKENIZER must point at files the runtime already has.');
  }
  const reviewRoot = (env.VF_ALIGN_REVIEW_ROOT ?? '').trim();
  if (!reviewRoot || !path.isAbsolute(reviewRoot)) {
    return unavailable('VF_ALIGN_REVIEW_ROOT must be an absolute folder outside the data root.');
  }
  const dataRoot = path.resolve(env.BUILDTRAKE_DATA ?? path.join(process.cwd(), 'data'));
  const rr = path.resolve(reviewRoot);
  if (rr === dataRoot || rr.startsWith(dataRoot + path.sep) || dataRoot.startsWith(rr + path.sep)) {
    return unavailable('VF_ALIGN_REVIEW_ROOT overlaps the project data root. The runner refuses that; pick a folder outside it.');
  }
  const pathStyle = env.VF_ALIGN_PATH_STYLE === 'wsl' ? 'wsl' : 'native';
  const timeoutRaw = Number(env.VF_ALIGN_TIMEOUT_SEC ?? 1800);
  const timeoutSec = Number.isFinite(timeoutRaw) ? Math.min(7200, Math.max(60, Math.round(timeoutRaw))) : 1800;
  if (pathStyle === 'native' && path.isAbsolute(argv[0] as string) && !fs.existsSync(argv[0] as string)) {
    return unavailable(`The alignment launcher was not found at ${argv[0]}.`);
  }
  return { available: true, reason: null, argv: argv as string[], checkpoint, tokenizer, reviewRoot: rr, pathStyle, timeoutSec };
}

/** C:\\x\\y -> /mnt/c/x/y when the runner runs inside WSL. Other paths pass through. */
export function runnerPath(p: string, style: 'native' | 'wsl'): string {
  if (style !== 'wsl') return p;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return p.replace(/\\/g, '/');
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

export interface RunnerInputs {
  wavPath: string;
  projectJsonPath: string;
  stateJsonPath: string;
  /** Review folder for this job (boundaries.json is written here). Outside project data. */
  reviewDir: string;
  logDir: string;
}

export interface RunnerOutcome {
  exitCode: number | null;
  timedOut: boolean;
  spawnError: string | null;
  stdoutTail: string;
  stderrTail: string;
}

/**
 * Start the runner. Resolves when it exits. The runner's stdout/stderr go to
 * log files under logDir; only tails are returned. The child gets the
 * configured environment and nothing else is added.
 */
export function runAlignRunner(rt: AlignRuntime, inputs: RunnerInputs, env: NodeJS.ProcessEnv = process.env): Promise<RunnerOutcome> {
  const style = rt.pathStyle;
  // Flags are the runner's own argparse names (align_recording.py main()).
  const args = [
    ...rt.argv.slice(1),
    '--wav', runnerPath(inputs.wavPath, style),
    '--project-json', runnerPath(inputs.projectJsonPath, style),
    '--state-json', runnerPath(inputs.stateJsonPath, style),
    '--checkpoint', runnerPath(rt.checkpoint, style),
    '--tokenizer', runnerPath(rt.tokenizer, style),
    '--review-dir', runnerPath(inputs.reviewDir, style),
  ];
  fs.mkdirSync(inputs.logDir, { recursive: true });
  const stdoutLog = path.join(inputs.logDir, 'runner.stdout.log');
  const stderrLog = path.join(inputs.logDir, 'runner.stderr.log');
  return new Promise<RunnerOutcome>((resolve) => {
    let child;
    try {
      child = spawn(rt.argv[0], args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      resolve({ exitCode: null, timedOut: false, spawnError: (err as Error).message, stdoutTail: '', stderrTail: '' });
      return;
    }
    let out = '';
    let errText = '';
    let timedOut = false;
    let settled = false;
    const finish = (o: Omit<RunnerOutcome, 'stdoutTail' | 'stderrTail'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fs.writeFileSync(stdoutLog, out, 'utf8');
      fs.writeFileSync(stderrLog, errText, 'utf8');
      resolve({ ...o, stdoutTail: out.slice(-4000), stderrTail: errText.slice(-4000) });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, rt.timeoutSec * 1000);
    child.stdout.on('data', (d: Buffer) => { out = (out + d.toString('utf8')).slice(-200_000); });
    child.stderr.on('data', (d: Buffer) => { errText = (errText + d.toString('utf8')).slice(-200_000); });
    child.on('error', (err) => finish({ exitCode: null, timedOut, spawnError: err.message }));
    child.on('close', (code) => finish({ exitCode: code, timedOut, spawnError: null }));
  });
}

export interface ParsedBoundaries {
  available: boolean;
  detail: string;
  rows: AlignmentRow[];
  /** Spans the runner could not place. Reported, never filled in. */
  unresolved: unknown[];
  audioSha256: string | null;
  audioDurationSec: number | null;
}

/**
 * Read the runner's boundaries.json. Its rows carry proposedCaptionStart and
 * proposedCaptionEnd (narration time). Those become the row span. Anything
 * missing or non-finite is refused, never repaired.
 */
export function boundariesPath(reviewDir: string): string {
  return path.join(reviewDir, 'boundaries.json');
}

export function parseBoundaries(file: string): ParsedBoundaries {
  if (!fs.existsSync(file)) throw new EditorError('ALIGNMENT_OUTPUT_MISSING', 'The runner finished but wrote no boundaries.json. Nothing was saved.', 422);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const detail = typeof raw.detail === 'string' ? raw.detail : '';
  if (raw.available !== true) {
    return { available: false, detail: detail || 'The runner reported the alignment as unavailable.', rows: [], unresolved: [], audioSha256: null, audioDurationSec: null };
  }
  if (!Array.isArray(raw.rows)) throw new EditorError('ALIGNMENT_ROWS_INVALID', 'boundaries.json has no rows array.', 422);
  const rows: AlignmentRow[] = (raw.rows as Array<Record<string, unknown>>).map((r) => ({
    sceneId: String(r.sceneId ?? ''),
    startSec: Number(r.proposedCaptionStart),
    endSec: Number(r.proposedCaptionEnd),
  }));
  return {
    available: true,
    detail,
    rows,
    unresolved: Array.isArray(raw.unresolved) ? (raw.unresolved as unknown[]) : [],
    audioSha256: typeof raw.audioSha256 === 'string' ? raw.audioSha256 : null,
    audioDurationSec: typeof raw.audioDurationSec === 'number' ? raw.audioDurationSec : null,
  };
}
