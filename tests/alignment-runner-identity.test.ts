/**
 * The alignment runner's WAV identity comes from the job, not from constants in
 * the script. These tests import the runner's identity functions with the
 * system Python (standard library only; no model, no numpy) and check each gate.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const RUNNER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'alignment-run');
const PYTHON = process.env.VF_ALIGN_TEST_PYTHON ?? 'python3';
const hasPython = spawnSync(PYTHON, ['--version']).status === 0;

function wav(rate: number, seconds: number, fill = 0): Buffer {
  const data = Buffer.alloc(Math.round(seconds * rate) * 2, fill);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const PY = `
import sys, json
sys.path.insert(0, sys.argv[1])
import align_recording as ar
from pathlib import Path
wav = Path(sys.argv[2])
exp = Path(sys.argv[3]) if sys.argv[3] != '-' else None
try:
    identity = ar.load_expected_identity(exp)
    facts = ar.assert_project_wav(wav, identity)
    print(json.dumps({"ok": True, "sha256": facts["sha256"], "durationSec": facts["durationSec"]}))
except SystemExit as err:
    print(json.dumps({"ok": False, "blocker": str(err.code)}))
`;

describe.skipIf(!hasPython)('alignment runner: job-specific WAV identity', () => {
  let dir: string;
  let good: Buffer;
  let goodSha: string;

  const runCheck = (wavFile: string, expectedFile: string | null) => {
    const out = execFileSync(PYTHON, ['-c', PY, RUNNER_DIR, wavFile, expectedFile ?? '-'], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    return JSON.parse(out.trim().split('\n').pop() ?? '{}') as { ok: boolean; blocker?: string; sha256?: string; durationSec?: number };
  };
  const writeExpected = (name: string, value: Record<string, unknown>) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(value), 'utf8');
    return file;
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-align-identity-'));
    good = wav(24000, 2, 3);
    goodSha = crypto.createHash('sha256').update(good).digest('hex');
    fs.writeFileSync(path.join(dir, 'owner.wav'), good);
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('has no hardcoded recording identity left in the runner', () => {
    const source = fs.readFileSync(path.join(RUNNER_DIR, 'align_recording.py'), 'utf8');
    expect(source).not.toMatch(/EXPECTED_SHA|EXPECTED_BYTES|EXPECTED_DURATION/);
    expect(source).not.toContain('dc8e6f2422be7777');
    expect(source).toContain('--expected-audio-json');
  });

  it('extracts a contextual separator when isolated whitespace is stripped, and refuses inconsistent context', () => {
    const script = `import sys, json
sys.path.insert(0, sys.argv[1])
import align_recording as ar
good = {' ': [], 'ا': [10], 'ب': [20], 'ا ب': [10, 7, 20]}
bad = {**good, 'ا ب': [99, 7, 20]}
direct = {**good, ' ': [7]}
print(json.dumps([ar.separator_ids(lambda text: d[text], set()) for d in [good, bad, direct]]))`;
    const out = execFileSync(PYTHON, ['-c', script, RUNNER_DIR], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    expect(JSON.parse(out.trim())).toEqual([[7], [], [7]]);
  });

  it('refuses when the job expected-audio file is missing', () => {
    const out = runCheck(path.join(dir, 'owner.wav'), null);
    expect(out.ok).toBe(false);
    expect(out.blocker).toBe('BLOCKER=expected_audio_identity_missing');
  });

  it('refuses a malformed expected-audio file', () => {
    const file = writeExpected('bad.json', { sha256: 'nope', bytes: 'x', durationSec: 2 });
    const out = runCheck(path.join(dir, 'owner.wav'), file);
    expect(out.blocker).toBe('BLOCKER=expected_audio_identity_invalid');
  });

  it('accepts the WAV that the job names, and reports its facts', () => {
    const file = writeExpected('ok.json', { sha256: goodSha, bytes: good.length, durationSec: 2 });
    const out = runCheck(path.join(dir, 'owner.wav'), file);
    expect(out.ok).toBe(true);
    expect(out.sha256).toBe(goodSha);
    expect(out.durationSec).toBe(2);
  });

  it('refuses a different sha, and a different byte size', () => {
    const wrongSha = writeExpected('sha.json', { sha256: 'a'.repeat(64), bytes: good.length, durationSec: 2 });
    expect(runCheck(path.join(dir, 'owner.wav'), wrongSha).blocker).toMatch(/^BLOCKER=wav_identity/);
    const wrongBytes = writeExpected('bytes.json', { sha256: goodSha, bytes: good.length + 1, durationSec: 2 });
    expect(runCheck(path.join(dir, 'owner.wav'), wrongBytes).blocker).toMatch(/^BLOCKER=wav_identity/);
  });

  it('refuses a duration that does not match the expected duration', () => {
    const file = writeExpected('dur.json', { sha256: goodSha, bytes: good.length, durationSec: 58.84 });
    expect(runCheck(path.join(dir, 'owner.wav'), file).blocker).toMatch(/^BLOCKER=wav_duration/);
  });

  it('still requires the 24 kHz mono 16-bit PCM input format', () => {
    const sixteen = wav(16000, 2, 3);
    fs.writeFileSync(path.join(dir, 'rate16.wav'), sixteen);
    const sha = crypto.createHash('sha256').update(sixteen).digest('hex');
    const file = writeExpected('rate16.json', { sha256: sha, bytes: sixteen.length, durationSec: 2 });
    expect(runCheck(path.join(dir, 'rate16.wav'), file).blocker).toMatch(/^BLOCKER=wav_format/);
  });
});
