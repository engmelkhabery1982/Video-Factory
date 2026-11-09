/**
 * ONE explicit owner-host command: preflight, then ONE real audio transcription of the file you name, then redacted
 * evidence. It uses the same job code as the app (startJob), so it proves what the app would do.
 *
 *   node --import tsx scripts/transcribe-owner-check.ts \
 *     --audio <path-to-recording.wav> --evidence-dir <empty folder outside data/ and output/> --confirm-run
 *
 * Environment (already configured on the owner machine; nothing is installed or downloaded):
 *   VF_TRANSCRIBE_COMMAND  JSON argv of the launcher, e.g. ["wsl.exe","-d","Ubuntu","--","/opt/vf-align/bin/python","/mnt/c/.../tools/alignment-run/transcribe_recording.py"]
 *   VF_ALIGN_CHECKPOINT    the existing omniASR 300m_v2 checkpoint (1304065508 bytes)
 *   VF_ALIGN_TOKENIZER     the existing tokenizer (91481 bytes)
 *   VF_ALIGN_PATH_STYLE    "wsl" when the launcher is wsl.exe (maps C:\ to /mnt/c)
 *
 * It never reads or writes data/ or output/ except its own scratch folder inside --evidence-dir. It never modifies
 * the audio file or any saved timing. It stops on the first failure. Evidence holds NO transcript text.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);

function stop(message: string, code = 1): never {
  process.stderr.write(`STOP: ${message}\n`);
  process.exit(code);
}

const audio = flag('audio');
const evidenceDir = flag('evidence-dir');
if (!audio || !evidenceDir) stop('--audio and --evidence-dir are required.', 64);
if (!has('confirm-run')) stop('Add --confirm-run to start ONE real transcription of the named file. Nothing ran.', 64);
const audioPath = path.resolve(audio);
const evidence = path.resolve(evidenceDir);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const guarded of ['data', 'output']) {
  const forbidden = path.join(repoRoot, guarded);
  if (evidence === forbidden || evidence.startsWith(forbidden + path.sep)) stop(`--evidence-dir must not be inside ${guarded}/.`, 64);
}

// Preflight: no billable calls, no installs, no writes outside the evidence folder.
if (!fs.existsSync(audioPath) || !fs.statSync(audioPath).isFile()) stop('The audio file does not exist.');
if (!/\.wav$/i.test(audioPath)) stop('Only a WAV recording is accepted by this check.');
const sizeBefore = fs.statSync(audioPath).size;
if (sizeBefore === 0) stop('The audio file is empty.');
const shaBefore = crypto.createHash('sha256').update(fs.readFileSync(audioPath)).digest('hex');
const ckpt = process.env.VF_ALIGN_CHECKPOINT ?? '';
const tok = process.env.VF_ALIGN_TOKENIZER ?? '';
if (!process.env.VF_TRANSCRIBE_COMMAND) stop('VF_TRANSCRIBE_COMMAND is not set.');
if (!ckpt || !tok) stop('VF_ALIGN_CHECKPOINT and VF_ALIGN_TOKENIZER must name the existing runtime files.');
const ckptOk = fs.existsSync(ckpt) && fs.statSync(ckpt).size === 1304065508;
const tokOk = fs.existsSync(tok) && fs.statSync(tok).size === 91481;
if (!ckptOk) stop('The checkpoint is missing or not the expected 1304065508-byte file. Nothing was downloaded.');
if (!tokOk) stop('The tokenizer is missing or not the expected 91481-byte file. Nothing was downloaded.');

fs.mkdirSync(evidence, { recursive: true });
const scratch = path.join(evidence, 'scratch-data');
process.env.BUILDTRAKE_DATA = scratch;
process.env.BUILDTRAKE_OUTPUT = path.join(evidence, 'scratch-output');

const svc = await import('../apps/api/src/services/factory-transcription.ts');
const cap = svc.transcriptionCapability(process.env);
if (!cap.available) stop(`The runner is not available: ${cap.reason}`);

process.stdout.write('Preflight passed. Starting ONE transcription. This can take a long time on CPU.\n');
const started = svc.startJob({ audioAssetId: 'owner-check', audioFile: audioPath, audioDurationSec: 0, env: process.env, rerun: true });
const deadline = Date.now() + (cap.timeoutSec + 30) * 1000;
let job = svc.loadJob(started.job.jobId);
while (job && (job.status === 'queued' || job.status === 'running') && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  job = svc.loadJob(started.job.jobId);
}
const sizeAfter = fs.statSync(audioPath).size;
const shaAfter = crypto.createHash('sha256').update(fs.readFileSync(audioPath)).digest('hex');
const transcript = job?.transcript ?? null;
const evidenceOut = {
  label: 'One transcription by the named runner. Runner identity is recorded. Transcript quality is NOT judged here; it needs owner review.',
  status: job?.status ?? 'missing',
  reason: job?.reason ?? null,
  audioSha256: shaBefore,
  audioBytes: sizeBefore,
  audioUnchanged: shaBefore === shaAfter && sizeBefore === sizeAfter,
  runnerIdentity: job?.runnerIdentity ?? null,
  provenance: job?.provenance ?? null,
  transcript: transcript ? { characters: transcript.length, sha256: crypto.createHash('sha256').update(transcript, 'utf8').digest('hex'), text: 'redacted (see scratch-data, owner review only)' } : null,
  finishedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(evidence, 'transcription-evidence.json'), JSON.stringify(evidenceOut, null, 2) + '\n', 'utf8');
if (transcript) fs.writeFileSync(path.join(evidence, 'transcript-for-owner-review.txt'), transcript, 'utf8');
process.stdout.write(`Status: ${evidenceOut.status}. Evidence: ${path.join(evidence, 'transcription-evidence.json')}\n`);
if (job?.status !== 'succeeded' || !evidenceOut.audioUnchanged) process.exit(1);
