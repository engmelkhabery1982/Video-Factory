/**
 * Speech and capability probes for the Milestone 2 factory.
 *
 * Only engines that are genuinely runnable here are reported available:
 *  - sam-js (local, pure JavaScript, no model download): probed by loading the
 *    existing LocalDialogueSynthesizer. Its voices are synthetic and robotic.
 *  - Kokoro and Chatterbox: reported unavailable unless their provisioning
 *    markers exist in this workspace. Nothing is downloaded or installed here.
 * No text provider, transcription engine, or image engine is configured in
 * this workspace, so those are reported unavailable with the reason.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  FactoryError,
  LocalDialogueSynthesizer,
  REAL_LOCAL_FORMAT,
  type AudioSynthesisRequest,
  type VoiceProfile,
} from '@buildtrack/core';
import { ROOT } from './platform.js';

export interface FactoryVoice {
  id: string;
  language: 'en';
  speakerLabel: string;
  hints: { rate: 'slow' | 'medium' | 'fast'; pitch: 'low' | 'medium' | 'high' };
}

/** Fixed local voice presets. Each is a SAM setting, not a natural voice. */
export const FACTORY_SAM_VOICES: readonly FactoryVoice[] = [
  { id: 'sam-reader', language: 'en', speakerLabel: 'Local SAM voice: slow, low (synthetic)', hints: { rate: 'slow', pitch: 'low' } },
  { id: 'sam-narrator', language: 'en', speakerLabel: 'Local SAM voice: medium, medium (synthetic)', hints: { rate: 'medium', pitch: 'medium' } },
  { id: 'sam-host', language: 'en', speakerLabel: 'Local SAM voice: fast, high (synthetic)', hints: { rate: 'fast', pitch: 'high' } },
];

export interface FactorySpeechProbe {
  samAvailable: boolean;
  engines: Array<{ id: string; available: boolean; reason: string }>;
}

function provisioned(relative: string): boolean {
  return fs.existsSync(path.join(ROOT, relative));
}

export function probeSpeechEngines(): FactorySpeechProbe {
  let samAvailable = false;
  try {
    samAvailable = new LocalDialogueSynthesizer().isAvailable();
  } catch {
    samAvailable = false;
  }
  const kokoroMarker = provisioned(path.join('.tts-cache', '.kokoro-model.ok'));
  const chatterboxMarker = provisioned(path.join('.chatterbox', 'provisioned.json'));
  return {
    samAvailable,
    engines: [
      {
        id: 'sam-js',
        available: samAvailable,
        reason: samAvailable
          ? 'Local sam-js synthesizer loads. English only; output is synthetic.'
          : 'The local sam-js synthesizer did not load.',
      },
      {
        id: 'kokoro',
        available: kokoroMarker,
        reason: kokoroMarker
          ? 'Kokoro provisioning marker present. Not exercised by this capability probe.'
          : 'Kokoro model is not provisioned in this workspace. It was not downloaded.',
      },
      {
        id: 'chatterbox',
        available: chatterboxMarker,
        reason: chatterboxMarker
          ? 'Chatterbox provisioning marker present. Not exercised by this capability probe.'
          : 'Chatterbox is not provisioned in this workspace. It was not installed.',
      },
    ],
  };
}

/** Voice ids a draft may assign. Empty when no speech engine runs. */
export function configuredVoiceIds(probe: FactorySpeechProbe = probeSpeechEngines()): string[] {
  return probe.samAvailable ? FACTORY_SAM_VOICES.map((v) => v.id) : [];
}

export function voiceById(id: string): FactoryVoice | null {
  return FACTORY_SAM_VOICES.find((v) => v.id === id) ?? null;
}

/**
 * Synthesize one scene with the existing local adapter. The adapter writes
 * relative to the working directory, so the target must sit under it. The
 * returned duration is the real length of the written audio, not an alignment.
 */
export async function synthesizeScene(opts: {
  absTarget: string;
  text: string;
  voiceId: string;
  sceneId: string;
  sceneIndex: number;
}): Promise<{ durationSec: number; bytes: number }> {
  const voice = voiceById(opts.voiceId);
  if (!voice) throw new FactoryError('FACTORY_VALIDATION', 'The requested voice is not configured.', 422);
  const rel = path.relative(process.cwd(), opts.absTarget);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new FactoryError('FACTORY_SPEECH_FAILED', 'Speech output must sit under the working directory for the local engine. Set the data directory inside it.', 503);
  }
  const profile: VoiceProfile = {
    id: `vp_factory_${voice.id.replace(/-/g, '_')}`,
    voiceSlot: `voice_factory_${voice.id.replace(/-/g, '_')}`,
    displayName: voice.speakerLabel,
    primaryLanguage: 'en',
    languages: ['en'],
    enabled: true,
    version: '1',
    synthesisHints: { rate: voice.hints.rate, pitch: voice.hints.pitch },
  } as VoiceProfile;
  const request = {
    scenarioId: 'factory-draft',
    sceneId: opts.sceneId,
    turnId: 't1',
    clipId: `clip_${opts.sceneId}`,
    speakerId: voice.id,
    voiceSlot: profile.voiceSlot,
    voiceProfileId: profile.id,
    voiceProfile: profile,
    language: 'en',
    spokenText: opts.text,
    synthesisHints: profile.synthesisHints,
    targetPath: rel,
    audioFormat: REAL_LOCAL_FORMAT,
    sceneIndex: opts.sceneIndex,
    turnIndex: 0,
    globalTurnIndex: opts.sceneIndex,
  } as unknown as AudioSynthesisRequest;
  let result;
  try {
    result = await new LocalDialogueSynthesizer().synthesize(request);
  } catch {
    throw new FactoryError('FACTORY_SPEECH_FAILED', 'The local speech engine failed for a scene. No audio was registered.', 503);
  }
  if (!result?.success || typeof result.durationSeconds !== 'number' || !(result.durationSeconds > 0) || !fs.existsSync(opts.absTarget)) {
    throw new FactoryError('FACTORY_SPEECH_FAILED', 'The local speech engine produced no usable audio for a scene.', 503);
  }
  return { durationSec: result.durationSeconds, bytes: fs.statSync(opts.absTarget).size };
}
