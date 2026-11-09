/**
 * VS2 FOCUSED TESTS — Chatterbox synthesis reuse identity and invalidation.
 *
 * The adapter is expected to join the EXISTING validated-reuse machinery
 * (`synthesizeDialoguePlan` + per-turn sidecars) without a pipeline change. These
 * tests prove, with the deterministic fake worker:
 *
 *   - an unchanged run is served by validated reuse: the worker is NOT called
 *     again and no new receipt appears;
 *   - changing effective voice settings invalidates reuse and re-synthesizes;
 *   - changing the reference recording's approved hash invalidates reuse;
 *   - the reuse key changes when any part of the complete acoustic identity
 *     changes (settings, reference hash, model revision, engine contract);
 *   - engines without a settings digest (Kokoro/SAM) keep a byte-identical
 *     identity object and reuse key — no schema bump, no cache invalidation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getProgressMeetingScenario, type Scenario } from '@buildtrack/core';

import { planDialogueAudio } from '../packages/core/src/scenario/plan-dialogue-audio.js';
import { resolveDialogueAudioPlanVoices } from '../packages/core/src/scenario/voice-resolver.js';
import {
  SYNTHESIS_REUSE_SCHEMA_VERSION,
  synthesisEngineIdentityOf,
  synthesisReuseKey,
  synthesizeDialoguePlan,
} from '../packages/core/src/scenario/synthesize-dialogue.js';
import { KokoroDialogueSynthesizer } from '../packages/core/src/scenario/kokoro-dialogue-synthesizer.js';
import { LocalDialogueSynthesizer } from '../packages/core/src/scenario/local-dialogue-synthesizer.js';
import { UNDECLARED_VOICE_ACOUSTIC_IDENTITY } from '../packages/core/src/scenario/voice-acoustic-identity.js';
import type { AudioSynthesisRequest } from '../packages/core/src/scenario/audio-synthesis-types.js';
import type { DialogueAudioPlanVoiceResolution } from '../packages/core/src/scenario/voice-types.js';
import {
  approvedClonedProfile,
  createChatterboxWorkspace,
  FAKE_MODEL_REVISION_ALT,
  makeAdapter,
  readReceipts,
  referenceWavBuffer,
  requestFor,
  sha256OfBuffer,
  type ChatterboxTestWorkspace,
} from './helpers/chatterbox-worker-fixtures.js';
import { cleanupIsolatedTmp } from './helpers/isolated-tmp.js';

const ws: ChatterboxTestWorkspace = createChatterboxWorkspace('cb-reuse');

beforeAll(() => {
  ws.writeMarker();
});
afterAll(() => cleanupIsolatedTmp(ws.dir));

type Plan = ReturnType<typeof planDialogueAudio>;

/** A plan + resolution where EVERY voice slot resolves to the approved clone. */
function resolutionForEverything(profileOverride?: ReturnType<typeof approvedClonedProfile>): {
  plan: Plan;
  resolution: DialogueAudioPlanVoiceResolution;
} {
  const scenario = JSON.parse(JSON.stringify(getProgressMeetingScenario())) as Scenario;
  const plan = planDialogueAudio(scenario);
  const base = resolveDialogueAudioPlanVoices(plan);
  const profile =
    profileOverride ??
    approvedClonedProfile({
      referencePath: ws.referencePath,
      referenceSha256: ws.referenceSha256,
    });
  const bySlot: Record<string, typeof profile> = {};
  for (const slot of Object.keys(base.bySlot)) bySlot[slot] = profile;
  return {
    plan,
    resolution: {
      ...base,
      bySlot,
      resolved: base.resolved.map((entry) => ({ ...entry, profile })),
      hadFallback: false,
    },
  };
}

describe('VS2 Chatterbox reuse — identity completeness and invalidation', () => {
  it('keeps the reuse scheme at version 2 (no cache-breaking bump)', () => {
    expect(SYNTHESIS_REUSE_SCHEMA_VERSION).toBe(2);
  });

  it('produces an identical reuse key for an identical complete identity', () => {
    const a = makeAdapter(ws);
    const b = makeAdapter(ws);
    const profile = approvedClonedProfile({
      referencePath: ws.referencePath,
      referenceSha256: ws.referenceSha256,
    });
    const request = requestFor(profile, `${ws.dir}/audio/dialogue/clip-key.wav`);
    expect(synthesisReuseKey(request, synthesisEngineIdentityOf(a))).toBe(
      synthesisReuseKey(request, synthesisEngineIdentityOf(b))
    );
  });

  it('changes the key when effective voice settings change', () => {
    const baseline = makeAdapter(ws, { voiceSettings: { exaggeration: 0.5, cfgWeight: 0.5 } });
    const louder = makeAdapter(ws, { voiceSettings: { exaggeration: 0.9, cfgWeight: 0.5 } });
    const profile = approvedClonedProfile({
      referencePath: ws.referencePath,
      referenceSha256: ws.referenceSha256,
    });
    const request = requestFor(profile, `${ws.dir}/audio/dialogue/clip-settings-key.wav`);

    expect(louder.settingsDigest).not.toBe(baseline.settingsDigest);
    expect(synthesisReuseKey(request, synthesisEngineIdentityOf(louder))).not.toBe(
      synthesisReuseKey(request, synthesisEngineIdentityOf(baseline))
    );
  });

  it('changes the key when the reference recording hash changes', () => {
    const adapter = makeAdapter(ws);
    const profile = approvedClonedProfile({
      referencePath: ws.referencePath,
      referenceSha256: ws.referenceSha256,
    });
    const alternate = approvedClonedProfile({
      referencePath: ws.referencePath,
      referenceSha256: 'b'.repeat(64),
    });
    const base = requestFor(profile, `${ws.dir}/audio/dialogue/clip-ref-key.wav`);
    const changed = requestFor(alternate, base.targetPath);
    expect(synthesisReuseKey(changed, synthesisEngineIdentityOf(adapter))).not.toBe(
      synthesisReuseKey(base, synthesisEngineIdentityOf(adapter))
    );
  });

  it('changes the key when the model revision changes', () => {
    ws.writeMarker({ modelRevision: FAKE_MODEL_REVISION_ALT });
    const alternateRevision = makeAdapter(ws);
    ws.writeMarker();
    const pinned = makeAdapter(ws);

    expect(alternateRevision.modelRevision).toBe(FAKE_MODEL_REVISION_ALT);
    expect(pinned.modelRevision).not.toBe(alternateRevision.modelRevision);

    const alternateProfile = approvedClonedProfile({
      referencePath: ws.referencePath,
      referenceSha256: ws.referenceSha256,
      modelRevision: FAKE_MODEL_REVISION_ALT,
    });
    const pinnedProfile = approvedClonedProfile({
      referencePath: ws.referencePath,
      referenceSha256: ws.referenceSha256,
    });
    const targetPath = `${ws.dir}/audio/dialogue/clip-rev-key.wav`;
    expect(
      synthesisReuseKey(
        requestFor(alternateProfile, targetPath),
        synthesisEngineIdentityOf(alternateRevision)
      )
    ).not.toBe(
      synthesisReuseKey(requestFor(pinnedProfile, targetPath), synthesisEngineIdentityOf(pinned))
    );
  });

  it('changes the key when the engine contract changes', () => {
    const multilingual = makeAdapter(ws);
    const turbo = makeAdapter(ws, { engineContractId: 'chatterbox-turbo' });
    const profile = approvedClonedProfile({
      referencePath: ws.referencePath,
      referenceSha256: ws.referenceSha256,
    });
    const request = requestFor(profile, `${ws.dir}/audio/dialogue/clip-contract-key.wav`, { language: 'en-GB' });
    expect(synthesisReuseKey(request, synthesisEngineIdentityOf(turbo))).not.toBe(
      synthesisReuseKey(request, synthesisEngineIdentityOf(multilingual))
    );
  });

  it('leaves engines without a settings digest byte-identical (Kokoro regression guard)', () => {
    const kokoro = new KokoroDialogueSynthesizer();
    const identity = synthesisEngineIdentityOf(kokoro);
    expect('settingsDigest' in identity).toBe(false);
    expect(identity).toMatchObject({
      engineId: 'kokoro-js',
      engineVersion: '1.2.1',
      modelId: 'onnx-community/Kokoro-82M-v1.0-ONNX',
      modelRevision: null,
      quantization: 'q8',
    });

    const sam = new LocalDialogueSynthesizer();
    expect('settingsDigest' in synthesisEngineIdentityOf(sam)).toBe(false);

    /* The key material must be EXACTLY the scheme-2 material of VS1 — no extra
     * `settingsDigest` key — so existing Kokoro sidecars keep validating. */
    const request = {
      scenarioId: 'scenario-guard',
      sceneId: 'sc-01',
      turnId: 'turn-01',
      clipId: 'clip_sc-01_turn-01',
      speakerId: 'sarah',
      voiceSlot: 'voice_en_female_authority',
      voiceProfileId: 'vp_guard',
      language: 'en-GB',
      spokenText: 'Guard text.',
      targetPath: `${ws.dir}/audio/dialogue/clip-guard.wav`,
      audioFormat: null,
    } as unknown as AudioSynthesisRequest;
    const expectedMaterial = {
      schema: SYNTHESIS_REUSE_SCHEMA_VERSION,
      engineId: identity.engineId,
      engineVersion: identity.engineVersion ?? null,
      modelId: identity.modelId ?? null,
      modelRevision: identity.modelRevision ?? null,
      quantization: identity.quantization ?? null,
      scenarioId: request.scenarioId,
      sceneId: request.sceneId,
      turnId: request.turnId,
      clipId: request.clipId,
      speakerId: request.speakerId,
      voiceSlot: request.voiceSlot,
      voiceProfileId: request.voiceProfileId,
      voiceAcousticIdentity: UNDECLARED_VOICE_ACOUSTIC_IDENTITY,
      language: request.language,
      spokenText: request.spokenText,
      delivery: null,
      synthesisHints: null,
      audioFormat: null,
      targetPath: request.targetPath,
    };
    const expectedKey = createHash('sha256').update(JSON.stringify(expectedMaterial)).digest('hex');
    expect(synthesisReuseKey(request, identity)).toBe(expectedKey);
  });
});

describe('VS2 Chatterbox reuse — end-to-end sidecar reuse through synthesizeDialoguePlan', () => {
  it('reuses every unchanged clip without calling the worker again', async () => {
    const { plan, resolution } = resolutionForEverything();
    const basePath = `${ws.dir}/audio/dialogue`;
    const adapter = makeAdapter(ws);

    const first = await synthesizeDialoguePlan(plan, resolution, adapter, {
      basePath,
      enforcePublicationGate: true,
      includeFileStats: true,
    });
    expect(first.hadFailures).toBe(false);
    expect(first.successCount).toBeGreaterThan(0);
    expect(first.reusedClipCount ?? 0).toBe(0);
    expect(first.publicationGate?.allowed).toBe(true);

    const receiptsAfterFirst = readReceipts(ws).length;
    expect(receiptsAfterFirst).toBe(first.clipCount);

    const second = await synthesizeDialoguePlan(plan, resolution, adapter, {
      basePath,
      enforcePublicationGate: true,
      includeFileStats: true,
    });
    expect(second.hadFailures).toBe(false);
    expect(second.reusedClipCount).toBe(second.clipCount);
    expect(second.synthesizedClipCount).toBe(0);
    expect(readReceipts(ws).length).toBe(receiptsAfterFirst);

    const sidecarPath = path.join(process.cwd(), `${first.results[0].outputPath}.synthesis.json`);
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as Record<string, unknown>;
    expect(sidecar.settingsDigest).toBe(adapter.settingsDigest);
    expect(sidecar.schemaVersion).toBe(2);
    expect(sidecar.engineId).toBe('chatterbox-tts');
  }, 90_000);

  it('invalidates every clip when the voice settings change', async () => {
    const { plan, resolution } = resolutionForEverything();
    const basePath = `${ws.dir}/audio/dialogue`;
    await synthesizeDialoguePlan(plan, resolution, makeAdapter(ws), {
      basePath,
      enforcePublicationGate: true,
    });

    const changed = makeAdapter(ws, { voiceSettings: { exaggeration: 0.85 } });
    const receiptsBefore = readReceipts(ws).length;
    const manifest = await synthesizeDialoguePlan(plan, resolution, changed, {
      basePath,
      enforcePublicationGate: true,
    });
    expect(manifest.hadFailures).toBe(false);
    expect(manifest.synthesizedClipCount).toBe(manifest.clipCount);
    expect(manifest.reusedClipCount ?? 0).toBe(0);
    expect(readReceipts(ws).length).toBe(receiptsBefore + manifest.clipCount);
  }, 90_000);

  it('invalidates every clip when the approved reference recording hash changes', async () => {
    /* A second real recording with a genuinely different hash, approved in the
     * profile, so this exercises REUSE invalidation — not the integrity guard. */
    const altPath = `${ws.dir}/.voice-references/reference-alt.wav`;
    const altBytes = referenceWavBuffer('a second approved recording with other content');
    fs.writeFileSync(path.join(process.cwd(), altPath), altBytes);
    const altProfile = approvedClonedProfile({
      referencePath: altPath,
      referenceSha256: sha256OfBuffer(altBytes),
    });

    const { plan, resolution } = resolutionForEverything();
    const basePath = `${ws.dir}/audio/dialogue`;
    await synthesizeDialoguePlan(plan, resolution, makeAdapter(ws), {
      basePath,
      enforcePublicationGate: true,
    });

    const { resolution: altResolution } = resolutionForEverything(altProfile);
    const receiptsBefore = readReceipts(ws).length;
    const manifest = await synthesizeDialoguePlan(plan, altResolution, makeAdapter(ws), {
      basePath,
      enforcePublicationGate: true,
    });
    expect(manifest.hadFailures).toBe(false);
    expect(manifest.synthesizedClipCount).toBe(manifest.clipCount);
    expect(manifest.reusedClipCount ?? 0).toBe(0);
    expect(readReceipts(ws).length).toBe(receiptsBefore + manifest.clipCount);
  }, 90_000);
});
