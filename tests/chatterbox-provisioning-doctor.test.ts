/**
 * VS2 FOCUSED TESTS — explicit provisioning, doctor reporting and download safety.
 *
 * These tests prove the operational contract of the voice-clone feature:
 *
 *   - `npm run provision:voice-clone` (check mode, the DEFAULT) reports OS,
 *     Python 3.11, isolated-env status, disk space, GPU/CUDA and the expected
 *     locations, and performs ZERO downloads / ZERO writes;
 *   - arbitrary engine names fail with a non-zero exit instead of guessing;
 *   - `npm install` / `npm test` / `npm run build` / `npm start` are not wired
 *     to provisioning (no install/prepare/postinstall hook);
 *   - doctor reports Chatterbox as an optional capability while unselected and
 *     as blocking checks once selected, without ever downloading a model;
 *   - the pinned requirement metadata and the worker's offline-only behaviour
 *     match the verified upstream facts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from './helpers/chatterbox-worker-fixtures.js';

const PROVISION = path.join(REPO_ROOT, 'tools/provision-chatterbox.mjs');
const DOCTOR = path.join(REPO_ROOT, 'tools/doctor.mjs');
const CHATTERBOX_DIR_ABS = path.join(REPO_ROOT, '.chatterbox');

function runNode(script: string, args: string[] = []): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { code: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

describe('VS2 provisioning — check mode is informative and side-effect free', () => {
  it('reports the environment and performs no download or write (--check --json)', () => {
    expect(fs.existsSync(CHATTERBOX_DIR_ABS)).toBe(false);
    const result = runNode(PROVISION, ['--check', '--json']);
    expect(result.code).toBe(0);

    const report = JSON.parse(result.stdout) as {
      mode: string;
      engineContractId: string;
      modelId: string;
      checks: Record<string, { ok: boolean; detail: string }>;
      actions: unknown[];
      downloadsPerformed: number;
      markerWritten: boolean;
      locations: Record<string, string>;
    };
    expect(report.mode).toBe('check');
    expect(report.engineContractId).toBe('chatterbox-multilingual-v3');
    expect(report.modelId).toBe('ResembleAI/chatterbox');
    expect(report.actions).toEqual([]);
    expect(report.downloadsPerformed).toBe(0);
    expect(report.markerWritten).toBe(false);
    expect(report.checks['engine-contract'].ok).toBe(true);
    expect(report.checks.os.ok).toBe(true);
    expect(report.checks['python-3.11'].ok).toBe(true);
    expect(report.checks['python-3.11'].detail).toContain('3.11');
    expect(report.checks['isolated-env'].ok).toBe(false);
    expect(report.checks['provision-marker'].ok).toBe(false);
    expect(report.locations.modelCache).toBe('.chatterbox/models');
    expect(report.locations.marker).toBe('.chatterbox/provisioned.json');
    expect(report.locations.requirements).toBe('tools/chatterbox/requirements.txt');

    /* Nothing may be created by a check: no env, no cache, no marker. */
    expect(fs.existsSync(CHATTERBOX_DIR_ABS)).toBe(false);
  });

  it('defaults to check mode even without flags (never provisions implicitly)', () => {
    const result = runNode(PROVISION, []);
    expect(result.code).toBe(0);
    expect(stripAnsi(result.stdout)).toContain('Nothing was downloaded and nothing was written');
    expect(fs.existsSync(CHATTERBOX_DIR_ABS)).toBe(false);
  });

  it('fails with a non-zero exit for an unknown engine instead of pretending', () => {
    const result = runNode(PROVISION, ['--check', '--json', '--engine=chatterbox-imaginary']);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('unknown --engine');
    expect(fs.existsSync(CHATTERBOX_DIR_ABS)).toBe(false);
  });

  it('reports the turbo contract and its model repository when asked', () => {
    const result = runNode(PROVISION, ['--check', '--json', '--engine=chatterbox-turbo']);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as { engineContractId: string; modelId: string };
    expect(report.engineContractId).toBe('chatterbox-turbo');
    expect(report.modelId).toBe('ResembleAI/chatterbox-turbo');
  });

  it('pins the verified upstream versions in the worker requirements', () => {
    const requirements = fs.readFileSync(path.join(REPO_ROOT, 'tools/chatterbox/requirements.txt'), 'utf8');
    for (const pin of [
      'chatterbox-tts==0.1.7',
      'torch==2.6.0',
      'torchaudio==2.6.0',
      'transformers==5.2.0',
      'resemble-perth>=1.0.0',
    ]) {
      expect(requirements).toContain(pin);
    }
  });

  it('keeps the real worker offline-only (no snapshot download at synthesis time)', () => {
    const worker = fs.readFileSync(path.join(REPO_ROOT, 'tools/chatterbox/worker.py'), 'utf8');
    expect(worker).not.toContain('snapshot_download');
    expect(worker).not.toContain('from huggingface_hub');
    expect(worker).toContain('requireWatermark');
    /* The worker must parse as valid Python 3.11 (ast only: no bytecode files). */
    const parse = spawnSync(
      'python3.11',
      ['-c', "import ast,sys;ast.parse(open(sys.argv[1],encoding='utf8').read())", 'tools/chatterbox/worker.py'],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    );
    expect(parse.status).toBe(0);
    expect(fs.existsSync(path.join(REPO_ROOT, 'tools/chatterbox/__pycache__'))).toBe(false);
  });
});

describe('VS2 provisioning is never wired into install, test, build or start', () => {
  it('exposes exactly one explicit provisioning script and no automatic hook', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['provision:voice-clone']).toBe('node tools/provision-chatterbox.mjs');
    for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublishOnly']) {
      expect(pkg.scripts[hook] ?? '').not.toContain('chatterbox');
    }
    for (const script of ['test', 'build', 'start', 'build:core', 'build:web']) {
      expect(pkg.scripts[script] ?? '').not.toMatch(/chatterbox|provision:voice-clone/i);
    }
    for (const [name, command] of Object.entries(pkg.scripts)) {
      if (name === 'provision:voice-clone') continue;
      expect(command).not.toContain('provision-chatterbox');
    }
  });

  it('ignores provisioned environments, models, scratch and reference recordings in Git', () => {
    const gitignore = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
    expect(gitignore).toMatch(/^\.chatterbox\/$/m);
    expect(gitignore).toMatch(/^\.voice-references\/$/m);
  });
});

describe('VS2 doctor — optional while unselected, blocking once selected, never downloads', () => {
  it('reports Chatterbox as optional and does not fail Kokoro-era requirements', () => {
    expect(fs.existsSync(CHATTERBOX_DIR_ABS)).toBe(false);
    const result = runNode(DOCTOR, []);
    const output = stripAnsi(result.stdout);
    expect(output).toContain('Chatterbox voice cloning');
    expect(output).toContain('Chatterbox status');
    expect(output).toContain('optional: not selected');
    expect(output).not.toMatch(/\[FAIL\] Chatterbox/);
    expect(fs.existsSync(CHATTERBOX_DIR_ABS)).toBe(false);
  });

  it('turns the missing capabilities into blocking failures when Chatterbox is selected', () => {
    const result = runNode(DOCTOR, ['--require-chatterbox']);
    const output = stripAnsi(result.stdout);
    expect(result.code).not.toBe(0);
    expect(output).toContain('Chatterbox selected');
    expect(output).toMatch(/\[FAIL\] Chatterbox provisioning marker/);
    expect(output).toMatch(/\[FAIL\] Chatterbox isolated env/);
    expect(output).toMatch(/\[FAIL\] Chatterbox reference voices/);
    /* Doctor reports; it never provisions, downloads or creates the directory. */
    expect(fs.existsSync(CHATTERBOX_DIR_ABS)).toBe(false);
  });
});
