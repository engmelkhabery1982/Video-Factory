#!/usr/bin/env node
/**
 * TEST FIXTURE ONLY. A stand-in for tools/alignment-run/align_recording.py that
 * writes boundaries.json in the same shape, so the API bridge can be tested
 * without the model. It is NOT alignment and its timings are NOT evidence.
 * Real acceptance runs the owner's vf-align WSL runtime on the owner's recording.
 *
 * VF_FAKE_ALIGN_MODE: ok (default) | unavailable | blocker | slow
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const arg = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const mode = process.env.VF_FAKE_ALIGN_MODE ?? 'ok';

if (mode === 'blocker') {
  console.error('BLOCKER=fixture_blocker');
  process.exit(1);
}
if (mode === 'slow') await new Promise((r) => setTimeout(r, 3000));

const wavPath = arg('--wav');
const reviewDir = arg('--review-dir');
fs.mkdirSync(reviewDir, { recursive: true });
const bytes = fs.readFileSync(wavPath);
const sha = crypto.createHash('sha256').update(bytes).digest('hex');

// Duration from the RIFF header written by the test (PCM, 44-byte header).
const byteRate = bytes.readUInt32LE(28);
const dataBytes = bytes.readUInt32LE(40);
const dur = Number((dataBytes / byteRate).toFixed(3));

// The job's expected WAV identity, written by the API. Refuse any other file, as the real runner does.
const expectedPath = arg('--expected-audio-json');
if (!expectedPath || !fs.existsSync(expectedPath)) {
  console.error('BLOCKER=expected_audio_identity_missing');
  process.exit(1);
}
const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
if (expected.sha256 !== sha || expected.bytes !== bytes.length) {
  console.error('BLOCKER=wav_identity mismatch');
  process.exit(1);
}

const common = {
  executionStatus: 'alignment_files_written_listening_not_done',
  saved: false,
  timingsModified: false,
  recordingModified: false,
  renderStarted: false,
  acousticVerification: false,
  verified: false,
  method: 'fixture',
  audioSha256: sha,
  audioDurationSec: dur,
  frameSec: 0.02,
  unresolved: [],
};

if (mode === 'unavailable') {
  fs.writeFileSync(`${reviewDir}/boundaries.json`, JSON.stringify({ ...common, available: false, detail: 'FIXTURE: unavailable on purpose', rows: [] }, null, 2));
  process.exit(0);
}

const project = JSON.parse(fs.readFileSync(arg('--project-json'), 'utf8'));
const scenes = project.storyboard.long.scenes;
const seg = dur / scenes.length;
const rows = scenes.map((s, i) => {
  const start = Number((i * seg).toFixed(3));
  const end = Number((start + seg * 0.9).toFixed(3));
  return {
    sceneId: s.id,
    proposedStart: start,
    proposedDurationSec: Number(seg.toFixed(3)),
    proposedCaptionStart: start,
    proposedCaptionEnd: end,
  };
});
/*
 * TEST FIXTURE transcript stand-in (VF_FAKE_ALIGN_TRANSCRIPT). Not a speech recognizer.
 *   unset (default): no transcript field, so verification is unavailable
 *   script:          transcript equals the supplied text (agreement)
 *   drop_last:       transcript omits the last supplied caption (an absent sentence)
 */
const transcriptMode = process.env.VF_FAKE_ALIGN_TRANSCRIPT ?? 'none';
const suppliedTexts = scenes.map((s) => s.narration ?? '');
const transcriptFor = () => {
  if (transcriptMode === 'script') return suppliedTexts.join(' ');
  if (transcriptMode === 'drop_last') return suppliedTexts.slice(0, -1).join(' ');
  return undefined;
};
const transcript = transcriptFor();
fs.writeFileSync(
  `${reviewDir}/boundaries.json`,
  JSON.stringify({ ...common, available: true, detail: 'FIXTURE protocol stand-in; not acoustic evidence', rows, ...(transcript === undefined ? {} : { transcript }) }, null, 2),
);
process.exit(0);
