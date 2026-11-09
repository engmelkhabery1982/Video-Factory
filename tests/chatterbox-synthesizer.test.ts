/**
 * VS2 FOCUSED TESTS — Chatterbox voice-clone synthesizer adapter.
 *
 * Everything runs against `tests/fixtures/chatterbox-fake-worker.py`: a real
 * Python 3.11 subprocess speaking the real versioned protocol, with ZERO model
 * download, ZERO torch import and ZERO network. The suite proves:
 *
 *   - request mapping is byte-exact (text, language, engine, model, revision,
 *     reference hash, settings, device, scratch target);
 *   - the VS1 publication gate blocks BEFORE any file exists;
 *   - reference integrity (recomputed SHA-256) blocks a swapped recording;
 *   - path safety rejects traversal, absolute paths, protected source paths and
 *     symlink escapes;
 *   - there is no silent fallback to Kokoro, to another Chatterbox model or to
 *     a preset voice;
 *   - every worker failure mode fails closed with a distinct structured code
 *     (timeout, non-zero exit, invalid JSON, wrong manifest version, empty /
 *     silent / corrupt audio, missing watermark, GPU errors, revision
 *     mismatches);
 *   - output is canonical 48 kHz mono PCM16 and the raw scratch is removed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  approvedClonedProfile,
  captureSynthesisError,
  createChatterboxWorkspace,
  FAKE_MODEL_REVISION,
  FAKE_MODEL_REVISION_ALT,
  FAKE_WORKER_ABS,
  MULTILINGUAL_MODEL_ID,
  REPO_ROOT,
  TURBO_MODEL_ID,
  clearReceipts,
  latestReceipt,
  makeAdapter,
  readReceipts,
  referenceWavBuffer,
  requestFor,
  sha256OfBuffer,
  type ChatterboxTestWorkspace,
} from './helpers/chatterbox-worker-fixtures.js';
import { cleanupIsolatedTmp } from './helpers/isolated-tmp.js';
import { WavHeaderProbe, validateCanonicalAudio } from '../packages/core/src/scenario/audio-probe.js';
import { ChatterboxDialogueSynthesizer } from '../packages/core/src/scenario/chatterbox-dialogue-synthesizer.js';
import { synthesisEngineIdentityOf } from '../packages/core/src/scenario/synthesize-dialogue.js';
import type { AudioSynthesisError } from '../packages/core/src/scenario/audio-synthesis-types.js';
import type { VoiceProfile } from '../packages/core/src/scenario/voice-types.js';

const probe = new WavHeaderProbe();

function failingAdapter(ws: ChatterboxTestWorkspace, mode: string, overrides = {}) {
  return makeAdapter(ws, { workerEnv: { FAKE_CHATTERBOX_MODE: mode }, ...overrides });
}

function scratchFiles(ws: ChatterboxTestWorkspace): string[] {
  if (!fs.existsSync(ws.scratchAbs)) return [];
  return fs.readdirSync(ws.scratchAbs);
}

describe('VS2 Chatterbox adapter — happy path, mapping and canonical output', () => {
  const ws = createChatterboxWorkspace('cb-synth-ok');
  const profile = approvedClonedProfile({
    referencePath: ws.referencePath,
    referenceSha256: ws.referenceSha256,
  });

  beforeAll(() => {
    ws.writeMarker();
  });
  afterAll(() => cleanupIsolatedTmp(ws.dir));

  it('synthesizes to the deterministic target path and reports success', async () => {
    const adapter = makeAdapter(ws);
    const request = requestFor(profile, ws.outputPath);
    const result = await adapter.synthesize(request);

    expect(result.success).toBe(true);
    expect(result.outputPath).toBe(ws.outputPath);
    expect(result.spokenText).toBe(request.spokenText);
    expect(result.clipId).toBe(request.clipId);
    expect(result.voiceProfileId).toBe(profile.id);
    expect(result.metadata?.engine).toBe('chatterbox-tts');
    expect(result.metadata?.engineVersion).toBe('0.1.7');
    expect(result.durationSeconds).toBeGreaterThan(0);
    expect(result.fileSizeBytes).toBeGreaterThan(44);
    expect(fs.existsSync(path.join(REPO_ROOT, ws.outputPath))).toBe(true);
  });

  it('normalizes the 24 kHz engine output into canonical 48 kHz mono PCM16', async () => {
    const metadata = probe.probeSync(ws.outputPath);
    const validation = validateCanonicalAudio(metadata);
    expect(validation.isCanonical).toBe(true);
    expect(metadata.sampleRate).toBe(48000);
    expect(metadata.channels).toBe(1);
    expect(metadata.bitDepth).toBe(16);
    expect(metadata.codec).toBe('pcm_s16le');
  });

  it('maps the request one-to-one into the worker manifest', async () => {
    clearReceipts(ws);
    await makeAdapter(ws).synthesize(requestFor(profile, `${ws.dir}/audio/dialogue/clip-map.wav`));
    const receipt = latestReceipt(ws);
    expect(receipt).not.toBeNull();
    expect(receipt?.engineContractId).toBe('chatterbox-multilingual-v3');
    expect(receipt?.modelId).toBe(MULTILINGUAL_MODEL_ID);
    expect(receipt?.modelRevision).toBe(FAKE_MODEL_REVISION);
    expect(receipt?.device).toBe('cpu');
    expect(receipt?.modelDir).toBe('.chatterbox/models');
    expect(String(receipt?.outputPath)).toContain('.chatterbox/scratch/');
    expect(String(receipt?.outputPath)).not.toContain(ws.outputPath);
  });

  it('preserves the spoken text byte-for-byte, including punctuation and unicode', async () => {
    const text = 'Stop — “the audit trail” is complete… ¿Quién lo verificó? 42 %.';
    const outputPath = `${ws.dir}/audio/dialogue/clip-exact-text.wav`;
    const adapter = makeAdapter(ws);
    clearReceipts(ws);
    const result = await adapter.synthesize(requestFor(profile, outputPath, { spokenText: text }));
    const receipt = latestReceipt(ws);
    expect(result.spokenText).toBe(text);
    expect(receipt?.text).toBe(text);
    expect(Buffer.from(String(receipt?.text), 'utf8').equals(Buffer.from(text, 'utf8'))).toBe(true);
  });

  it('maps BCP-47 tags onto Chatterbox language ids (en-GB -> en, ar-SA -> ar)', async () => {
    const adapter = makeAdapter(ws);
    const english = `${ws.dir}/audio/dialogue/clip-lang-en.wav`;
    clearReceipts(ws);
    await adapter.synthesize(requestFor(profile, english, { language: 'en-GB' }));
    expect(latestReceipt(ws)?.languageId).toBe('en');

    const arabic = `${ws.dir}/audio/dialogue/clip-lang-ar.wav`;
    clearReceipts(ws);
    await adapter.synthesize(requestFor(profile, arabic, { language: 'ar-SA' }));
    expect(latestReceipt(ws)?.languageId).toBe('ar');
  });

  it('re-verifies the reference recording and forwards its recomputed SHA-256', async () => {
    const outputPath = `${ws.dir}/audio/dialogue/clip-ref-hash.wav`;
    clearReceipts(ws);
    await makeAdapter(ws).synthesize(requestFor(profile, outputPath));
    const receipt = latestReceipt(ws);
    const onDisk = sha256OfBuffer(
      fs.readFileSync(path.join(REPO_ROOT, ws.referencePath))
    );
    expect(receipt?.referenceAudio).toMatchObject({
      path: ws.referencePath,
      sha256: ws.referenceSha256,
    });
    expect(onDisk).toBe(ws.referenceSha256);
  });

  it('sends the effective settings digest and passes declared settings through', async () => {
    const adapter = makeAdapter(ws, { voiceSettings: { exaggeration: 0.7, cfgWeight: 0.3, minP: 0.05 } });
    const outputPath = `${ws.dir}/audio/dialogue/clip-settings.wav`;
    clearReceipts(ws);
    await adapter.synthesize(requestFor(profile, outputPath));
    const receipt = latestReceipt(ws);
    expect(receipt?.settings).toMatchObject({ exaggeration: 0.7, cfgWeight: 0.3, minP: 0.05 });
    expect(receipt?.settingsSupported).toBe(true);
    const identity = synthesisEngineIdentityOf(adapter);
    expect(identity.modelId).toBe(MULTILINGUAL_MODEL_ID);
    expect(identity.modelRevision).toBe(FAKE_MODEL_REVISION);
    expect(identity.settingsDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('removes the raw scratch WAV after a successful run (receipt may stay)', async () => {
    const outputPath = `${ws.dir}/audio/dialogue/clip-scratch-clean.wav`;
    await makeAdapter(ws).synthesize(requestFor(profile, outputPath));
    const leftovers = scratchFiles(ws).filter((name) => name.endsWith('.wav'));
    expect(leftovers).toEqual([]);
  });

  it('reports availability without creating files or loading the model', () => {
    const adapter = makeAdapter(ws);
    expect(adapter.isAvailable()).toBe(true);
    expect(adapter.requiresNetwork).toBe(false);
    expect(adapter.isLocal).toBe(true);
  });
});

describe('VS2 Chatterbox adapter — publication gate + reference integrity block first', () => {
  const ws = createChatterboxWorkspace('cb-synth-gate');

  beforeAll(() => {
    ws.writeMarker();
  });
  afterAll(() => cleanupIsolatedTmp(ws.dir));

  it('blocks a revoked consent before any file or worker process exists', async () => {
    const profile = approvedClonedProfile({
      referencePath: ws.referencePath,
      referenceSha256: ws.referenceSha256,
      publicationPatch: {
        consent: {
          subject: 'recorded_speaker',
          authorizedSpeaker: 'Operator',
          ownerConfirmed: true,
          confirmedBy: 'vs2-fixture-author',
          recordedAt: '2026-10-07T09:05:00Z',
          scope: ['commercial_video_publication', 'synthetic_voice_cloning'],
          revoked: true,
          revokedAt: '2026-10-07T12:00:00Z',
          revocationReason: 'Withdrawn by the speaker.',
          evidencePath: 'assets/voices/own-voice/consent-signed.md',
        },
      },
    });
    const outputPath = `${ws.dir}/audio/dialogue/clip-revoked.wav`;
    const error = await captureSynthesisError(() => makeAdapter(ws).synthesize(requestFor(profile, outputPath)));

    expect(error.code).toBe('VOICE_PUBLICATION_BLOCKED');
    const findings = (error.details?.findings ?? []) as Array<{ code: string }>;
    expect(findings.map((f) => f.code)).toContain('CONSENT_REVOKED');
    expect(fs.existsSync(path.join(REPO_ROOT, outputPath))).toBe(false);
    expect(readReceipts(ws)).toEqual([]);
    expect(scratchFiles(ws)).toEqual([]);
  });

  it('blocks silence about commercial use instead of inferring permission', async () => {
    const profile = approvedClonedProfile({
      referencePath: ws.referencePath,
      referenceSha256: ws.referenceSha256,
      publicationPatch: {
        rights: {
          sourceProvider: 'first-party recording (operator-owned)',
          licenseName: 'First-party own-voice written release',
          evidenceUrl: 'https://rights.example.invalid/own-voice-release-vs2',
          evidenceKind: 'written_permission',
          accessedAt: '2026-10-07',
          commercialUse: 'not_stated',
        },
      },
    });
    const outputPath = `${ws.dir}/audio/dialogue/clip-rights-silent.wav`;
    const error = await captureSynthesisError(() => makeAdapter(ws).synthesize(requestFor(profile, outputPath)));

    expect(error.code).toBe('VOICE_PUBLICATION_BLOCKED');
    const findings = (error.details?.findings ?? []) as Array<{ code: string }>;
    expect(findings.map((f) => f.code)).toContain('COMMERCIAL_USE_NOT_ESTABLISHED');
    expect(fs.existsSync(path.join(REPO_ROOT, outputPath))).toBe(false);
    expect(readReceipts(ws)).toEqual([]);
  });

  it('blocks a swapped reference recording whose hash no longer matches', async () => {
    const profile = approvedClonedProfile({
      referencePath: ws.referencePath,
      referenceSha256: ws.referenceSha256,
    });
    const referenceAbs = path.join(REPO_ROOT, ws.referencePath);
    const original = fs.readFileSync(referenceAbs);
    fs.writeFileSync(referenceAbs, referenceWavBuffer('a different recording entirely'));

    try {
      const outputPath = `${ws.dir}/audio/dialogue/clip-swapped-ref.wav`;
      const error = await captureSynthesisError(() =>
        makeAdapter(ws).synthesize(requestFor(profile, outputPath))
      );
      expect(error.code).toBe('CHATTERBOX_REFERENCE_HASH_MISMATCH');
      expect(fs.existsSync(path.join(REPO_ROOT, outputPath))).toBe(false);
      expect(readReceipts(ws)).toEqual([]);
    } finally {
      fs.writeFileSync(referenceAbs, original);
    }
  });

  it('blocks when the approved reference recording is missing', async () => {
    const profile = approvedClonedProfile({
      referencePath: `${ws.dir}/.voice-references/never-recorded.wav`,
      referenceSha256: ws.referenceSha256,
    });
    const outputPath = `${ws.dir}/audio/dialogue/clip-ref-missing.wav`;
    const error = await captureSynthesisError(() => makeAdapter(ws).synthesize(requestFor(profile, outputPath)));
    expect(error.code).toBe('CHATTERBOX_REFERENCE_MISSING');
    expect(readReceipts(ws)).toEqual([]);
  });
});

describe('VS2 Chatterbox adapter — no silent fallback to another voice or engine', () => {
  const ws = createChatterboxWorkspace('cb-synth-fallback');

  beforeAll(() => {
    ws.writeMarker();
  });
  afterAll(() => cleanupIsolatedTmp(ws.dir));

  it('refuses a Kokoro-declared voice instead of silently producing it with Chatterbox', async () => {
    const profile = approvedClonedProfile({
      referencePath: ws.referencePath,
      referenceSha256: ws.referenceSha256,
      engineFamily: 'kokoro',
    });
    const outputPath = `${ws.dir}/audio/dialogue/clip-kokoro.wav`;
    const error = await captureSynthesisError(() => makeAdapter(ws).synthesize(requestFor(profile, outputPath)));
    expect(error.code).toBe('CHATTERBOX_VOICE_FALLBACK_BLOCKED');
    expect(error.details?.blockedCodes).toContain('CHATTERBOX-VOICE-ENGINE_FAMILY_MISMATCH');
    expect(fs.existsSync(path.join(REPO_ROOT, outputPath))).toBe(false);
    expect(readReceipts(ws)).toEqual([]);
  });

  it('refuses a voice that declares another Chatterbox model contract', async () => {
    const profile = approvedClonedProfile({
      referencePath: ws.referencePath,
      referenceSha256: ws.referenceSha256,
      modelId: TURBO_MODEL_ID,
    });
    const outputPath = `${ws.dir}/audio/dialogue/clip-other-model.wav`;
    const error = await captureSynthesisError(() => makeAdapter(ws).synthesize(requestFor(profile, outputPath)));
    expect(error.code).toBe('CHATTERBOX_VOICE_FALLBACK_BLOCKED');
    expect(error.details?.blockedCodes).toContain('CHATTERBOX-VOICE-MODEL_CONTRACT_MISMATCH');
  });

  it('refuses a preset-voice (non-cloned) profile instead of faking a clone', async () => {
    const profile = approvedClonedProfile({
      referencePath: ws.referencePath,
      referenceSha256: ws.referenceSha256,
      sourceKind: 'preset_model_voice',
      publicationPatch: {
        engine: {
          engine: 'chatterbox',
          modelId: MULTILINGUAL_MODEL_ID,
          modelRevision: FAKE_MODEL_REVISION,
          runtimeId: 'chatterbox-tts',
          runtimeVersion: '0.1.7',
        },
      },
    });
    const outputPath = `${ws.dir}/audio/dialogue/clip-preset.wav`;
    const error = await captureSynthesisError(() => makeAdapter(ws).synthesize(requestFor(profile, outputPath)));
    expect(error.code).toBe('CHATTERBOX_VOICE_FALLBACK_BLOCKED');
    expect(error.details?.blockedCodes).toContain('CHATTERBOX-VOICE-NO_CLONED_REFERENCE');
  });

  it('refuses a voice profile with no publication record at all', async () => {
    const bare = approvedClonedProfile({
      referencePath: ws.referencePath,
      referenceSha256: ws.referenceSha256,
    });
    const profile = { ...bare } as VoiceProfile;
    delete (profile as { publication?: unknown }).publication;
    const outputPath = `${ws.dir}/audio/dialogue/clip-no-publication.wav`;
    const error = await captureSynthesisError(() => makeAdapter(ws).synthesize(requestFor(profile, outputPath)));
    expect(['CHATTERBOX_VOICE_FALLBACK_BLOCKED', 'VOICE_PUBLICATION_BLOCKED']).toContain(error.code);
    expect(readReceipts(ws)).toEqual([]);
  });

  it('refuses a different declared runtime version rather than pretending to run it', async () => {
    const profile = approvedClonedProfile({
      referencePath: ws.referencePath,
      referenceSha256: ws.referenceSha256,
      publicationPatch: {
        engine: {
          engine: 'chatterbox',
          modelId: MULTILINGUAL_MODEL_ID,
          modelRevision: FAKE_MODEL_REVISION,
          runtimeId: 'chatterbox-tts',
          runtimeVersion: '0.0.1',
        },
      },
    });
    const outputPath = `${ws.dir}/audio/dialogue/clip-runtime-version.wav`;
    const error = await captureSynthesisError(() => makeAdapter(ws).synthesize(requestFor(profile, outputPath)));
    expect(error.code).toBe('CHATTERBOX_VOICE_FALLBACK_BLOCKED');
    expect(error.details?.blockedCodes).toContain('CHATTERBOX-VOICE-RUNTIME_VERSION_MISMATCH');
  });
});

describe('VS2 Chatterbox adapter — path safety fails closed', () => {
  const ws = createChatterboxWorkspace('cb-synth-paths');
  const profile = approvedClonedProfile({
    referencePath: ws.referencePath,
    referenceSha256: ws.referenceSha256,
  });

  beforeAll(() => {
    ws.writeMarker();
  });
  afterAll(() => cleanupIsolatedTmp(ws.dir));

  function profileWithReference(referencePath: string): VoiceProfile {
    return approvedClonedProfile({ referencePath, referenceSha256: ws.referenceSha256 });
  }

  it('rejects traversal in the reference path (VS1 gate first, adapter path safety as the second layer)', async () => {
    const error = await captureSynthesisError(() =>
      makeAdapter(ws).synthesize(
        requestFor(profileWithReference(`${ws.dir}/../escape.wav`), `${ws.dir}/audio/dialogue/clip-1.wav`)
      )
    );
    expect(error.code).toBe('VOICE_PUBLICATION_BLOCKED');
    const findings = (error.details?.findings ?? []) as Array<{ code: string }>;
    expect(findings.map((f) => f.code)).toContain('UNSAFE_REFERENCE_PATH');
    expect(readReceipts(ws)).toEqual([]);
  });

  it('rejects an absolute reference path in a portable profile (gate first)', async () => {
    const error = await captureSynthesisError(() =>
      makeAdapter(ws).synthesize(
        requestFor(profileWithReference('/etc/passwd'), `${ws.dir}/audio/dialogue/clip-2.wav`)
      )
    );
    expect(error.code).toBe('VOICE_PUBLICATION_BLOCKED');
    const findings = (error.details?.findings ?? []) as Array<{ code: string }>;
    expect(findings.map((f) => f.code)).toContain('UNSAFE_REFERENCE_PATH');
  });

  it('rejects a reference path outside the approved roots', async () => {
    const error = await captureSynthesisError(() =>
      makeAdapter(ws).synthesize(
        requestFor(profileWithReference('data/private/recording.wav'), `${ws.dir}/audio/dialogue/clip-3.wav`)
      )
    );
    expect(error.code).toBe('UNSAFE_PATH');
    expect(error.details?.pathSafetyCode).toBe('OUTSIDE_APPROVED_ROOTS');
  });

  it('rejects an absolute output target path', async () => {
    const error = await captureSynthesisError(() =>
      makeAdapter(ws).synthesize(requestFor(profile, '/tmp/cb-out.wav'))
    );
    expect(error.code).toBe('UNSAFE_PATH');
    expect(error.details?.pathSafetyCode).toBe('ABSOLUTE_PATH');
    expect(error.details?.pathRole).toBe('output');
  });

  it('rejects traversal in the output target path', async () => {
    const error = await captureSynthesisError(() =>
      makeAdapter(ws).synthesize(requestFor(profile, `${ws.dir}/audio/../../escape.wav`))
    );
    expect(error.code).toBe('UNSAFE_PATH');
    expect(error.details?.pathSafetyCode).toBe('TRAVERSAL');
  });

  it('refuses to write into repository source, even inside an approved-looking path', async () => {
    const error = await captureSynthesisError(() =>
      makeAdapter(ws).synthesize(requestFor(profile, 'packages/core/src/scenario/evil.wav'))
    );
    expect(error.code).toBe('UNSAFE_PATH');
    expect(error.details?.pathSafetyCode).toBe('PROTECTED_SOURCE_PATH');
  });

  it('detects a symlinked directory that escapes the approved root', async () => {
    const linkRel = `${ws.dir}/escape-link`;
    const linkAbs = path.join(REPO_ROOT, linkRel);
    fs.mkdirSync(path.dirname(linkAbs), { recursive: true });
    try {
      fs.symlinkSync('/tmp', linkAbs, 'dir');
    } catch {
      return; // symlinks unsupported on this filesystem: covered where supported
    }
    const error = await captureSynthesisError(() =>
      makeAdapter(ws).synthesize(
        requestFor(profileWithReference(`${linkRel}/reference.wav`), `${ws.dir}/audio/dialogue/clip-4.wav`)
      )
    );
    expect(error.code).toBe('UNSAFE_PATH');
    expect(error.details?.pathSafetyCode).toBe('SYMLINK_ESCAPE');
  });

  it('never leaks the personal reference recording name in diagnostics', async () => {
    const profileLocal = approvedClonedProfile({
      referencePath: `${ws.dir}/.voice-references/never-recorded.wav`,
      referenceSha256: ws.referenceSha256,
    });
    const error = await captureSynthesisError(() =>
      makeAdapter(ws).synthesize(requestFor(profileLocal, `${ws.dir}/audio/dialogue/clip-5.wav`))
    );
    expect(error.message).not.toContain('never-recorded.wav');
    expect(error.message).toContain('<reference:');
    expect(error.message).not.toContain(REPO_ROOT);
  });
});

describe('VS2 Chatterbox adapter — environment, provisioning and device policy', () => {
  const ws = createChatterboxWorkspace('cb-synth-env');
  const profile = approvedClonedProfile({
    referencePath: ws.referencePath,
    referenceSha256: ws.referenceSha256,
  });

  afterAll(() => cleanupIsolatedTmp(ws.dir));

  it('fails closed with an actionable code when the provisioning marker is missing', async () => {
    ws.removeMarker();
    try {
      const outputPath = `${ws.dir}/audio/dialogue/clip-no-marker.wav`;
      const error = await captureSynthesisError(() => makeAdapter(ws).synthesize(requestFor(profile, outputPath)));
      expect(error.code).toBe('CHATTERBOX_MODEL_MISSING');
      expect(String(error.details?.remediation)).toContain('provision:voice-clone');
      expect(readReceipts(ws)).toEqual([]);
    } finally {
      ws.writeMarker();
    }
  });

  it('reports unavailable (never throws, never downloads) when not provisioned', () => {
    ws.removeMarker();
    try {
      expect(makeAdapter(ws).isAvailable()).toBe(false);
    } finally {
      ws.writeMarker();
    }
  });

  it('fails closed when the pinned model revision differs from the provisioned one', async () => {
    ws.writeMarker({ modelRevision: FAKE_MODEL_REVISION_ALT });
    try {
      const outputPath = `${ws.dir}/audio/dialogue/clip-rev-pin.wav`;
      const error = await captureSynthesisError(() =>
        makeAdapter(ws, { modelRevision: FAKE_MODEL_REVISION }).synthesize(requestFor(profile, outputPath))
      );
      expect(error.code).toBe('CHATTERBOX_MODEL_REVISION_MISMATCH');
      expect(error.details?.category).toBe('PINNED_REVISION_MISMATCH');
    } finally {
      ws.writeMarker();
    }
  });

  it('fails closed when a voice declares another model revision than the provisioned one', async () => {
    const profileAlt = approvedClonedProfile({
      referencePath: ws.referencePath,
      referenceSha256: ws.referenceSha256,
      modelRevision: FAKE_MODEL_REVISION_ALT,
    });
    const outputPath = `${ws.dir}/audio/dialogue/clip-voice-rev.wav`;
    const error = await captureSynthesisError(() => makeAdapter(ws).synthesize(requestFor(profileAlt, outputPath)));
    expect(error.code).toBe('CHATTERBOX_MODEL_REVISION_MISMATCH');
    expect(error.details?.scope).toBe('voice-profile');
  });

  it('fails closed when the provisioned marker belongs to another engine contract', async () => {
    ws.writeMarker({ engineContractId: 'chatterbox-turbo', modelId: TURBO_MODEL_ID });
    try {
      const outputPath = `${ws.dir}/audio/dialogue/clip-contract.wav`;
      const error = await captureSynthesisError(() => makeAdapter(ws).synthesize(requestFor(profile, outputPath)));
      expect(error.code).toBe('CHATTERBOX_MODEL_REVISION_MISMATCH');
      expect(error.details?.category).toBe('MODEL_CONTRACT_MISMATCH');
    } finally {
      ws.writeMarker();
    }
  });

  it('fails closed when the Python 3.11 interpreter is missing', async () => {
    const outputPath = `${ws.dir}/audio/dialogue/clip-no-python.wav`;
    const error = await captureSynthesisError(() =>
      makeAdapter(ws, { pythonPath: '/nonexistent/python3.11' }).synthesize(requestFor(profile, outputPath))
    );
    expect(error.code).toBe('CHATTERBOX_PYTHON_MISSING');
  });

  it('fails closed when the worker script is missing from the repository', async () => {
    const outputPath = `${ws.dir}/audio/dialogue/clip-no-worker.wav`;
    const error = await captureSynthesisError(() =>
      makeAdapter(ws, { workerScriptPath: 'tools/chatterbox/does-not-exist.py' }).synthesize(
        requestFor(profile, outputPath)
      )
    );
    expect(error.code).toBe('CHATTERBOX_WORKER_MISSING');
  });

  it('requires CUDA by default and refuses to guess when no GPU exists', async () => {
    const outputPath = `${ws.dir}/audio/dialogue/clip-cuda.wav`;
    const error = await captureSynthesisError(() =>
      makeAdapter(ws, { device: 'cuda', detectGpu: () => ({ available: false }) }).synthesize(
        requestFor(profile, outputPath)
      )
    );
    expect(error.code).toBe('CHATTERBOX_CUDA_REQUIRED');
    expect(error.details?.category).toBe('NO_NVIDIA_GPU_DETECTED');
    expect(readReceipts(ws)).toEqual([]);
  });

  it('refuses the unverified CPU path unless it is explicitly approved', async () => {
    const outputPath = `${ws.dir}/audio/dialogue/clip-cpu.wav`;
    const error = await captureSynthesisError(() =>
      makeAdapter(ws, { device: 'cpu', allowCpu: false }).synthesize(requestFor(profile, outputPath))
    );
    expect(error.code).toBe('CHATTERBOX_CUDA_REQUIRED');
    expect(error.details?.category).toBe('CPU_PATH_NOT_APPROVED');
  });

  it('rejects unsupported languages for the selected contract', async () => {
    const outputPath = `${ws.dir}/audio/dialogue/clip-lang.wav`;
    const error = await captureSynthesisError(() =>
      makeAdapter(ws).synthesize(requestFor(profile, outputPath, { language: 'id-ID' }))
    );
    expect(error.code).toBe('CHATTERBOX_UNSUPPORTED_LANGUAGE');
    expect(error.details?.language).toBe('id-ID');
  });

  it('refuses unsupported voice settings on the turbo contract at construction time', () => {
    expect(
      () =>
        new ChatterboxDialogueSynthesizer({
          engineContractId: 'chatterbox-turbo',
          pythonPath: 'python3.11',
          workerScriptPath: FAKE_WORKER_ABS,
          markerPath: ws.markerPath,
          scratchDir: ws.scratchDir,
          device: 'cpu',
          allowCpu: true,
          voiceSettings: { exaggeration: 0.9 },
        })
    ).toThrowError(/does not support voice settings/);
  });

  it('rejects invalid settings instead of silently clamping them', () => {
    expect(() => makeAdapter(ws, { voiceSettings: { exaggeration: 7 } })).toThrowError(/exaggeration/);
    expect(() => makeAdapter(ws, { voiceSettings: { cfgWeight: -1 } })).toThrowError(/cfgWeight/);
  });
});

describe('VS2 Chatterbox adapter — worker process failures fail closed', () => {
  const ws = createChatterboxWorkspace('cb-synth-worker');
  const profile = approvedClonedProfile({
    referencePath: ws.referencePath,
    referenceSha256: ws.referenceSha256,
  });

  beforeAll(() => {
    ws.writeMarker();
  });
  afterAll(() => cleanupIsolatedTmp(ws.dir));

  async function failureFrom(mode: string, overrides = {}): Promise<AudioSynthesisError> {
    const outputPath = `${ws.dir}/audio/dialogue/clip-${mode.replace(/[^a-z0-9]/gi, '-')}.wav`;
    const error = await captureSynthesisError(() =>
      failingAdapter(ws, mode, overrides).synthesize(requestFor(profile, outputPath))
    );
    expect(fs.existsSync(path.join(REPO_ROOT, outputPath))).toBe(false);
    return error;
  }

  it('terminates a hung worker with the bounded timeout', async () => {
    const started = Date.now();
    const error = await failureFrom('timeout', { timeoutMs: 500 });
    const elapsed = Date.now() - started;
    expect(error.code).toBe('CHATTERBOX_WORKER_TIMEOUT');
    expect(elapsed).toBeLessThan(15_000);
  }, 20_000);

  it('fails closed on a non-zero worker exit', async () => {
    const error = await failureFrom('nonzero');
    expect(error.code).toBe('CHATTERBOX_WORKER_EXIT_NONZERO');
    expect(error.details?.exitCode).toBe(7);
  });

  it('fails closed on invalid JSON on stdout', async () => {
    const error = await failureFrom('invalid_json');
    expect(error.code).toBe('CHATTERBOX_INVALID_JSON');
  });

  it('fails closed on a foreign response schema (manifest version mismatch)', async () => {
    const error = await failureFrom('bad_schema');
    expect(error.code).toBe('CHATTERBOX_MANIFEST_VERSION_MISMATCH');
  });

  it('fails closed on an unexpected protocol version', async () => {
    const error = await failureFrom('bad_protocol');
    expect(error.code).toBe('CHATTERBOX_MANIFEST_VERSION_MISMATCH');
  });

  it('fails closed when stdout exceeds the bounded capture', async () => {
    const error = await failureFrom('overflow');
    expect(error.code).toBe('CHATTERBOX_WORKER_FAILED');
    expect(error.details?.category).toBe('WORKER_OUTPUT_OVERFLOW');
  }, 20_000);

  it('fails closed on an empty output file', async () => {
    const error = await failureFrom('empty');
    expect(error.code).toBe('CHATTERBOX_EMPTY_OUTPUT');
  });

  it('fails closed when the worker claims success but writes nothing', async () => {
    const error = await failureFrom('missing_output');
    expect(error.code).toBe('CHATTERBOX_EMPTY_OUTPUT');
    expect(error.details?.category).toBe('SCRATCH_OUTPUT_MISSING');
  });

  it('fails closed on a silent (all-zero) waveform', async () => {
    const error = await failureFrom('silent');
    expect(error.code).toBe('CHATTERBOX_SILENT_OUTPUT');
  });

  it('fails closed on a corrupt WAV', async () => {
    const error = await failureFrom('garbage_wav');
    expect(error.code).toBe('CHATTERBOX_INVALID_WAV');
  });

  it('fails closed when the reported hash does not match the bytes on disk', async () => {
    const error = await failureFrom('wrong_hash');
    expect(error.code).toBe('CHATTERBOX_INVALID_WAV');
    expect(error.details?.category).toBe('RAW_INTEGRITY_MISMATCH');
  });

  it('fails closed when the worker reports an unmarked success', async () => {
    const error = await failureFrom('no_watermark');
    expect(error.code).toBe('CHATTERBOX_WATERMARK_MISSING');
    expect(error.details?.category).toBe('WATERMARK_NOT_APPLIED');
  });

  it('fails closed with the watermark code when the worker cannot apply the watermark', async () => {
    const error = await failureFrom('error:WATERMARK_MISSING');
    expect(error.code).toBe('CHATTERBOX_WATERMARK_MISSING');
  });

  it('fails closed when the worker reports a different model or revision', async () => {
    const error = await failureFrom('wrong_model');
    expect(error.code).toBe('CHATTERBOX_MODEL_REVISION_MISMATCH');
    expect(error.details?.category).toBe('WORKER_ENGINE_IDENTITY_MISMATCH');
  });

  it('maps worker CUDA initialisation failure onto its own blocking code', async () => {
    const error = await failureFrom('error:CUDA_INIT_FAILED');
    expect(error.code).toBe('CHATTERBOX_CUDA_INIT_FAILED');
  });

  it('maps worker GPU out-of-memory onto its own blocking code', async () => {
    const error = await failureFrom('error:GPU_OUT_OF_MEMORY');
    expect(error.code).toBe('CHATTERBOX_GPU_OUT_OF_MEMORY');
  });

  it('maps a worker model-missing failure onto the provisioning remediation', async () => {
    const error = await failureFrom('error:MODEL_MISSING');
    expect(error.code).toBe('CHATTERBOX_MODEL_MISSING');
    expect(String(error.details?.remediation)).toContain('provision:voice-clone');
  });

  it('maps worker unsupported-language failure onto its own blocking code', async () => {
    const error = await failureFrom('error:UNSUPPORTED_LANGUAGE');
    expect(error.code).toBe('CHATTERBOX_UNSUPPORTED_LANGUAGE');
  });

  it('sanitizes worker stderr so absolute personal paths never reach a finding', async () => {
    const error = await failureFrom('stderr_path');
    expect(error.code).toBe('CHATTERBOX_WORKER_EXIT_NONZERO');
    expect(error.details?.exitCode).toBe(9);
    const stderrTail = String(error.details?.stderrTail ?? '');
    expect(stderrTail).not.toContain('/home/someone');
    expect(stderrTail).toContain('<path>/voice.py');
    expect(error.message).not.toContain('/home/someone');
  });

  it('leaves no scratch WAV behind after any failure', () => {
    expect(scratchFiles(ws).filter((name) => name.endsWith('.wav'))).toEqual([]);
  });
});
