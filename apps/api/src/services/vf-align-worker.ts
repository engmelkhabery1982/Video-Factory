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
  /** Job file with the expected sha256, byte size and duration of the narration import. */
  expectedAudioJsonPath: string;
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
    '--expected-audio-json', runnerPath(inputs.expectedAudioJsonPath, style),
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
  /**
   * Independent transcript of the narration, when the runner produced one. Null
   * when it did not (the current runner performs forced alignment only). Null
   * means verification is unavailable, never that the text was spoken.
   */
  transcript: string | null;
  /** Provenance of the transcript that was accepted. Null when no transcript was accepted. */
  transcriptProvenance: TranscriptProvenanceSummary | null;
  /** Why a transcript present in the file was refused. Null when none was refused. */
  transcriptRejected: string | null;
}

export interface TranscriptProvenanceSummary {
  method: 'greedy_ctc' | 'fixture_stand_in';
  fixture: boolean;
  audioSha256: string;
  emissionsSha256: string | null;
}

/**
 * A transcript is compared only when the runner says where it came from: greedy CTC
 * over the frame emissions of this exact audio, never copied from the script. A
 * fixture transcript counts only when VF_ALLOW_FIXTURE_TRANSCRIPT=1 (tests only), and
 * it is then labelled fixture. Anything else is refused and reported.
 */
export function acceptTranscript(raw: Record<string, unknown>): { transcript: string | null; provenance: TranscriptProvenanceSummary | null; rejected: string | null } {
  if (raw.transcript === undefined || raw.transcript === null) {
    const why = typeof raw.transcriptUnavailable === 'string' ? raw.transcriptUnavailable : null;
    return { transcript: null, provenance: null, rejected: why };
  }
  if (typeof raw.transcript !== 'string') return { transcript: null, provenance: null, rejected: 'The transcript is not text, so it was not compared.' };
  const p = (raw.transcriptProvenance ?? null) as Record<string, unknown> | null;
  const refuse = (why: string) => ({ transcript: null, provenance: null, rejected: `${why} The transcript was not compared.` });
  if (!p || typeof p !== 'object') return refuse('The transcript has no provenance.');
  if (typeof raw.audioSha256 !== 'string' || p.audioSha256 !== raw.audioSha256) return refuse('The transcript provenance names other audio.');
  if (p.method === 'greedy_ctc') {
    if (p.source !== 'frame_emissions' || p.independentOfScript !== true || p.scriptCopied !== false || p.fixture === true) {
      return refuse('The transcript is not an independent decode of the frame emissions.');
    }
    if (typeof p.emissionsSha256 !== 'string' || p.emissionsSha256.length === 0) return refuse('The transcript names no emissions.');
    return { transcript: raw.transcript, provenance: { method: 'greedy_ctc', fixture: false, audioSha256: raw.audioSha256, emissionsSha256: p.emissionsSha256 }, rejected: null };
  }
  if (p.method === 'fixture_stand_in' && p.fixture === true && process.env.VF_ALLOW_FIXTURE_TRANSCRIPT === '1') {
    return { transcript: raw.transcript, provenance: { method: 'fixture_stand_in', fixture: true, audioSha256: raw.audioSha256, emissionsSha256: null }, rejected: null };
  }
  return refuse('The transcript method is not accepted here.');
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
    return { available: false, detail: detail || 'The runner reported the alignment as unavailable.', rows: [], unresolved: [], audioSha256: null, audioDurationSec: null, transcript: null, transcriptProvenance: null, transcriptRejected: null };
  }
  if (!Array.isArray(raw.rows)) throw new EditorError('ALIGNMENT_ROWS_INVALID', 'boundaries.json has no rows array.', 422);
  const rows: AlignmentRow[] = (raw.rows as Array<Record<string, unknown>>).map((r) => ({
    sceneId: String(r.sceneId ?? ''),
    startSec: Number(r.proposedCaptionStart),
    endSec: Number(r.proposedCaptionEnd),
  }));
  const accepted = acceptTranscript(raw);
  return {
    available: true,
    detail,
    rows,
    unresolved: Array.isArray(raw.unresolved) ? (raw.unresolved as unknown[]) : [],
    audioSha256: typeof raw.audioSha256 === 'string' ? raw.audioSha256 : null,
    audioDurationSec: typeof raw.audioDurationSec === 'number' ? raw.audioDurationSec : null,
    transcript: accepted.transcript,
    transcriptProvenance: accepted.provenance,
    transcriptRejected: accepted.rejected,
  };
}
