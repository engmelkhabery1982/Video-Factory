/**
 * Transcript provenance guard for the alignment runner output (parseBoundaries).
 * A transcript is compared only with accepted provenance. Fixture transcripts are
 * labelled and accepted only under VF_ALLOW_FIXTURE_TRANSCRIPT=1 (tests only).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceptTranscript, parseBoundaries } from '../apps/api/src/services/vf-align-worker.js';

const AUDIO = 'a'.repeat(64);
const EMIT = 'b'.repeat(64);
const rows = [{ sceneId: 's1', proposedCaptionStart: 0, proposedCaptionEnd: 1.5 }];

function greedyProv(over: Record<string, unknown> = {}) {
  return {
    method: 'greedy_ctc', source: 'frame_emissions', independentOfScript: true, scriptCopied: false,
    audioSha256: AUDIO, emissionsSha256: EMIT, frames: 10, blankId: 0, tokenizerBytes: 1, decoder: 'x', fixture: false,
    ...over,
  };
}

function base(over: Record<string, unknown> = {}) {
  return { available: true, detail: 'd', audioSha256: AUDIO, audioDurationSec: 2, rows, unresolved: [], ...over };
}

let dir = '';
function writeBoundaries(obj: unknown): string {
  const file = path.join(dir, 'boundaries.json');
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}

describe('transcript provenance guard', () => {
  let prevAllow: string | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-transcript-'));
    prevAllow = process.env.VF_ALLOW_FIXTURE_TRANSCRIPT;
    delete process.env.VF_ALLOW_FIXTURE_TRANSCRIPT;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (prevAllow === undefined) delete process.env.VF_ALLOW_FIXTURE_TRANSCRIPT;
    else process.env.VF_ALLOW_FIXTURE_TRANSCRIPT = prevAllow;
  });

  it('accepts an independent greedy CTC transcript with matching audio and emissions', () => {
    const parsed = parseBoundaries(writeBoundaries(base({ transcript: 'hello there', transcriptProvenance: greedyProv() })));
    expect(parsed.transcript).toBe('hello there');
    expect(parsed.transcriptRejected).toBeNull();
    expect(parsed.transcriptProvenance).toEqual({ method: 'greedy_ctc', fixture: false, audioSha256: AUDIO, emissionsSha256: EMIT });
  });

  it('refuses a transcript with no provenance and says why', () => {
    const parsed = parseBoundaries(writeBoundaries(base({ transcript: 'hello there' })));
    expect(parsed.transcript).toBeNull();
    expect(parsed.transcriptProvenance).toBeNull();
    expect(parsed.transcriptRejected).toMatch(/no provenance/);
  });

  it('refuses a transcript copied from the script', () => {
    const parsed = parseBoundaries(writeBoundaries(base({ transcript: 'hello', transcriptProvenance: greedyProv({ scriptCopied: true }) })));
    expect(parsed.transcript).toBeNull();
    expect(parsed.transcriptRejected).toMatch(/not an independent decode/);
  });

  it('refuses a transcript that is not marked independent of the script', () => {
    const parsed = parseBoundaries(writeBoundaries(base({ transcript: 'hello', transcriptProvenance: greedyProv({ independentOfScript: false }) })));
    expect(parsed.transcript).toBeNull();
  });

  it('refuses a greedy transcript that names no emissions', () => {
    const parsed = parseBoundaries(writeBoundaries(base({ transcript: 'hello', transcriptProvenance: greedyProv({ emissionsSha256: '' }) })));
    expect(parsed.transcript).toBeNull();
    expect(parsed.transcriptRejected).toMatch(/names no emissions/);
  });

  it('refuses a transcript whose provenance names other audio', () => {
    const parsed = parseBoundaries(writeBoundaries(base({ transcript: 'hello', transcriptProvenance: greedyProv({ audioSha256: 'c'.repeat(64) }) })));
    expect(parsed.transcript).toBeNull();
    expect(parsed.transcriptRejected).toMatch(/other audio/);
  });

  it('refuses an unknown method', () => {
    const parsed = parseBoundaries(writeBoundaries(base({ transcript: 'hello', transcriptProvenance: greedyProv({ method: 'copy' }) })));
    expect(parsed.transcript).toBeNull();
  });

  it('refuses a fixture transcript unless the test-only switch is set', () => {
    const fixture = { method: 'fixture_stand_in', fixture: true, audioSha256: AUDIO, source: 'fixture' };
    const refused = parseBoundaries(writeBoundaries(base({ transcript: 'hello', transcriptProvenance: fixture })));
    expect(refused.transcript).toBeNull();
    process.env.VF_ALLOW_FIXTURE_TRANSCRIPT = '1';
    const accepted = parseBoundaries(writeBoundaries(base({ transcript: 'hello', transcriptProvenance: fixture })));
    expect(accepted.transcript).toBe('hello');
    expect(accepted.transcriptProvenance?.fixture).toBe(true);
  });

  it('surfaces an unavailable decoder as not compared, never as a copied script', () => {
    const parsed = parseBoundaries(writeBoundaries(base({ transcript: null, transcriptUnavailable: 'The character decoder is unavailable.' })));
    expect(parsed.transcript).toBeNull();
    expect(parsed.transcriptRejected).toMatch(/decoder is unavailable/);
  });

  it('acceptTranscript refuses a non-text transcript', () => {
    expect(acceptTranscript({ transcript: 42 }).rejected).toMatch(/not text/);
  });

  it('greedy CTC decoder unit tests pass (stdlib python)', () => {
    const out = execFileSync('python3', ['-m', 'unittest', 'test_ctc_greedy'], {
      cwd: path.resolve(__dirname, '../tools/alignment-run'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    expect(out).toBe('');
  });
});
