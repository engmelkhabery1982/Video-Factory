/**
 * One final export of a declared synthetic WAV.
 *
 * This is not the acceptance workflow and not a human listening approval.
 * It does not read the Gemini recording, does not write user project data,
 * and does not retry the export. Run only from the named GitHub workflow.
 *
 * Declared fixture:
 *   name: synthetic-external-narration.wav
 *   generator: ffmpeg lavfi sine=frequency=220:duration=4
 *   format: 44100 Hz, mono, pcm_s16le
 *   spoken text: the Arabic sentence below, and nothing else
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SYNTHETIC_EXTERNAL_SPOKEN, SYNTHETIC_EXTERNAL_VIDEO_ID, syntheticExternalProjectInput } from './synthetic-external-fixture.js';

const SPOKEN = SYNTHETIC_EXTERNAL_SPOKEN;
const VIDEO_ID = SYNTHETIC_EXTERNAL_VIDEO_ID;
const WAV_NAME = 'synthetic-external-narration.wav';
const DECLARATION = 'CI fixture. Not a human listening approval and not a rights clearance.';
const DECIDED_BY = 'ci-fixture-not-a-human';
const EVIDENCE_DIR = path.join(process.cwd(), '.stills', 'synthetic-external-render');

type JobView = { status?: string; error?: string; log?: string[] };

let failureJob: JobView | null = null;

function redact(value: string): string {
  return value.replace(/(?:\/|[A-Za-z]:\\)[^\s"'`<>|]*/g, (match) => {
    if (match.startsWith('/api/') || match.startsWith('/media/')) return match;
    return '[path]';
  });
}

function writeFailureEvidence(message: string): void {
  try {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    const evidence = {
      ok: false,
      fixture: WAV_NAME,
      generator: 'ffmpeg lavfi sine=frequency=220:duration=4, 44100 Hz mono pcm_s16le',
      spokenText: SPOKEN,
      speech: false,
      geminiRecording: false,
      humanListeningApproval: false,
      publicationApproved: false,
      error: redact(message),
      jobStatus: failureJob?.status ?? null,
      jobError: failureJob?.error ? redact(failureJob.error) : null,
      jobLog: (failureJob?.log ?? []).map((line) => redact(line)),
    };
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'evidence.json'), JSON.stringify(evidence, null, 2));
  } catch {
    // The console line is the fallback. Do not hide the original failure.
  }
}

function fail(message: string, job?: JobView): never {
  if (job) failureJob = job;
  const safe = redact(message);
  writeFailureEvidence(safe);
  console.error(`[synthetic-render] ${safe}`);
  if (failureJob?.error) console.error(`[synthetic-render] job error: ${redact(failureJob.error)}`);
  if (failureJob?.log?.length) {
    console.error('[synthetic-render] job log:');
    for (const line of failureJob.log) console.error(redact(line));
  }
  process.exit(1);
}

async function main() {
  if (process.env.SYNTHETIC_EXTERNAL_RENDER !== '1') {
    fail('Refusing to render. Set SYNTHETIC_EXTERNAL_RENDER=1 only in the one-shot GitHub workflow.');
  }
  const root = process.cwd();
  const data = process.env.BUILDTRAKE_DATA ?? '';
  const output = process.env.BUILDTRAKE_OUTPUT ?? '';
  if (!data.includes(`${path.sep}.stills${path.sep}`) || !output.includes(`${path.sep}.stills${path.sep}`)) {
    fail('Refusing to use a data directory outside .stills. User projects must stay untouched.');
  }
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  const evidenceDir = path.join(root, '.stills', 'synthetic-external-render');
  fs.mkdirSync(evidenceDir, { recursive: true });

  const ffmpeg = path.join(root, 'node_modules', '@ffmpeg-installer', 'linux-x64', 'ffmpeg');
  const ffprobe = path.join(root, 'node_modules', 'ffprobe-static', 'bin', 'linux', 'x64', 'ffprobe');
  if (!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe)) fail('The declared fixture tools are not installed.');
  const wav = path.join(evidenceDir, WAV_NAME);
  const made = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=4', '-ar', '44100', '-ac', '1', wav], { stdio: 'inherit' });
  if (made.status !== 0) fail('The declared synthetic WAV was not created.');
  const wavSha = createHash('sha256').update(fs.readFileSync(wav)).digest('hex');
  const wavProbe = probe(ffprobe, wav);
  if (Math.abs(wavProbe.audioDurationSec - 4) > 0.05) fail(`Declared WAV duration was ${wavProbe.audioDurationSec}, not 4 seconds.`);

  const { buildServerApp } = await import(pathToFileURL(path.join(root, 'apps/api/src/server.ts')).href);
  const app = await buildServerApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') fail('The render server did not bind a port.');
  const origin = `http://127.0.0.1:${address.port}`;

  const projectInput = syntheticExternalProjectInput();
  const created = await request(origin, '/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(projectInput),
  });
  if (created.status !== 200) fail(`Project create failed: ${created.status} ${created.text}`);

  const imported = await request(origin, `/api/projects/${VIDEO_ID}/target-audio/long/external`, {
    method: 'POST',
    body: form(wav),
  });
  if (imported.status !== 201) fail(`Import failed: ${imported.status} ${imported.text}`);
  const refit = await request(origin, `/api/projects/${VIDEO_ID}/storyboard`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ preserveEdits: false }),
  });
  if (refit.status !== 200) fail(`Storyboard fit failed: ${refit.status} ${refit.text}`);
  const project = JSON.parse(refit.text).project;
  const spoken = project.storyboard.long.scenes.map((scene: { narration: string }) => scene.narration).join('\n\n');
  if (spoken !== SPOKEN) fail('The storyboard did not keep the declared spoken text.');
  if (/records|claims|BuildTrack|What does this mean/i.test(spoken)) fail('The storyboard added speech that was not in the script.');

  const listened = await request(origin, `/api/projects/${VIDEO_ID}/target-audio/long/external/approval`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'approved', listened: true, decidedBy: DECIDED_BY }),
  });
  if (listened.status !== 200) fail(`Fixture listening approval failed: ${listened.status} ${listened.text}`);
  const timed = await request(origin, `/api/projects/${VIDEO_ID}/external-narration/timing/long/approval`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'approved', reviewed: true, decidedBy: DECIDED_BY }),
  });
  if (timed.status !== 200) fail(`Fixture timing approval failed: ${timed.status} ${timed.text}`);

  const ready = await request(origin, `/api/projects/${VIDEO_ID}/external-narration`);
  const gate = JSON.parse(ready.text).targets?.[0]?.readiness;
  if (!gate?.exportAttemptReady || gate.publicationApproved) {
    fail(`Export gate was not a non-publication attempt: ${JSON.stringify(gate?.blockers ?? gate)}`);
  }

  const exported = await request(origin, `/api/projects/${VIDEO_ID}/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'final', includeShorts: false, includeThumbnails: false }),
  });
  if (exported.status !== 200) fail(`Export was not started. No retry. ${exported.status} ${exported.text}`);
  const jobId = JSON.parse(exported.text).jobId as string;
  let job: { status: string; error?: string; log?: string[] } = { status: 'running' };
  const deadline = Date.now() + 25 * 60 * 1000;
  while (job.status === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const polled = await request(origin, `/api/jobs/${encodeURIComponent(jobId)}`);
    try {
      job = JSON.parse(polled.text);
    } catch {
      fail(`Job poll was not JSON. No retry. ${polled.status} ${polled.text}`);
    }
  }
  if (job.status !== 'done') fail(`Render did not finish. No retry. ${job.status} ${job.error ?? ''}`, job);

  const mp4 = path.join(output, VIDEO_ID, 'long', `${VIDEO_ID}_long_final.mp4`);
  if (!fs.existsSync(mp4)) fail('The final MP4 was not written.');
  const mp4Bytes = fs.statSync(mp4).size;
  if (mp4Bytes <= 0) fail('The final MP4 is empty.');
  const media = probe(ffprobe, mp4);
  if (!media.hasVideo) fail('The final MP4 has no video stream.');
  if (!media.hasAudio) fail('The final MP4 has no audio stream.');
  if (media.width !== 1920 || media.height !== 1080) fail(`Rendered dimensions ${media.width}x${media.height} are not the expected 1920x1080.`);
  if (Math.abs(media.audioDurationSec - 4) > 1) fail(`Rendered audio duration ${media.audioDurationSec}s does not follow the 4s fixture.`);
  if (Math.abs(media.videoDurationSec - 4) > 1) fail(`Rendered video duration ${media.videoDurationSec}s does not follow the 4s fixture.`);
  if (createHash('sha256').update(fs.readFileSync(wav)).digest('hex') !== wavSha) fail('The original fixture WAV changed.');

  const evidence = {
    fixture: WAV_NAME,
    generator: 'ffmpeg lavfi sine=frequency=220:duration=4, 44100 Hz mono pcm_s16le',
    wavSha256: wavSha,
    wavDurationSec: wavProbe.audioDurationSec,
    spokenText: SPOKEN,
    productShots: projectInput.productShots,
    brollFiles: projectInput.brollFiles,
    voiceoverFile: projectInput.voiceoverFile,
    brandPreset: projectInput.brandPreset,
    speech: false,
    geminiRecording: false,
    decidedBy: DECIDED_BY,
    humanListeningApproval: false,
    publicationApproved: false,
    exportAttempts: 1,
    mp4Basename: path.basename(mp4),
    mp4Bytes,
    mp4Sha256: createHash('sha256').update(fs.readFileSync(mp4)).digest('hex'),
    width: media.width,
    height: media.height,
    audioDurationSec: media.audioDurationSec,
    videoDurationSec: media.videoDurationSec,
    sourceSha: process.env.GITHUB_SHA ?? null,
  };
  fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
  await app.close();
}

function form(wav: string): FormData {
  const body = new FormData();
  body.append('file', new Blob([fs.readFileSync(wav)], { type: 'audio/wav' }), WAV_NAME);
  body.append('scriptText', SPOKEN);
  body.append('sourceKind', 'authorized_external_synthesis');
  body.append('ownershipConfirmed', 'true');
  body.append('ownershipStatement', DECLARATION);
  body.append('speakerName', 'synthetic fixture speaker');
  body.append('engineName', 'fixture-engine');
  body.append('modelName', 'not-a-cloned-voice');
  body.append('voiceName', 'synthetic');
  return body;
}

async function request(origin: string, url: string, init?: RequestInit) {
  const response = await fetch(`${origin}${url}`, init);
  const text = await response.text();
  return { status: response.status, text };
}

function probe(ffprobe: string, file: string) {
  const result = spawnSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8' });
  if (result.status !== 0) fail(`ffprobe failed for ${path.basename(file)}`);
  const parsed = JSON.parse(result.stdout) as { streams?: Array<{ codec_type?: string; duration?: string; width?: number; height?: number }>; format?: { duration?: string } };
  const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio');
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
  return {
    hasAudio: Boolean(audio),
    hasVideo: Boolean(video),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    audioDurationSec: Number(audio?.duration ?? parsed.format?.duration ?? 0),
    videoDurationSec: Number(video?.duration ?? parsed.format?.duration ?? 0),
  };
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
