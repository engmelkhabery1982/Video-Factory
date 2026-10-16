// FIXTURE transcription runner. TESTS ONLY. It is not a transcription engine and it does not decode audio.
// It exercises the job contract in apps/api/src/services/factory-transcription.ts with the same flags as the real
// runner (tools/alignment-run/transcribe_recording.py): --audio --out --checkpoint --tokenizer. It writes the result
// JSON, labels its provenance, and never reads any script or text. Nothing it writes is evidence of transcription.
//   env:  FIXTURE_RUNNER_MODE=ok|fail        FIXTURE_DELAY_MS=<ms>        FIXTURE_IGNORE_TERM=1
//         FIXTURE_TRANSCRIPT=<text>          FIXTURE_WRONG_SHA=1           FIXTURE_ARGV_LOG=<file>
//         FIXTURE_SHAPE=fixture|greedy      (greedy = result SHAPED like a real greedy CTC result, for the
//                                              reuse and provenance tests only; it still decodes nothing)
//         FIXTURE_NO_DECODER=1             (result with transcript null and a reason, like the real runner)
import fs from 'node:fs';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const audioFile = flag('audio');
const outFile = flag('out');
const checkpoint = flag('checkpoint');
const tokenizer = flag('tokenizer');
if (!audioFile || !outFile || !checkpoint || !tokenizer) {
  process.stderr.write('fixture runner: --audio --out --checkpoint --tokenizer are required\n');
  process.exit(64);
}
if (process.env.FIXTURE_ARGV_LOG) fs.appendFileSync(process.env.FIXTURE_ARGV_LOG, `${JSON.stringify(args)}\n`);
if (process.env.FIXTURE_IGNORE_TERM === '1') process.on('SIGTERM', () => {});
if (process.env.FIXTURE_RUNNER_MODE === 'fail') {
  process.stderr.write('fixture failure\n');
  process.exit(2);
}
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(audioFile)).digest('hex');
process.stdout.write('PROGRESS 0.5\n');
setTimeout(() => {
  const greedy = process.env.FIXTURE_SHAPE === 'greedy';
  const result = {
    schemaVersion: 2,
    transcript: process.env.FIXTURE_NO_DECODER === '1' ? null : (process.env.FIXTURE_TRANSCRIPT ?? 'Fixture transcript line one.\n\nFixture transcript line two.'),
    transcriptUnavailable: process.env.FIXTURE_NO_DECODER === '1' ? 'The character decoder is unavailable (fixture).' : undefined,
    audioSha256: process.env.FIXTURE_WRONG_SHA === '1' ? '0'.repeat(64) : sha256,
    engine: greedy ? 'fixture-shaped greedy result (test double, not a transcription engine)' : 'fixture-runner (test double, not a transcription engine)',
    model: greedy ? { arch: '300m_v2', vocab: 10288, checkpointBytes: 1304065508, tokenizerBytes: 91481, officialWeightsUsed: true } : undefined,
    provenance: greedy
      ? { method: 'greedy_ctc', source: 'frame_emissions', independentOfScript: true, scriptCopied: false, fixture: false, emissionsSha256: 'a'.repeat(64), frames: 1000, frameSec: 0.02, blankId: 0, decoder: 'fixture' }
      : { method: 'fixture_stand_in', fixture: true, independentOfScript: true, scriptCopied: false, emissionsSha256: null },
  };
  fs.writeFileSync(outFile, JSON.stringify(result), 'utf8');
  process.exit(0);
}, Number(process.env.FIXTURE_DELAY_MS ?? 0));
