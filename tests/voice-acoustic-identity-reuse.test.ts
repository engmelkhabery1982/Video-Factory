/**
 * VS1 FOCUSED TESTS — acoustic identity in the synthesis reuse key, and the
 * publication gate on the real production path.
 *
 * Proves, with a real file-writing synthesizer and a call counter:
 *
 *   - the reuse key covers every acoustic input VS1 added: declared engine
 *     family, model id, pinned model revision, runtime pin, reference-audio hash
 *     / preset voice id, and the engine's own model/quantisation;
 *   - changing any of them invalidates reuse and re-runs the engine, while an
 *     unchanged voice is still reused byte-for-byte;
 *   - a scheme-1 sidecar is never trusted under the scheme-2 key;
 *   - an unapproved voice stops synthesis BEFORE any artifact is written, and
 *     `buildDialogueProductionPlan` reports it as structured
 *     `VOICE_PUBLICATION_BLOCKED` findings;
 *   - the approved legacy Kokoro fixtures still produce a full production plan,
 *     with the gate report attached to the synthesis manifest as the audit trail.
 *
 * No network, no Kokoro model, no render.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getProgressMeetingScenario, type Scenario } from '@buildtrack/core';
import { planDialogueAudio } from '../packages/core/src/scenario/plan-dialogue-audio.js';
import { resolveDialogueAudioPlanVoices } from '../packages/core/src/scenario/voice-resolver.js';
import {
  SYNTHESIS_REUSE_SCHEMA_VERSION,
  buildSynthesisRequest,
  synthesisReuseKey,
  synthesizeDialoguePlan,
  synthesizeDialoguePlanSync,
} from '../packages/core/src/scenario/synthesize-dialogue.js';
import type { AudioSynthesizer } from '../packages/core/src/scenario/audio-synthesizer.js';
import { AudioSynthesisError } from '../packages/core/src/scenario/audio-synthesis-types.js';
import type { AudioSynthesisRequest, AudioSynthesisResult } from '../packages/core/src/scenario/audio-synthesis-types.js';
import type { AudioFormatSpec } from '../packages/core/src/scenario/dialogue-audio-types.js';
import type { DialogueAudioPlanVoiceResolution, VoiceProfile } from '../packages/core/src/scenario/voice-types.js';
import { MIGRATED_DEFAULT_VOICE_REGISTRY } from '../packages/core/src/scenario/voice-registry.js';
import { voiceAcousticIdentityOf, UNDECLARED_VOICE_ACOUSTIC_IDENTITY } from '../packages/core/src/scenario/voice-acoustic-identity.js';
import { buildDialogueProductionPlan } from '../packages/core/src/scenario/dialogue-production-pipeline.js';
import {
  approvedOwnVoiceProfile,
  OWN_VOICE_REFERENCE,
  OWN_VOICE_REFERENCE_SHA256_ALT,
} from './helpers/voice-publication-fixtures.js';
import { createIsolatedTmp, cleanupIsolatedTmp } from './helpers/isolated-tmp.js';

const TMP = createIsolatedTmp('vs1-acoustic-reuse');

beforeAll(() => {
  fs.mkdirSync(path.join(process.cwd(), TMP), { recursive: true });
});

afterAll(() => {
  cleanupIsolatedTmp(TMP);
});

/** Minimal but real PCM16 mono WAV whose samples depend on the spoken text. */
function wavFor(text: string, sampleRate = 24000): Buffer {
  const frameCount = Math.max(240, Math.min(24000, text.length * 400));
  const dataBytes = frameCount * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  const seed = text.length + sampleRate;
  for (let i = 0; i < frameCount; i++) {
    buf.writeInt16LE(((seed * 13 + i * 7) % 2000) - 1000, 44 + i * 2);
  }
  return buf;
}

/** Deterministic file-writing synthesizer with a call counter. */
class WritingSynth implements AudioSynthesizer {
  readonly engineId: string;
  readonly engineVersion = '1.0.0';
  readonly modelId: string;
  readonly dtype: string | undefined;
  readonly requiresNetwork = false;
  readonly isLocal = true;
  public calls = 0;

  constructor(engineId = 'mock-writer', modelId = 'mock-model-1', dtype?: string) {
    this.engineId = engineId;
    this.modelId = modelId;
    this.dtype = dtype;
  }

  async synthesize(request: AudioSynthesisRequest): Promise<AudioSynthesisResult> {
    return this.produce(request);
  }

  synthesizeSync(request: AudioSynthesisRequest): AudioSynthesisResult {
    return this.produce(request);
  }

  private produce(request: AudioSynthesisRequest): AudioSynthesisResult {
    this.calls += 1;
    fs.mkdirSync(path.dirname(request.targetPath), { recursive: true });
    const wav = wavFor(request.spokenText);
    fs.writeFileSync(request.targetPath, wav);
    return {
      clipId: request.clipId,
      sceneId: request.sceneId,
      turnId: request.turnId,
      speakerId: request.speakerId,
      voiceSlot: request.voiceSlot,
      voiceProfileId: request.voiceProfileId,
      spokenText: request.spokenText,
      outputPath: request.targetPath,
      audioFormat: request.audioFormat,
      success: true,
      fileSizeBytes: wav.length,
      metadata: { scenarioId: request.scenarioId, language: request.language, engine: this.engineId },
    };
  }
}

function cloneScenario(): Scenario {
  return JSON.parse(JSON.stringify(getProgressMeetingScenario())) as Scenario;
}

function planFor(scenario: Scenario) {
  const plan = planDialogueAudio(scenario);
  return { plan, voices: resolveDialogueAudioPlanVoices(plan) };
}

/** Replaces the profile resolved for one slot, keeping the resolution coherent. */
function withProfileForSlot(
  resolution: DialogueAudioPlanVoiceResolution,
  slot: string,
  profile: VoiceProfile
): DialogueAudioPlanVoiceResolution {
  return {
    ...resolution,
    bySlot: { ...resolution.bySlot, [slot]: profile },
    resolved: resolution.resolved.map((r) => (r.requestedSlot === slot ? { ...r, profile } : r)),
  };
}

/** The own-voice profile bound to one of the plan's real slots. */
function ownVoiceForSlot(slot: string): VoiceProfile {
  return approvedOwnVoiceProfile({ voiceSlot: slot, languages: ['en-GB', 'en-US', 'en'], primaryLanguage: 'en-GB' });
}

function patchOwnVoice(slot: string, patch: (profile: VoiceProfile) => void): VoiceProfile {
  const profile = ownVoiceForSlot(slot);
  patch(profile);
  return profile;
}

describe('VS1 — acoustic identity drives synthesis reuse', () => {
  it('1. the declared acoustic identity is derived from the publication record', () => {
    const identity = voiceAcousticIdentityOf(approvedOwnVoiceProfile());
    expect(identity).toEqual({
      engine: 'chatterbox',
      modelId: 'local/chatterbox-voice-clone',
      modelRevision: 'v0.5.0',
      runtimeId: 'chatterbox-local',
      runtimeVersion: '0.5.0',
      sourceKind: 'cloned_reference_audio',
      presetVoiceId: null,
      referenceSha256: OWN_VOICE_REFERENCE.sha256,
      acousticSourceId: `ref:${OWN_VOICE_REFERENCE.sha256}`,
    });

    const kokoro = voiceAcousticIdentityOf(MIGRATED_DEFAULT_VOICE_REGISTRY[0]);
    expect(kokoro.engine).toBe('kokoro');
    expect(kokoro.modelId).toBe('onnx-community/Kokoro-82M-v1.0-ONNX');
    expect(kokoro.modelRevision).toBe('v1.0');
    expect(kokoro.sourceKind).toBe('preset_model_voice');
    expect(kokoro.presetVoiceId).toBe('af_heart');
    expect(kokoro.referenceSha256).toBeNull();

    // A bare legacy fixture yields the SAME identity as its migrated form, so one
    // physical voice can never produce two different reuse keys.
    expect(voiceAcousticIdentityOf(MIGRATED_DEFAULT_VOICE_REGISTRY[0])).toEqual(
      voiceAcousticIdentityOf({ ...MIGRATED_DEFAULT_VOICE_REGISTRY[0], publication: undefined })
    );
    expect(
      voiceAcousticIdentityOf({ ...MIGRATED_DEFAULT_VOICE_REGISTRY[0], publication: undefined }, { migrateLegacy: false })
    ).toEqual(UNDECLARED_VOICE_ACOUSTIC_IDENTITY);
  });

  it('2. the reuse key covers engine, model revision, reference hash and synthesis settings', () => {
    const scenario = cloneScenario();
    const { plan, voices } = planFor(scenario);
    const slot = plan.clips[0].voiceSlot;
    const engine = { engineId: 'mock-writer', engineVersion: '1.0.0', modelId: 'mock-model-1' };

    const baseRequest = buildSynthesisRequest(plan.clips[0], plan, withProfileForSlot(voices, slot, ownVoiceForSlot(slot)), `${TMP}/key`);
    expect(baseRequest.voiceAcousticIdentity?.referenceSha256).toBe(OWN_VOICE_REFERENCE.sha256);
    const baseKey = synthesisReuseKey(baseRequest, engine);

    const keyWith = (profile: VoiceProfile, engineOverride = engine) =>
      synthesisReuseKey(buildSynthesisRequest(plan.clips[0], plan, withProfileForSlot(voices, slot, profile), `${TMP}/key`), engineOverride);

    // Reference recording replaced -> different voice -> different key.
    expect(
      keyWith(patchOwnVoice(slot, (p) => {
        p.publication!.acousticSource = { kind: 'cloned_reference_audio', referenceAudio: { ...OWN_VOICE_REFERENCE, sha256: OWN_VOICE_REFERENCE_SHA256_ALT } };
      }))
    ).not.toBe(baseKey);

    // Engine family changed.
    expect(
      keyWith(patchOwnVoice(slot, (p) => {
        p.publication!.engine = { ...p.publication!.engine!, engine: 'kokoro' };
      }))
    ).not.toBe(baseKey);

    // Model id changed.
    expect(
      keyWith(patchOwnVoice(slot, (p) => {
        p.publication!.engine = { ...p.publication!.engine!, modelId: 'local/other-model' };
      }))
    ).not.toBe(baseKey);

    // Pinned model revision changed.
    expect(
      keyWith(patchOwnVoice(slot, (p) => {
        p.publication!.engine = { ...p.publication!.engine!, modelRevision: 'v0.6.0' };
      }))
    ).not.toBe(baseKey);

    // Runtime pin changed.
    expect(
      keyWith(patchOwnVoice(slot, (p) => {
        p.publication!.engine = { ...p.publication!.engine!, runtimeVersion: '0.6.0' };
      }))
    ).not.toBe(baseKey);

    // Synthesis settings changed.
    expect(
      keyWith(patchOwnVoice(slot, (p) => {
        p.synthesisHints = { ...p.synthesisHints, rate: 'fast' };
      }))
    ).not.toBe(baseKey);

    // The actual engine's model pin and quantisation are part of the key too.
    expect(keyWith(ownVoiceForSlot(slot), { ...engine, modelId: 'mock-model-2' })).not.toBe(baseKey);
    expect(keyWith(ownVoiceForSlot(slot), { ...engine, modelRevision: 'rev-2' })).not.toBe(baseKey);
    expect(keyWith(ownVoiceForSlot(slot), { ...engine, quantization: 'fp16' })).not.toBe(baseKey);

    // Unchanged identity -> unchanged key (reuse stays possible).
    expect(keyWith(ownVoiceForSlot(slot))).toBe(baseKey);
    // Rights/consent/publication state are NOT acoustic and must not churn the key.
    expect(
      keyWith(patchOwnVoice(slot, (p) => {
        p.publication!.publicationState = 'review_only';
        p.publication!.consent = { ...p.publication!.consent!, revoked: true };
      }))
    ).toBe(baseKey);
  });

  it('3. an unchanged approved own voice is reused; a changed reference hash re-runs the engine', async () => {
    const scenario = cloneScenario();
    const { plan, voices } = planFor(scenario);
    const slot = plan.clips[0].voiceSlot;
    const affected = plan.clips.filter((c) => c.voiceSlot === slot).length;
    const basePath = `${TMP}/reference-hash/audio/dialogue`;

    const first = new WritingSynth();
    const manifest1 = await synthesizeDialoguePlan(plan, withProfileForSlot(voices, slot, ownVoiceForSlot(slot)), first, { basePath });
    expect(manifest1.hadFailures).toBe(false);
    expect(first.calls).toBe(plan.clipCount);
    expect(manifest1.reusedClipCount).toBe(0);

    // Identical voice -> full reuse, engine untouched.
    const second = new WritingSynth();
    const manifest2 = await synthesizeDialoguePlan(plan, withProfileForSlot(voices, slot, ownVoiceForSlot(slot)), second, { basePath });
    expect(second.calls).toBe(0);
    expect(manifest2.reusedClipCount).toBe(plan.clipCount);

    // A different reference recording for that voice -> exactly that voice re-runs.
    const swapped = patchOwnVoice(slot, (p) => {
      p.publication!.acousticSource = { kind: 'cloned_reference_audio', referenceAudio: { ...OWN_VOICE_REFERENCE, sha256: OWN_VOICE_REFERENCE_SHA256_ALT } };
    });
    const third = new WritingSynth();
    const manifest3 = await synthesizeDialoguePlan(plan, withProfileForSlot(voices, slot, swapped), third, { basePath });
    expect(third.calls).toBe(affected);
    expect(manifest3.reusedClipCount).toBe(plan.clipCount - affected);
    expect(manifest3.results.filter((r) => r.reused !== true).every((r) => r.voiceSlot === slot)).toBe(true);

    // Swapping back is a legitimate cache hit again: the old bytes are still valid.
    const fourth = new WritingSynth();
    const manifest4 = await synthesizeDialoguePlan(plan, withProfileForSlot(voices, slot, ownVoiceForSlot(slot)), fourth, { basePath });
    expect(fourth.calls).toBe(affected);
    expect(manifest4.reusedClipCount).toBe(plan.clipCount - affected);
  });

  it('4. an engine, model revision or settings change invalidates reuse end to end', async () => {
    const scenario = cloneScenario();
    const { plan, voices } = planFor(scenario);
    const slot = plan.clips[0].voiceSlot;
    const affected = plan.clips.filter((c) => c.voiceSlot === slot).length;
    const basePath = `${TMP}/engine-change/audio/dialogue`;
    const resolution = withProfileForSlot(voices, slot, ownVoiceForSlot(slot));

    await synthesizeDialoguePlan(plan, resolution, new WritingSynth(), { basePath });

    // Re-pinning the declared model revision re-runs exactly that voice.
    const modelRevision = withProfileForSlot(
      voices,
      slot,
      patchOwnVoice(slot, (p) => {
        p.publication!.engine = { ...p.publication!.engine!, modelRevision: 'v0.9.9' };
      })
    );
    const revisionSynth = new WritingSynth();
    const revisionManifest = await synthesizeDialoguePlan(plan, modelRevision, revisionSynth, { basePath });
    expect(revisionSynth.calls).toBe(affected);
    expect(revisionManifest.reusedClipCount).toBe(plan.clipCount - affected);

    // A different engine adapter re-runs everything.
    const engineSynth = new WritingSynth('other-engine', 'mock-model-1');
    const engineManifest = await synthesizeDialoguePlan(plan, resolution, engineSynth, { basePath });
    expect(engineSynth.calls).toBe(plan.clipCount);
    expect(engineManifest.reusedClipCount).toBe(0);

    // The same adapter with a different quantisation re-runs everything.
    const quantizedSynth = new WritingSynth('mock-writer', 'mock-model-1', 'fp16');
    const quantizedManifest = await synthesizeDialoguePlan(plan, resolution, quantizedSynth, { basePath });
    expect(quantizedSynth.calls).toBe(plan.clipCount);
    expect(quantizedManifest.reusedClipCount).toBe(0);

    // A changed output format is a synthesis setting change. The plan contract
    // pins 48 kHz, so the cast is deliberate: this proves the key covers the
    // format even when a caller hands in an off-contract one.
    const formatPlan = JSON.parse(JSON.stringify(plan)) as typeof plan;
    for (const clip of formatPlan.clips) {
      clip.audioFormat = { ...clip.audioFormat, sampleRate: 24000 } as unknown as AudioFormatSpec;
    }
    const formatSynth = new WritingSynth();
    const formatManifest = await synthesizeDialoguePlan(formatPlan, resolution, formatSynth, { basePath });
    expect(formatSynth.calls).toBe(plan.clipCount);
    expect(formatManifest.reusedClipCount).toBe(0);
  });

  it('5. the sidecar records scheme 2 and the declared acoustic identity', async () => {
    expect(SYNTHESIS_REUSE_SCHEMA_VERSION).toBe(2);
    const scenario = cloneScenario();
    const { plan, voices } = planFor(scenario);
    const slot = plan.clips[0].voiceSlot;
    const basePath = `${TMP}/sidecar/audio/dialogue`;
    const manifest = await synthesizeDialoguePlan(plan, withProfileForSlot(voices, slot, ownVoiceForSlot(slot)), new WritingSynth(), { basePath });
    expect(manifest.hadFailures).toBe(false);

    const clip = plan.clips.find((c) => c.voiceSlot === slot)!;
    const sidecarFile = path.join(process.cwd(), manifest.byClipId[clip.clipId].outputPath) + '.synthesis.json';
    expect(fs.existsSync(sidecarFile)).toBe(true);
    const sidecar = JSON.parse(fs.readFileSync(sidecarFile, 'utf8'));
    expect(sidecar.schemaVersion).toBe(2);
    expect(sidecar.voiceAcousticIdentity).toEqual({
      engine: 'chatterbox',
      modelId: 'local/chatterbox-voice-clone',
      modelRevision: 'v0.5.0',
      runtimeId: 'chatterbox-local',
      runtimeVersion: '0.5.0',
      sourceKind: 'cloned_reference_audio',
      presetVoiceId: null,
      referenceSha256: OWN_VOICE_REFERENCE.sha256,
      acousticSourceId: `ref:${OWN_VOICE_REFERENCE.sha256}`,
    });
    expect(sidecar.modelRevision).toBeNull();
    expect(sidecar.quantization).toBeNull();
  });

  it('6. a scheme-1 sidecar is never trusted by the scheme-2 key', async () => {
    const scenario = cloneScenario();
    const { plan, voices } = planFor(scenario);
    const basePath = `${TMP}/scheme1/audio/dialogue`;
    await synthesizeDialoguePlan(plan, voices, new WritingSynth(), { basePath });

    const clip = plan.clips[0];
    const wavPath = path.join(process.cwd(), `${basePath}/${scenario.metadata.id}/${clip.sceneId}_${clip.turnId}.wav`);
    const sidecarFile = `${wavPath}.synthesis.json`;
    const sidecar = JSON.parse(fs.readFileSync(sidecarFile, 'utf8'));
    // Downgrade the stored sidecar to the previous scheme, keeping a valid key.
    fs.writeFileSync(sidecarFile, JSON.stringify({ ...sidecar, schemaVersion: 1 }, null, 2), 'utf8');

    const synth = new WritingSynth();
    const manifest = await synthesizeDialoguePlan(plan, voices, synth, { basePath });
    expect(synth.calls).toBeGreaterThanOrEqual(1);
    expect(manifest.reusedClipCount).toBe(plan.clipCount - 1);
    expect(JSON.parse(fs.readFileSync(sidecarFile, 'utf8')).schemaVersion).toBe(2);
  });

  it('7. the synchronous variant reuses with the acoustic identity too', () => {
    const scenario = cloneScenario();
    const { plan, voices } = planFor(scenario);
    const slot = plan.clips[0].voiceSlot;
    const basePath = `${TMP}/sync/audio/dialogue`;
    const resolution = withProfileForSlot(voices, slot, ownVoiceForSlot(slot));

    const first = new WritingSynth();
    synthesizeDialoguePlanSync(plan, resolution, first, { basePath });
    expect(first.calls).toBe(plan.clipCount);

    const second = new WritingSynth();
    const manifest = synthesizeDialoguePlanSync(plan, resolution, second, { basePath });
    expect(second.calls).toBe(0);
    expect(manifest.reusedClipCount).toBe(plan.clipCount);
  });
});

describe('VS1 — the publication gate on the synthesis and production path', () => {
  it('8. an unapproved voice stops synthesis before any artifact is written', async () => {
    const scenario = cloneScenario();
    const { plan, voices } = planFor(scenario);
    const slot = plan.clips[0].voiceSlot;
    const basePath = `${TMP}/blocked-synthesis/audio/dialogue`;

    const unapproved = patchOwnVoice(slot, (p) => {
      p.publication!.consent = { ...p.publication!.consent!, revoked: true, revokedAt: '2026-10-07T09:00:00Z' };
    });
    const synth = new WritingSynth();

    let thrown: unknown;
    try {
      await synthesizeDialoguePlan(plan, withProfileForSlot(voices, slot, unapproved), synth, { basePath, enforcePublicationGate: true });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AudioSynthesisError);
    expect((thrown as AudioSynthesisError).code).toBe('VOICE_PUBLICATION_BLOCKED');
    expect((thrown as AudioSynthesisError).message).toContain('CONSENT_REVOKED');
    expect(synth.calls).toBe(0);
    expect(fs.existsSync(path.join(process.cwd(), basePath))).toBe(false);

    // The same voice, approved, synthesizes and carries the gate report.
    const approved = new WritingSynth();
    const manifest = await synthesizeDialoguePlan(plan, withProfileForSlot(voices, slot, ownVoiceForSlot(slot)), approved, {
      basePath,
      enforcePublicationGate: true,
    });
    expect(manifest.hadFailures).toBe(false);
    expect(approved.calls).toBe(plan.clipCount);
    expect(manifest.publicationGate?.allowed).toBe(true);
    expect(manifest.publicationGate?.reports.length).toBe(voices.resolved.length);
  });

  it('9. without the gate the same run proceeds (the gate is the only thing that blocked it)', async () => {
    const scenario = cloneScenario();
    const { plan, voices } = planFor(scenario);
    const slot = plan.clips[0].voiceSlot;
    const basePath = `${TMP}/ungated/audio/dialogue`;
    const unapproved = patchOwnVoice(slot, (p) => {
      p.publication!.publicationState = 'draft';
    });
    const synth = new WritingSynth();
    const manifest = await synthesizeDialoguePlan(plan, withProfileForSlot(voices, slot, unapproved), synth, { basePath });
    expect(manifest.hadFailures).toBe(false);
    expect(synth.calls).toBe(plan.clipCount);
    expect(manifest.publicationGate).toBeUndefined();
  });

  it('10. a declared engine that disagrees with the running engine is blocked', async () => {
    const scenario = cloneScenario();
    const { plan, voices } = planFor(scenario);
    const basePath = `${TMP}/engine-agreement/audio/dialogue`;
    const synth = new WritingSynth('mock-writer', 'mock-model-1');

    let thrown: unknown;
    try {
      await synthesizeDialoguePlan(plan, voices, synth, {
        basePath,
        enforcePublicationGate: true,
        requireVoiceEngineAgreement: true,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AudioSynthesisError);
    expect((thrown as AudioSynthesisError).code).toBe('VOICE_PUBLICATION_BLOCKED');
    expect((thrown as AudioSynthesisError).message).toContain('ENGINE_DECLARATION_MISMATCH');
    expect(synth.calls).toBe(0);

    // The legacy Kokoro declaration agrees with a kokoro-js adapter.
    const kokoroLike = new WritingSynth('kokoro-js', 'onnx-community/Kokoro-82M-v1.0-ONNX');
    const manifest = await synthesizeDialoguePlan(plan, voices, kokoroLike, {
      basePath,
      enforcePublicationGate: true,
      requireVoiceEngineAgreement: true,
    });
    expect(manifest.hadFailures).toBe(false);
    expect(manifest.publicationGate?.allowed).toBe(true);
  });

  it('11. buildDialogueProductionPlan blocks a review_only voice and reports structured findings', async () => {
    const scenario = cloneScenario();
    const basePath = `${TMP}/blocked-production`;
    const reviewOnlyRegistry = MIGRATED_DEFAULT_VOICE_REGISTRY.map((profile) => ({
      ...profile,
      publication: { ...profile.publication!, publicationState: 'review_only' as const },
    })) as VoiceProfile[];

    const blocked = await buildDialogueProductionPlan(scenario, {
      voiceResolutionOptions: { registry: reviewOnlyRegistry },
      synthesisBasePath: `${basePath}/audio/dialogue`,
      canonicalBasePath: `${basePath}/audio/canonical`,
    });

    expect(blocked.success).toBe(false);
    if (blocked.success) return;
    expect(blocked.error).toContain('voice publication gate');
    expect(blocked.findings.length).toBeGreaterThan(0);
    expect(blocked.findings.every((f) => f.code === 'VOICE_PUBLICATION_BLOCKED' && f.severity === 'error')).toBe(true);
    expect(blocked.findings[0].message).toContain('VOICE-PUB-080-PUBLICATION-STATE-NOT-APPROVED');
    expect(blocked.findings[0].location?.voiceSlot).toBeTruthy();
    expect(blocked.findings[0].location?.scenarioId).toBe(scenario.metadata.id);
    // Nothing was synthesized and nothing was written.
    expect(fs.existsSync(path.join(process.cwd(), basePath, 'audio', 'dialogue'))).toBe(false);

    // Turning the gate off is the ONLY difference: the same voices now produce audio.
    const ungated = await buildDialogueProductionPlan(scenario, {
      voiceResolutionOptions: { registry: reviewOnlyRegistry },
      synthesisBasePath: `${basePath}/ungated/audio/dialogue`,
      canonicalBasePath: `${basePath}/ungated/audio/canonical`,
      enforcePublicationGate: false,
    });
    expect(ungated.success).toBe(true);
  }, 120_000);

  it('12. buildDialogueProductionPlan still produces the legacy Kokoro fixtures, with the gate report attached', async () => {
    const scenario = cloneScenario();
    const basePath = `${TMP}/approved-production`;
    const result = await buildDialogueProductionPlan(scenario, {
      synthesisBasePath: `${basePath}/audio/dialogue`,
      canonicalBasePath: `${basePath}/audio/canonical`,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result.summary.status).not.toBe('error');
    expect(result.result.synthesisManifest.hadFailures).toBe(false);
    expect(result.result.synthesisManifest.successCount).toBe(result.result.dialoguePlan.clipCount);
    expect(result.result.synthesisManifest.publicationGate?.allowed).toBe(true);
    expect(result.result.synthesisManifest.publicationGate?.blockedSlots).toEqual([]);
    for (const report of result.result.synthesisManifest.publicationGate?.reports ?? []) {
      expect(report.origin).toBe('legacy_kokoro_fixture');
      expect(report.engine.engine).toBe('kokoro');
      expect(report.acousticIdentity.sourceKind).toBe('preset_model_voice');
    }
    expect(result.result.voiceResolution.resolved.every((v) => v.profile.publication?.publicationState === 'approved')).toBe(true);
  }, 120_000);
});
