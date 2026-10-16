// FIXTURE transcription runner. TESTS ONLY. It is not a transcription engine and it does not decode audio.
// It exercises the job contract in apps/api/src/services/factory-transcription.ts: it hashes the audio it is given,
// writes the result JSON to the out file, and labels its provenance as a fixture. Nothing it writes is evidence of
// real transcription.
//   argv: <audioFile> <outFile>
//   env:  FIXTURE_RUNNER_MODE=ok|fail   FIXTURE_DELAY_MS=<ms>   FIXTURE_IGNORE_TERM=1   FIXTURE_TRANSCRIPT=<text>
import fs from 'node:fs';
import crypto from 'node:crypto';

const [audioFile, outFile] = process.argv.slice(2);
if (process.env.FIXTURE_IGNORE_TERM === '1') process.on('SIGTERM', () => {});
if (process.env.FIXTURE_RUNNER_MODE === 'fail') {
  process.stderr.write('fixture failure\n');
  process.exit(2);
}
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(audioFile)).digest('hex');
process.stdout.write('PROGRESS 0.5\n');
setTimeout(() => {
  const result = {
    transcript: process.env.FIXTURE_TRANSCRIPT ?? 'Fixture transcript line one.\n\nFixture transcript line two.',
    audioSha256: sha256,
    engine: 'fixture-runner (test double, not a transcription engine)',
    provenance: { method: 'fixture_stand_in', fixture: true, independentOfScript: true, scriptCopied: false, emissionsSha256: null },
  };
  fs.writeFileSync(outFile, JSON.stringify(result), 'utf8');
  process.exit(0);
}, Number(process.env.FIXTURE_DELAY_MS ?? 0));
