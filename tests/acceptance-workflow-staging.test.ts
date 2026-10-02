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
const PRODUCTION_STATE_UPLOAD_STEP = 'Upload the post-export production state';
const PRODUCTION_STATE_RESTORE_STEP = 'Restore the post-export production state (this run only)';
const PRODUCTION_STATE_VERIFY_STEP = 'Verify the restored state belongs to this run';
/** The scratch root the post-export state lives in, and the root its upload-artifact archive is keyed to. */
const PRODUCTION_STATE_ROOT = path.join('.stills', 'final-acceptance');
const FINAL_PRODUCTION_STAGE_RELATIVE = path.join(PRODUCTION_STATE_ROOT, 'stage', 'final-production.json');

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

/** The own body lines of every step named `stepName` (the step indicator excluded). */
function extractStepBlocks(workflow: string, stepName: string): string[][] {
  const lines = workflow.split('\n');
  const blocks: string[][] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed !== `- name: ${stepName}` && trimmed !== `- name: '${stepName}'`) continue;
    const stepIndent = (lines[i].match(/^\s*/) as RegExpMatchArray)[0].length;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() !== '') {
        const indent = (line.match(/^\s*/) as RegExpMatchArray)[0].length;
        if (indent < stepIndent) break;
        if (indent === stepIndent && line.trim().startsWith('- ')) break;
      }
      body.push(line);
    }
    blocks.push(body);
  }
  if (blocks.length === 0) throw new Error(`step not found in workflow: ${stepName}`);
  return blocks;
}

/** The own body lines of the first step named `stepName`. */
function extractStepLines(workflow: string, stepName: string): string[] {
  return extractStepBlocks(workflow, stepName)[0];
}

/** The scalar value of `key:` in a step body — used for the `with:` inputs of actions. */
function readStepScalar(stepLines: string[], key: string): string {
  const pattern = new RegExp(`^\\s*${key}:\\s+(\\S.*)$`);
  for (const line of stepLines) {
    const match = line.match(pattern);
    if (match) return match[1].trim();
  }
  throw new Error(`scalar not found in step body: ${key}`);
}

/** The entries of a `key: |` literal block in a step body, dedented. */
function readStepPathBlock(stepLines: string[], key: string): string[] {
  const index = stepLines.findIndex((line) => new RegExp(`^\\s*${key}:\\s*\\|\\s*$`).test(line));
  if (index === -1) throw new Error(`literal block not found in step body: ${key}`);
  const keyIndent = (stepLines[index].match(/^\s*/) as RegExpMatchArray)[0].length;
  const entries: string[] = [];
  for (let i = index + 1; i < stepLines.length; i += 1) {
    if (stepLines[i].trim() === '') continue;
    const indent = (stepLines[i].match(/^\s*/) as RegExpMatchArray)[0].length;
    if (indent <= keyIndent) break;
    entries.push(stepLines[i].trim());
  }
  return entries;
}

/** Every file below `root`, as `/`-joined paths relative to it. */
function walkFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
      else found.push(relative);
    }
  };
  walk(root, '');
  return found;
}

/**
 * upload-artifact roots an artifact at the LEAST COMMON ANCESTOR of every
 * `path:` entry, then stores each file relative to that ancestor. A job that
 * restores the artifact has to extract it under the same root, otherwise the
 * files land one level (or more) away from where the workflow looks for them.
 */
function leastCommonAncestor(paths: string[]): string {
  const segments = paths.map((entry) => entry.split('/').filter((part) => part !== ''));
  let shared = segments[0].length;
  for (const parts of segments.slice(1)) {
    let index = 0;
    while (index < shared && index < parts.length && parts[index] === segments[0][index]) index += 1;
    shared = index;
  }
  return segments[0].slice(0, shared).join('/');
}

/** The archive upload-artifact would build from `uploadPaths`: relative path -> body. */
function buildArtifactEntries(sandbox: string, uploadPaths: string[]): Map<string, string> {
  const root = path.join(sandbox, leastCommonAncestor(uploadPaths));
  const entries = new Map<string, string>();
  for (const upload of uploadPaths) {
    const absolute = path.join(sandbox, upload);
    const files = fs.statSync(absolute).isDirectory()
      ? walkFiles(absolute).map((relative) => path.join(absolute, relative))
      : [absolute];
    for (const file of files) {
      entries.set(path.relative(root, file).split(path.sep).join('/'), fs.readFileSync(file, 'utf8'));
    }
  }
  return entries;
}

/** The inverse: download-artifact writes every archive entry below `target`. */
function extractArtifact(sandbox: string, entries: Map<string, string>, target: string): void {
  for (const [relative, body] of entries) {
    const full = path.join(sandbox, target, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
}

/** A repo-shaped sandbox holding the post-export state the final-production job uploads. */
function makePostExportSandbox(runId: string, sha: string): string {
  const sandbox = makeSandbox('acceptance-post-export-');
  const dataDir = path.join(sandbox, PRODUCTION_STATE_ROOT, 'data');
  fs.mkdirSync(path.join(dataDir, 'projects', 'FinalAcceptance_RFI_Backlog'), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'production-history.json'),
    JSON.stringify({ projects: ['FinalAcceptance_RFI_Backlog'] }, null, 2),
  );
  fs.writeFileSync(
    path.join(dataDir, 'projects', 'FinalAcceptance_RFI_Backlog', 'production-history.json'),
    JSON.stringify({ projectId: 'SecondFreshProject', decisions: [] }, null, 2),
  );
  const stageFile = path.join(sandbox, FINAL_PRODUCTION_STAGE_RELATIVE);
  fs.mkdirSync(path.dirname(stageFile), { recursive: true });
  fs.writeFileSync(
    stageFile,
    JSON.stringify(
      {
        stage: 'final-production',
        status: 'passed',
        runId,
        commit: sha,
        packageRoot: path.join(PRODUCTION_STATE_ROOT, 'output', 'package'),
      },
      null,
      2,
    ),
  );
  return sandbox;
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

function runScript(
  sandbox: string,
  script: string,
  name: string,
  env?: Record<string, string>,
): { status: number | null; stdout: string; stderr: string } {
  const scriptPath = path.join(sandbox, name);
  fs.writeFileSync(scriptPath, `${script}\n`, 'utf8');
  const result = spawnSync('bash', [scriptPath], {
    cwd: sandbox,
    encoding: 'utf8',
    timeout: 60_000,
    env: env ? { ...process.env, ...env } : process.env,
  });
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

/**
 * Regression 3 — Retry 15 (run 37070939732, job 111058288257, step "Verify the
 * restored state belongs to this run"): the final-production job uploads
 * `final-acceptance-state` from `.stills/final-acceptance/data` and
 * `.stills/final-acceptance/stage/final-production.json`. upload-artifact roots
 * that archive at its least common ancestor (`.stills/final-acceptance`), so the
 * archive stores `data/…` and `stage/final-production.json`. The second-project
 * job extracted it at the repository root (`path: .`), which put the state at
 * `./data` and `./stage` — so the first `test -f` of the verification step failed
 * silently (exit 1, no output) and the second-project stage never ran.
 *
 * These tests execute the verification step's REAL `run:` block against an
 * archive built the way upload-artifact builds it, so the download root, the
 * upload paths and the verification paths must stay in agreement.
 */
describe('final-product-acceptance second-project state restore root', () => {
  const workflow = (): string => fs.readFileSync(ACCEPTANCE_WORKFLOW, 'utf8');
  const RUN_ID = '37070939732';
  const SHA = '6b2da1af04185491fc021c66f7d7820bf8305734';
  const identity = { GITHUB_RUN_ID: RUN_ID, GITHUB_SHA: SHA };

  /** The archive the final-production job uploads, built from a real sandbox. */
  function uploadedStateArchive(uploadPaths: string[], runId: string, sha: string): { entries: Map<string, string>; restorePath: string } {
    const producer = makePostExportSandbox(runId, sha);
    return {
      entries: buildArtifactEntries(producer, uploadPaths),
      restorePath: readStepScalar(extractStepLines(workflow(), PRODUCTION_STATE_RESTORE_STEP), 'path'),
    };
  }

  it('restores the state archive under the same root its upload was rooted at', () => {
    const text = workflow();
    expect(extractStepBlocks(text, PRODUCTION_STATE_RESTORE_STEP), PRODUCTION_STATE_RESTORE_STEP).toHaveLength(1);

    const uploadPaths = readStepPathBlock(extractStepLines(text, PRODUCTION_STATE_UPLOAD_STEP), 'path');
    expect(uploadPaths).toEqual([
      '.stills/final-acceptance/data',
      '.stills/final-acceptance/stage/final-production.json',
    ]);

    // upload-artifact keys the archive to the least common ancestor of the uploaded paths…
    const artifactRoot = leastCommonAncestor(uploadPaths);
    expect(artifactRoot).toBe(PRODUCTION_STATE_ROOT.split(path.sep).join('/'));

    // …and download-artifact must extract it under that same root, not the repository root.
    const restore = extractStepLines(text, PRODUCTION_STATE_RESTORE_STEP);
    expect(readStepScalar(restore, 'path'), 'the state archive is rooted at its least common ancestor').toBe(artifactRoot);
    expect(readStepScalar(restore, 'name')).toBe('final-acceptance-state');

    // The "this run only" pinning must survive the root change untouched.
    expect(readStepScalar(restore, 'run-id')).toBe('${{ github.run_id }}');
    expect(readStepScalar(restore, 'github-token')).toBe('${{ secrets.GITHUB_TOKEN }}');
  });

  it('reconstructs exactly the state the verification step opens', () => {
    const text = workflow();
    const uploadPaths = readStepPathBlock(extractStepLines(text, PRODUCTION_STATE_UPLOAD_STEP), 'path');
    const verifyScript = extractRunBlock(text, PRODUCTION_STATE_VERIFY_STEP);
    const { entries, restorePath } = uploadedStateArchive(uploadPaths, RUN_ID, SHA);

    // The archive holds paths relative to the artifact root, never the scratch prefix.
    expect([...entries.keys()].sort()).toEqual([
      'data/production-history.json',
      'data/projects/FinalAcceptance_RFI_Backlog/production-history.json',
      'stage/final-production.json',
    ]);

    const consumer = makeSandbox('acceptance-second-project-');
    extractArtifact(consumer, entries, restorePath);
    const result = runScript(consumer, verifyScript, 'verify-state.sh', identity);
    expect(
      result.status,
      `exit ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stdout).toContain(`restored post-export state is valid for run ${RUN_ID} at commit ${SHA}`);
    // The state is visible where the driver and the second-project step expect it.
    expect(fs.existsSync(path.join(consumer, FINAL_PRODUCTION_STAGE_RELATIVE))).toBe(true);
    expect(fs.existsSync(path.join(consumer, PRODUCTION_STATE_ROOT, 'data', 'production-history.json'))).toBe(true);
  });

  it('reproduces the pre-fix repository-root extraction, which failed silently in CI', () => {
    const text = workflow();
    const uploadPaths = readStepPathBlock(extractStepLines(text, PRODUCTION_STATE_UPLOAD_STEP), 'path');
    const verifyScript = extractRunBlock(text, PRODUCTION_STATE_VERIFY_STEP);
    const { entries } = uploadedStateArchive(uploadPaths, RUN_ID, SHA);

    // The pre-fix download root was `.`; the state lands one level above the scratch root.
    const consumer = makeSandbox('acceptance-second-project-prefix-');
    extractArtifact(consumer, entries, '.');
    expect(fs.existsSync(path.join(consumer, 'stage', 'final-production.json'))).toBe(true);
    expect(fs.existsSync(path.join(consumer, FINAL_PRODUCTION_STAGE_RELATIVE))).toBe(false);

    const result = runScript(consumer, verifyScript, 'verify-state-prefix.sh', identity);
    // `set -euo pipefail` + a failing `test -f` = exit 1 with no diagnostic at all,
    // which is exactly what job 111058288257 reported.
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`.trim()).toBe('');
  });

  it('still rejects a restored state that belongs to another run', () => {
    const text = workflow();
    const verifyScript = extractRunBlock(text, PRODUCTION_STATE_VERIFY_STEP);

    // The run-id / commit / stage-status / package-root identity checks stay in the step.
    expect(verifyScript).toContain('if (stage.stage !== "final-production")');
    expect(verifyScript).toContain('if (stage.status !== "passed")');
    expect(verifyScript).toContain('if (stage.runId !== process.env.GITHUB_RUN_ID)');
    expect(verifyScript).toContain('if (stage.commit !== process.env.GITHUB_SHA)');
    expect(verifyScript).toContain('if (!stage.packageRoot)');

    const uploadPaths = readStepPathBlock(extractStepLines(text, PRODUCTION_STATE_UPLOAD_STEP), 'path');
    const { entries, restorePath } = uploadedStateArchive(uploadPaths, '11', 'cafebabe');

    const consumer = makeSandbox('acceptance-second-project-foreign-');
    extractArtifact(consumer, entries, restorePath);
    const result = runScript(consumer, verifyScript, 'verify-state-foreign.sh', identity);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`runId is 11, expected ${RUN_ID}`);
    expect(result.stderr).toContain(`commit is cafebabe, expected ${SHA}`);
  });
});
