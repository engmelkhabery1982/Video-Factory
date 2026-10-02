/**
 * REGRESSION — Retry 8 (acceptance run 37017285040) failed inside the preflight
 * job's "Stage the real production audio for the artifact" step:
 *
 *   find .stills/final-acceptance/audio-artifact -name '*.wav' | head -5
 *
 * under `set -euo pipefail`. `head` closes the pipe after five lines, GNU find
 * exits non-zero on the resulting EPIPE ("find: 'standard output': Broken
 * pipe" / "write error"), and pipefail turns that into exit code 1 — the audio
 * had already been copied successfully, but the step failed and the preflight
 * state upload (and every gated job) was skipped.
 *
 * The step's real `run:` block is extracted from the workflow and executed in a
 * throwaway sandbox containing more than five WAV files, so this is a
 * behavioural guard: it fails on the old command form and passes on any form
 * that consumes the full find output. No product render, no TTS, no network.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');
const ACCEPTANCE_WORKFLOW = path.join(WORKFLOWS_DIR, 'final-product-acceptance.yml');
const STAGING_STEP = 'Stage the real production audio for the artifact';
const ARTIFACT_ROOT = path.join('.stills', 'final-acceptance', 'audio-artifact');

/** The `run:` block (dedented) of one workflow step, without a YAML dependency. */
function extractRunBlock(workflow: string, stepName: string): string {
  const lines = workflow.split('\n');
  const nameIndex = lines.findIndex(
    (line) => line.trim() === `- name: ${stepName}` || line.trim() === `- name: '${stepName}'`,
  );
  if (nameIndex === -1) throw new Error(`step not found in workflow: ${stepName}`);

  let runIndex = -1;
  for (let i = nameIndex + 1; i < lines.length; i += 1) {
    if (/^\s*- name:/.test(lines[i])) break;
    if (/^\s*run:\s*\|-?\s*$/.test(lines[i])) {
      runIndex = i;
      break;
    }
  }
  if (runIndex === -1) throw new Error(`run block not found for step: ${stepName}`);

  const body: string[] = [];
  for (let i = runIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') {
      body.push('');
      continue;
    }
    const indent = (line.match(/^\s*/) as RegExpMatchArray)[0].length;
    const runIndent = (lines[runIndex].match(/^\s*/) as RegExpMatchArray)[0].length;
    if (indent <= runIndent) break;
    body.push(line);
  }
  while (body.length > 0 && body[body.length - 1].trim() === '') body.pop();
  const blockIndent = (body[0].match(/^\s*/) as RegExpMatchArray)[0].length;
  return body.map((line) => line.slice(blockIndent)).join('\n');
}

const sandboxes: string[] = [];

/** A throwaway repo-shaped sandbox with `count` real (empty) WAV files. */
function makeSandbox(count: number): string {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-staging-'));
  sandboxes.push(sandbox);
  const audioRoot = path.join(sandbox, '.production', 'FinalAcceptance_RFI_Backlog', 'audio', 'dialogue');
  fs.mkdirSync(path.join(audioRoot, 'scenario-long-01'), { recursive: true });
  for (let i = 0; i < count; i += 1) {
    fs.writeFileSync(
      path.join(audioRoot, 'scenario-long-01', `scenario-long-01-turn-${String(i).padStart(2, '0')}.wav`),
      'RIFF____WAVEfmt ',
    );
  }
  return sandbox;
}

function countWavs(root: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.wav')) total += 1;
    }
  };
  if (fs.existsSync(root)) walk(root);
  return total;
}

afterAll(() => {
  for (const sandbox of sandboxes) fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('final-product-acceptance workflow audio staging', () => {
  it('never previews a find result through a pipe-closing `head`', () => {
    const workflows = fs.readdirSync(WORKFLOWS_DIR).filter((name) => /\.ya?ml$/.test(name));
    const offenders = workflows.filter((name) =>
      /\|\s*head\b/.test(fs.readFileSync(path.join(WORKFLOWS_DIR, name), 'utf8')),
    );
    expect(offenders, `workflows must not pipe into head under pipefail: ${offenders.join(', ')}`).toEqual([]);
  });

  it('keeps the copy, the WAV count and the artifact path in the staging step', () => {
    const script = extractRunBlock(fs.readFileSync(ACCEPTANCE_WORKFLOW, 'utf8'), STAGING_STEP);
    expect(script.startsWith('set -euo pipefail')).toBe(true);
    expect(script).toContain(`rm -rf ${ARTIFACT_ROOT}`);
    expect(script).toContain(`mkdir -p ${ARTIFACT_ROOT}`);
    expect(script).toContain(`cp -r .production ${ARTIFACT_ROOT}/production`);
    expect(script).toContain(`find ${ARTIFACT_ROOT} -name '*.wav' | wc -l`);
    expect(script).toContain(`find ${ARTIFACT_ROOT} -name '*.wav' | sed -n '1,5p'`);
  });

  it('copies every WAV and previews five of them under `set -euo pipefail`', () => {
    const script = extractRunBlock(fs.readFileSync(ACCEPTANCE_WORKFLOW, 'utf8'), STAGING_STEP);
    const sandbox = makeSandbox(12);
    const scriptPath = path.join(sandbox, 'stage-audio.sh');
    fs.writeFileSync(scriptPath, `${script}\n`, 'utf8');

    const result = spawnSync('bash', [scriptPath], { cwd: sandbox, encoding: 'utf8', timeout: 60_000 });
    expect(result.error, `spawn failed: ${result.error?.message ?? 'unknown'}`).toBeUndefined();
    expect(result.status, `exit ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(result.stderr).not.toMatch(/Broken pipe/);
    expect(result.stdout).toContain('product audio root copy: 12 WAV files');

    const preview = result.stdout.split('\n').filter((line) => line.endsWith('.wav'));
    expect(preview).toHaveLength(5);

    // The artifact copy is the full product audio, hidden-dir copy included.
    const artifactAudio = path.join(sandbox, ARTIFACT_ROOT, 'production', 'FinalAcceptance_RFI_Backlog', 'audio');
    expect(countWavs(artifactAudio)).toBe(12);
    // The engine's own root is untouched.
    expect(countWavs(path.join(sandbox, '.production'))).toBe(12);
  });
});
