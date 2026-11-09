/**
 * VS2 TEST FIXTURES — Chatterbox voice-clone adapter and worker.
 *
 * Everything here is test infrastructure: a deterministic FAKE Python worker
 * (`tests/fixtures/chatterbox-fake-worker.py`, stdlib only — CI never imports
 * torch, never downloads a model) plus helpers that build an approved cloned
 * voice, a verified provisioning marker, a real reference WAV and a synthesis
 * request.
 *
 * All paths are repo-relative and live under `.stills/test-isolation/<suite>/`
 * (Git-ignored), so a suite can never touch repository source or a real
 * provisioning directory. `.stills/` is inside the adapter's approved roots for
 * references, scratch and outputs, which keeps the safety checks honest while
 * remaining fully isolated.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import type { AudioSynthesisRequest, AudioSynthesisError } from '../../packages/core/src/scenario/audio-synthesis-types.js';
import type {
  VoiceEngineIdentity,
  VoiceProfile,
  VoicePublicationProfile,
} from '../../packages/core/src/scenario/voice-types.js';
import { voiceAcousticIdentityOf } from '../../packages/core/src/scenario/voice-acoustic-identity.js';
import {
  ChatterboxDialogueSynthesizer,
  type ChatterboxSynthesizerOptions,
} from '../../packages/core/src/scenario/chatterbox-dialogue-synthesizer.js';
import { createIsolatedTmp } from './isolated-tmp.js';

export const REPO_ROOT = process.cwd();
export const FAKE_WORKER_REL = 'tests/fixtures/chatterbox-fake-worker.py';
export const FAKE_WORKER_ABS = path.join(REPO_ROOT, FAKE_WORKER_REL);
export const MULTILINGUAL_MODEL_ID = 'ResembleAI/chatterbox';
export const TURBO_MODEL_ID = 'ResembleAI/chatterbox-turbo';
/** Deterministic 40-hex "resolved revision" for fixtures (never a real one). */
export const FAKE_MODEL_REVISION = 'abcdef0123456789abcdef0123456789abcdef01';
export const FAKE_MODEL_REVISION_ALT = '0123456789abcdef0123456789abcdef01234567';

/** Python 3.11 required by the worker contract; CI provides it. */
export function resolveTestPython(): string {
  const candidates = [process.env.CHATTERBOX_PYTHON, 'python3.11', '/usr/bin/python3.11'].filter(
    (value): value is string => typeof value === 'string' && value.length > 0
  );
  for (const candidate of candidates) {
    try {
      const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', shell: false });
      if (result.status === 0 && /Python 3\.11\./.test(String(result.stdout))) return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(
    'Python 3.11 is required to run the deterministic Chatterbox worker fixture (see DEPENDENCIES.md).'
  );
}

export function sha256OfBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Deterministic non-silent 24 kHz mono PCM16 WAV (a "reference recording").
 *
 * `seconds` lets a suite ask for a recording that satisfies a real minimum
 * duration (the API refuses references shorter than one second, which is a
 * product rule and not a test artefact). The default keeps the historical,
 * text-derived length so the VS2 suites are byte-for-byte unchanged.
 */
export function referenceWavBuffer(text: string, seconds?: number): Buffer {
  const frameCount =
    typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
      ? Math.max(2400, Math.round(seconds * 24000))
      : Math.max(2400, text.length * 240);
  const dataBytes = frameCount * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(24000, 24);
  buffer.writeUInt32LE(24000 * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < frameCount; i += 1) {
    const sample = Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / 24000));
    buffer.writeInt16LE(sample, 44 + i * 2);
  }
  return buffer;
}

export interface ChatterboxTestWorkspace {
  /** Repo-relative isolated directory (`.stills/test-isolation/...`). */
  dir: string;
  /** Absolute path of the same directory. */
  abs: string;
  /** Repo-relative scratch directory handed to the adapter. */
  scratchDir: string;
  /** Repo-relative provisioning-marker path handed to the adapter. */
  markerPath: string;
  /** Repo-relative reference recording path. */
  referencePath: string;
  /** SHA-256 of the reference bytes on disk. */
  referenceSha256: string;
  /** Repo-relative output path used by default. */
  outputPath: string;
  /** Absolute path of the scratch directory (for leftover checks). */
  scratchAbs: string;
  /** Rewrite the provisioning marker (e.g. to change revision/contract). */
  writeMarker(patch?: Record<string, unknown>): void;
  /** Remove the provisioning marker entirely. */
  removeMarker(): void;
  /** Absolute path of the scratch directory receipts are written into. */
}

export function createChatterboxWorkspace(prefix: string): ChatterboxTestWorkspace {
  const dir = createIsolatedTmp(prefix);
  const abs = path.join(REPO_ROOT, dir);
  const scratchDir = `${dir}/.chatterbox/scratch`;
  const markerPath = `${dir}/.chatterbox/provisioned.json`;
  const referencePath = `${dir}/.voice-references/reference-take.wav`;
  const outputPath = `${dir}/audio/dialogue/clip-01.wav`;

  fs.mkdirSync(path.join(abs, '.voice-references'), { recursive: true });
  fs.mkdirSync(path.join(abs, '.chatterbox'), { recursive: true });
  fs.mkdirSync(path.join(abs, 'audio/dialogue'), { recursive: true });

  const referenceBytes = referenceWavBuffer('chatterbox-test-reference-recording');
  fs.writeFileSync(path.join(abs, '.voice-references/reference-take.wav'), referenceBytes);
  const referenceSha256 = sha256OfBuffer(referenceBytes);

  const workspace: ChatterboxTestWorkspace = {
    dir,
    abs,
    scratchDir,
    markerPath,
    referencePath,
    referenceSha256,
    outputPath,
    scratchAbs: path.join(abs, '.chatterbox/scratch'),
    writeMarker(patch: Record<string, unknown> = {}): void {
      const marker = {
        schemaVersion: 1,
        packageVersion: '0.1.7',
        engineContractId: 'chatterbox-multilingual-v3',
        modelId: MULTILINGUAL_MODEL_ID,
        modelRevision: FAKE_MODEL_REVISION,
        modelVariant: 'v3',
        pythonPath: resolveTestPython(),
        modelDir: '.chatterbox/models',
        provisionedAt: '2026-10-08T00:00:00.000Z',
        watermark: 'resemble-perth',
        notes: 'vs2 test fixture marker (never a real provisioning result)',
        ...patch,
      };
      fs.mkdirSync(path.dirname(path.join(REPO_ROOT, markerPath)), { recursive: true });
      fs.writeFileSync(path.join(REPO_ROOT, markerPath), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
    },
    removeMarker(): void {
      fs.rmSync(path.join(REPO_ROOT, markerPath), { force: true });
    },
  };

  workspace.writeMarker();
  return workspace;
}

/**
 * Receipts the fake worker writes next to its SCRATCH output, newest last.
 * A receipt therefore exists only when the worker actually ran for that call.
 */
export function readReceipts(ws: ChatterboxTestWorkspace): Record<string, unknown>[] {
  if (!fs.existsSync(ws.scratchAbs)) return [];
  return fs
    .readdirSync(ws.scratchAbs)
    .filter((name) => name.endsWith('.receipt.json'))
    .map((name) => path.join(ws.scratchAbs, name))
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs)
    .map((file) => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>);
}

/** Most recent receipt, or null when the worker never ran. */
export function latestReceipt(ws: ChatterboxTestWorkspace): Record<string, unknown> | null {
  const receipts = readReceipts(ws);
  return receipts.length > 0 ? receipts[receipts.length - 1] : null;
}

/** Remove every receipt so the next assertion can only see a new worker run. */
export function clearReceipts(ws: ChatterboxTestWorkspace): void {
  if (!fs.existsSync(ws.scratchAbs)) return;
  for (const name of fs.readdirSync(ws.scratchAbs)) {
    if (name.endsWith('.receipt.json')) fs.rmSync(path.join(ws.scratchAbs, name), { force: true });
  }
}

/** An approved first-party OWN VOICE profile cloning a reference recording. */
export function approvedClonedProfile(options: {
  referencePath: string;
  referenceSha256: string;
  modelId?: string;
  modelRevision?: string;
  engineFamily?: string;
  sourceKind?: 'cloned_reference_audio' | 'preset_model_voice';
  publicationPatch?: Record<string, unknown>;
}): VoiceProfile {
  const publication: VoicePublicationProfile = {
    schemaVersion: '1.0.0',
    engine: {
      engine: (options.engineFamily ?? 'chatterbox') as VoiceEngineIdentity['engine'],
      modelId: options.modelId ?? MULTILINGUAL_MODEL_ID,
      modelRevision: options.modelRevision ?? FAKE_MODEL_REVISION,
      runtimeId: 'chatterbox-tts',
      runtimeVersion: '0.1.7',
      requiresNetwork: false,
      localOnly: true,
    },
    acousticSource:
      options.sourceKind === 'preset_model_voice'
        ? { kind: 'preset_model_voice', presetVoiceId: 'af_heart', bundledBy: 'kokoro-js@1.2.1' }
        : {
            kind: 'cloned_reference_audio',
            referenceAudio: {
              path: options.referencePath,
              sha256: options.referenceSha256,
              durationSeconds: 4.2,
              sampleRate: 24000,
              channels: 1,
              container: 'wav',
              capturedAt: '2026-10-07T09:00:00Z',
              speakerLabel: 'operator own voice (fixture)',
            },
          },
    consent: {
      subject: 'recorded_speaker',
      authorizedSpeaker: 'Operator (own voice, first-party recording)',
      ownerConfirmed: true,
      confirmedBy: 'vs2-fixture-author',
      recordedAt: '2026-10-07T09:05:00Z',
      scope: ['internal_review', 'commercial_video_publication', 'synthetic_voice_cloning'],
      revoked: false,
      evidencePath: 'assets/voices/own-voice/consent-signed.md',
    },
    rights: {
      sourceProvider: 'first-party recording (operator-owned)',
      licenseName: 'First-party own-voice written release',
      evidenceUrl: 'https://rights.example.invalid/own-voice-release-vs2',
      evidenceKind: 'written_permission',
      accessedAt: '2026-10-07',
      commercialUse: 'permitted',
      commercialUseStatement:
        'I own this recording and grant this factory a perpetual right to synthesize and publish it commercially until I revoke this consent in writing.',
      localEvidencePath: 'assets/voices/own-voice/rights-release-vs2.md',
    },
    audition: {
      state: 'approved',
      approver: 'vs2-fixture-author',
      reviewedAt: '2026-10-07T10:00:00Z',
      reason: 'Reference take is clean and matches the intended tone.',
      samplePath: 'assets/voices/own-voice/audition-take.wav',
    },
    publicationState: 'approved',
    origin: 'authored_first_party',
    updatedAt: '2026-10-07T10:00:00Z',
  };

  const patched: VoicePublicationProfile = {
    ...publication,
    ...(options.publicationPatch ?? {}),
  } as VoicePublicationProfile;

  return {
    id: 'vp_vs2_test_own_voice',
    voiceSlot: 'voice_own_operator',
    displayName: 'Operator Own Voice (VS2 fixture)',
    description: 'Approved first-party own-voice clone used to exercise the Chatterbox adapter.',
    primaryLanguage: 'en-GB',
    languages: ['en-GB', 'en'],
    gender: 'neutral',
    roleHint: 'authority',
    synthesisHints: { rate: 'medium', pitch: 'medium', style: 'confident' },
    enabled: true,
    version: '1.0.0',
    createdAt: '2026-10-07T08:00:00Z',
    publication: patched,
  };
}

/** Deterministic synthesis request for one clip, with the real acoustic identity. */
export function requestFor(
  profile: VoiceProfile,
  targetPath: string,
  overrides: Partial<AudioSynthesisRequest> = {}
): AudioSynthesisRequest {
  return {
    scenarioId: 'scenario-vs2-fixture',
    sceneId: 'sc-01-hook',
    turnId: 'turn-01',
    clipId: 'clip_sc-01-hook_turn-01',
    speakerId: 'sarah',
    speakerName: 'Sarah',
    voiceSlot: profile.voiceSlot,
    voiceProfileId: profile.id,
    voiceProfile: profile,
    voiceAcousticIdentity: voiceAcousticIdentityOf(profile),
    language: 'en-GB',
    spokenText: 'The numbers do not lie — the audit trail is complete.',
    delivery: { tone: 'confident', pace: 'measured' },
    synthesisHints: profile.synthesisHints,
    targetPath,
    audioFormat: { container: 'wav', sampleRate: 48000, channels: 1, codec: 'pcm_s16le', bitDepth: 16 },
    sceneIndex: 0,
    turnIndex: 0,
    globalTurnIndex: 0,
    ...overrides,
  };
}

/** Adapter wired to the deterministic fake worker inside an isolated workspace. */
export function makeAdapter(
  workspace: ChatterboxTestWorkspace,
  overrides: ChatterboxSynthesizerOptions = {}
): ChatterboxDialogueSynthesizer {
  return new ChatterboxDialogueSynthesizer({
    engineContractId: 'chatterbox-multilingual-v3',
    pythonPath: resolveTestPython(),
    workerScriptPath: FAKE_WORKER_ABS,
    markerPath: workspace.markerPath,
    scratchDir: workspace.scratchDir,
    device: 'cpu',
    allowCpu: true,
    timeoutMs: 30_000,
    detectGpu: () => ({ available: false }),
    ...overrides,
  });
}

/** Await a synthesis call and return the structured error it must throw. */
export async function captureSynthesisError(
  run: () => Promise<unknown>
): Promise<AudioSynthesisError> {
  try {
    await run();
  } catch (e) {
    return e as AudioSynthesisError;
  }
  throw new Error('Expected synthesis to fail closed, but it succeeded.');
}
