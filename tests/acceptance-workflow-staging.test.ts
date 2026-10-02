/**
 * REGRESSIONS for the acceptance workflow's audio shell steps (no render, no TTS,
 * no network). Both defects below cost a full acceptance run before being fixed;
 * the tests execute the steps' REAL `run:` blocks in throwaway sandboxes, so a
 * future edit that reintroduces either shape fails here instead of in CI.
 *
 * 1. Retry 8 (run 37017285040) — "Stage the real production audio for the
 *    artifact": `find … | head -5` under `set -euo pipefail`. `head` closes the
 *    pipe after five lines, GNU find exits non-zero on the resulting EPIPE
 *    ("find: 'standard output': Broken pipe" / "write error"), and pipefail
 *    turned that into exit code 1 — after the real WAVs had been copied
 *    successfully, so the preflight-state upload and every gated job were
 *    skipped.
 *
 * 2. Retry 9 (run 37021901606) — "Materialize the product audio root" (both the
 *    short-smoke and final-production jobs): the step counted EVERY WAV under
 *    `.production` (dialogue + canonical) and compared that total to
 *    `stage.audio.perTurnFiles`, which counts DIALOGUE only. The product writes
 *    one canonical WAV per dialogue WAV, so a correctly restored tree (36 + 36)
 *    failed with "restored per-turn WAV count 72 != preflight count 36" even
 *    though no audio was missing. The step now counts the dialogue and canonical
 *    directories separately and compares each to its OWN recorded preflight
 *    count (audio.perTurnFiles / audio.canonicalFiles).
 *
 * The steps' `run:` blocks are extracted from the workflow text, so nothing here
 * can silently drift from what CI actually executes.
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
const MATERIALIZE_STEP = 'Materialize the product audio root';
const ARTIFACT_ROOT = path.join('.stills', 'final-acceptance', 'audio-artifact');
const PREFLIGHT_STAGE_RELATIVE = path.join('.stills', 'final-acceptance', 'stage', 'preflight.json');
const AUDIO_ROOT_RELATIVE = path.join('.production', 'FinalAcceptance_RFI_Backlog', 'audio');
const LEGACY_TOTAL_COUNT = `audio_count="$(find .production -name '*.wav' | wc -l)"`;

const sandboxes: string[] = [];

/** Dedent the `run:` body that follows the `run: |` line at `runIndex`. */
function readRunBody(lines: string[], runIndex: number): string {
  const body: string[] = [];
  const runIndent = (lines[runIndex].match(/^\s*/) as RegExpMatchArray)[0].length;
  for (let i = runIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') {
      body.push('');
      continue;
    }
    const indent = (line.match(/^\s*/) as RegExpMatchArray)[0].length;
    if (indent <= runIndent) break;
    body.push(line);
  }
  while (body.length > 0 && body[body.length - 1].trim() === '') body.pop();
  const blockIndent = (body[0].match(/^\s*/) as RegExpMatchArray)[0].length;
  return body.map((line) => line.slice(blockIndent)).join('\n');
}

/** Every `run:` block of the workflow steps named `stepName`, in workflow order. */
function extractRunBlocks(workflow: string, stepName: string): string[] {
  const lines = workflow.split('\n');
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed !== `- name: ${stepName}` && trimmed !== `- name: '${stepName}'`) continue;
    let runIndex = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^\s*- name:/.test(lines[j])) break;
      if (/^\s*run:\s*\|-?\s*$/.test(lines[j])) {
        runIndex = j;
        break;
      }
    }
    if (runIndex === -1) throw new Error(`run block not found for step: ${stepName}`);
    blocks.push(readRunBody(lines, runIndex));
  }
  if (blocks.length === 0) throw new Error(`step not found in workflow: ${stepName}`);
  return blocks;
}

/** The `run:` block of the first step named `stepName`. */
function extractRunBlock(workflow: string, stepName: string): string {
  return extractRunBlocks(workflow, stepName)[0];
}

function makeSandbox(prefix: string): string {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  sandboxes.push(sandbox);
  return sandbox;
}

function writeWavs(dir: string, count: number, name: (index: number) => string): void {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    fs.writeFileSync(path.join(dir, name(i)), 'RIFF____WAVEfmt ');
  }
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

function runScript(sandbox: string, script: string, name: string): { status: number | null; stdout: string; stderr: string } {
  const scriptPath = path.join(sandbox, name);
  fs.writeFileSync(scriptPath, `${script}\n`, 'utf8');
  const result = spawnSync('bash', [scriptPath], { cwd: sandbox, encoding: 'utf8', timeout: 60_000 });
  expect(result.error, `${name}: spawn failed (${result.error?.message ?? 'unknown'})`).toBeUndefined();
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * A repo-shaped sandbox for a "Materialize the product audio root" step: this
 * run's restored preflight stage + data, and an audio artifact copy holding
 * `dialogue` and `canonical` WAVs. `canonical: null` leaves the canonical
 * directory missing entirely.
 */
function makeMaterializeSandbox(options: {
  dialogue: number;
  canonical: number | null;
  recordedDialogue: number;
  recordedCanonical: number;
}): string {
  const sandbox = makeSandbox('acceptance-materialize-');
  const stageFile = path.join(sandbox, PREFLIGHT_STAGE_RELATIVE);
  fs.mkdirSync(path.dirname(stageFile), { recursive: true });
  fs.writeFileSync(
    stageFile,
    JSON.stringify(
      {
        stage: 'preflight',
        status: 'passed',
        videoId: 'FinalAcceptance_RFI_Backlog',
        audio: {
          productAudioRoot: AUDIO_ROOT_RELATIVE,
          perTurnFiles: options.recordedDialogue,
          canonicalFiles: options.recordedCanonical,
        },
      },
      null,
      2,
    ),
  );
  // The final-production job's materialize step additionally requires the
  // short-smoke stage document restored from this run.
  fs.writeFileSync(
    path.join(sandbox, '.stills', 'final-acceptance', 'stage', 'short-smoke.json'),
    JSON.stringify({ stage: 'short-smoke', status: 'passed', runId: 1, commit: 'test' }, null, 2),
  );
  const dataDir = path.join(sandbox, '.stills', 'final-acceptance', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'visual_history.json'), '{}');

  const productAudio = path.join(sandbox, ARTIFACT_ROOT, 'production', 'FinalAcceptance_RFI_Backlog', 'audio');
  writeWavs(path.join(productAudio, 'dialogue'), options.dialogue, (i) => `scene-01_turn-${i}.wav`);
  if (options.canonical !== null) {
    writeWavs(path.join(productAudio, 'canonical'), options.canonical, (i) => `scene-01_turn-${i}.wav`);
  }
  return sandbox;
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
    const sandbox = makeSandbox('acceptance-staging-');
    const audioRoot = path.join(sandbox, '.production', 'FinalAcceptance_RFI_Backlog', 'audio', 'dialogue');
    writeWavs(path.join(audioRoot, 'scenario-long-01'), 12, (i) => `scenario-long-01-turn-${i}.wav`);

    const result = runScript(sandbox, script, 'stage-audio.sh');
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

describe('final-product-acceptance workflow audio restoration (count domains)', () => {
  const workflow = (): string => fs.readFileSync(ACCEPTANCE_WORKFLOW, 'utf8');

  it('declares the same materialize step in both gated jobs, split per audio class', () => {
    const scripts = extractRunBlocks(workflow(), MATERIALIZE_STEP);
    expect(scripts, `${MATERIALIZE_STEP} must exist once per gated job (short-smoke, final-production)`).toHaveLength(2);
    for (const script of scripts) {
      // The count contract is per class, tied to the recorded product audio root…
      expect(script).toContain(`dialogue_count="$(find "\${audio_root}/dialogue" -name '*.wav' | wc -l)"`);
      expect(script).toContain(`canonical_count="$(find "\${audio_root}/canonical" -name '*.wav' | wc -l)"`);
      expect(script).toContain('stage.audio.productAudioRoot');
      expect(script).toContain('audio.perTurnFiles');
      expect(script).toContain('audio.canonicalFiles');
      // …and the whole-tree count that compared 72 WAVs against 36 turns is gone.
      expect(script).not.toContain(LEGACY_TOTAL_COUNT);
      // The restoration copy and the restored-state prerequisites stay in place.
      expect(script).toContain(`cp -r ${ARTIFACT_ROOT}/production .production`);
      expect(script).toContain(`test -f ${PREFLIGHT_STAGE_RELATIVE}`);
      expect(script).toContain('test -d .production');
    }
  });

  it('passes for unequal dialogue/canonical counts that each match their recorded count', () => {
    const scripts = extractRunBlocks(workflow(), MATERIALIZE_STEP);
    const sandbox = makeMaterializeSandbox({ dialogue: 12, canonical: 5, recordedDialogue: 12, recordedCanonical: 5 });

    for (const [index, script] of scripts.entries()) {
      const result = runScript(sandbox, script, `materialize-${index}.sh`);
      expect(
        result.status,
        `step ${index}: exit ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      ).toBe(0);
      expect(result.stderr).not.toContain('!=');
      expect(result.stdout).toContain(`12 dialogue WAV(s), 5 canonical WAV(s)`);
      expect(result.stdout).toContain('restored real production audio matches preflight: 12 dialogue WAV(s) == 12, 5 canonical WAV(s) == 5');
    }

    // The old whole-tree check cannot pass in this sandbox: 12 + 5 restored WAVs
    // compared against 12 recorded turns. This is the defect the split fixes.
    const legacy = [
      'set -euo pipefail',
      'test -d .production',
      LEGACY_TOTAL_COUNT,
      'echo "production audio root: ${audio_count} WAV files"',
      `node -e '
        const fs = require("node:fs");
        const stage = JSON.parse(fs.readFileSync("${PREFLIGHT_STAGE_RELATIVE}", "utf8"));
        const expected = Number(stage.audio && stage.audio.perTurnFiles);
        const actual = Number(process.argv[1]);
        if (expected !== actual) { console.error("restored per-turn WAV count " + actual + " != preflight count " + expected); process.exit(1); }
      ' "\${audio_count}"`,
    ].join('\n');
    const legacyResult = runScript(sandbox, legacy, 'legacy-count.sh');
    expect(legacyResult.status).not.toBe(0);
    expect(legacyResult.stderr).toContain('restored per-turn WAV count 17 != preflight count 12');
  });

  it('fails loudly when a class is short instead of fabricating audio', () => {
    const script = extractRunBlock(workflow(), MATERIALIZE_STEP);

    const shortCanonical = makeMaterializeSandbox({ dialogue: 12, canonical: 4, recordedDialogue: 12, recordedCanonical: 5 });
    const canonicalResult = runScript(shortCanonical, script, 'materialize-short-canonical.sh');
    expect(canonicalResult.status).not.toBe(0);
    expect(canonicalResult.stderr).toContain('restored canonical WAV count 4 != preflight canonical count 5');
    expect(canonicalResult.stderr).not.toContain('restored dialogue WAV count');

    const shortDialogue = makeMaterializeSandbox({ dialogue: 11, canonical: 5, recordedDialogue: 12, recordedCanonical: 5 });
    const dialogueResult = runScript(shortDialogue, script, 'materialize-short-dialogue.sh');
    expect(dialogueResult.status).not.toBe(0);
    expect(dialogueResult.stderr).toContain('restored dialogue WAV count 11 != preflight per-turn count 12');
  });

  it('fails when the recorded product audio classes are unusable or a directory is missing', () => {
    const script = extractRunBlock(workflow(), MATERIALIZE_STEP);

    const missingCanonical = makeMaterializeSandbox({ dialogue: 12, canonical: null, recordedDialogue: 12, recordedCanonical: 5 });
    const missingResult = runScript(missingCanonical, script, 'materialize-missing-canonical.sh');
    expect(missingResult.status).not.toBe(0);
    expect(`${missingResult.stderr}${missingResult.stdout}`).toMatch(/No such file or directory|canonical/);

    const noRecordedCounts = makeMaterializeSandbox({ dialogue: 12, canonical: 12, recordedDialogue: 0, recordedCanonical: 0 });
    const noCountsResult = runScript(noRecordedCounts, script, 'materialize-no-counts.sh');
    expect(noCountsResult.status).not.toBe(0);
    expect(noCountsResult.stderr).toContain('preflight recorded no per-turn dialogue WAVs');
  });
});
