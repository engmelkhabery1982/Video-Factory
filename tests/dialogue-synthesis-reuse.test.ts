/**
 * FOCUSED TESTS — validated per-turn synthesis reuse (audit item F).
 *
 * The production TTS contract is deterministic, and a build-plan / captions /
 * preview / final-export request must NOT re-run Kokoro for dialogue that has
 * not changed. These tests prove, with a real file-writing synthesizer and a
 * call counter:
 *
 *   - unchanged dialogue is reused (engine is not called again) and the
 *     physical per-turn WAV bytes are untouched;
 *   - a spokenText edit invalidates ONLY the edited turn;
 *   - a tampered/replaced WAV invalidates its own reuse (hash + size check);
 *   - a different voice or engine/model invalidates reuse;
 *   - `reuse: false` forces the engine;
 *   - the sync variant behaves identically.
 *
 * No network, no Kokoro, no render.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getProgressMeetingScenario, type Scenario } from '@buildtrack/core';
import { planDialogueAudio } from '../packages/core/src/scenario/plan-dialogue-audio.js';
import { resolveDialogueAudioPlanVoices } from '../packages/core/src/scenario/voice-resolver.js';
import {
  synthesizeDialoguePlan,
  synthesizeDialoguePlanSync,
} from '../packages/core/src/scenario/synthesize-dialogue.js';
import { AudioSynthesizer } from '../packages/core/src/scenario/audio-synthesizer.js';
import type { AudioSynthesisRequest, AudioSynthesisResult } from '../packages/core/src/scenario/audio-synthesis-types.js';
import { createIsolatedTmp, cleanupIsolatedTmp } from './helpers/isolated-tmp.js';

const TMP = createIsolatedTmp('synthesis-reuse');

beforeAll(() => {
  fs.mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  cleanupIsolatedTmp(TMP);
});

/** Minimal but real PCM16 mono WAV whose samples depend on the spoken text. */
function wavFor(text: string): Buffer {
  const sampleRate = 24000;
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
  const seed = text.length;
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
  readonly requiresNetwork = false;
  readonly isLocal = true;
  public calls = 0;

  constructor(engineId = 'mock-writer', modelId = 'mock-model-1') {
    this.engineId = engineId;
    this.modelId = modelId;
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
      durationSeconds: Number((wav.length - 44) / 2 / 24000),
      fileSizeBytes: wav.length,
      metadata: { scenarioId: request.scenarioId, language: request.language, engine: this.engineId },
    };
  }
}

function planFor(scenario: Scenario) {
  const plan = planDialogueAudio(scenario);
  return { plan, voices: resolveDialogueAudioPlanVoices(plan) };
}

function cloneScenario(): Scenario {
  return JSON.parse(JSON.stringify(getProgressMeetingScenario())) as Scenario;
}

function firstTurnRef(scenario: Scenario): { sceneId: string; spokenText: string; sceneIndex: number; turnIndex: number } {
  for (let s = 0; s < scenario.scenes.length; s++) {
    const turns = scenario.scenes[s].turns;
    if (turns.length > 0) {
      return { sceneId: scenario.scenes[s].id, spokenText: turns[0].spokenText, sceneIndex: s, turnIndex: 0 };
    }
  }
  throw new Error('scenario has no turns');
}

describe('per-turn synthesis reuse: unchanged dialogue is never re-synthesized', () => {
  it('first run synthesizes every clip; second run reuses every clip with identical bytes', async () => {
    const scenario = cloneScenario();
    const { plan, voices } = planFor(scenario);
    const basePath = `${TMP}/unchanged/audio/dialogue`;

    const first = new WritingSynth();
    const manifest1 = await synthesizeDialoguePlan(plan, voices, first, { basePath });
    expect(manifest1.hadFailures).toBe(false);
    expect(first.calls).toBe(plan.clipCount);
    expect(manifest1.reusedClipCount).toBe(0);
    expect(manifest1.synthesizedClipCount).toBe(plan.clipCount);

    const hashes1 = manifest1.results.map((r) => fs.readFileSync(path.join(process.cwd(), r.outputPath)).toString('base64'));

    const second = new WritingSynth();
    const manifest2 = await synthesizeDialoguePlan(plan, voices, second, { basePath });
    expect(manifest2.hadFailures).toBe(false);
    expect(second.calls).toBe(0);
    expect(manifest2.reusedClipCount).toBe(plan.clipCount);
    expect(manifest2.synthesizedClipCount).toBe(0);
    expect(manifest2.results.every((r) => r.reused === true && r.success)).toBe(true);

    const hashes2 = manifest2.results.map((r) => fs.readFileSync(path.join(process.cwd(), r.outputPath)).toString('base64'));
    expect(hashes2).toEqual(hashes1);
  });

  it('a spokenText edit invalidates only the edited turn', async () => {
    const scenario = cloneScenario();
    const basePath = `${TMP}/edited/audio/dialogue`;
    const before = planFor(scenario);
    const first = new WritingSynth();
    await synthesizeDialoguePlan(before.plan, before.voices, first, { basePath });
    const originalBytes = new Map(
      before.plan.clips.map((c) => {
        const outputPath = path.join(process.cwd(), basePath, `${scenario.metadata.id}/${c.sceneId}_${c.turnId}.wav`);
        return [`${c.sceneId}_${c.turnId}`, fs.readFileSync(outputPath).toString('base64')] as const;
      }),
    );

    const edited = cloneScenario();
    edited.scenes[0].turns[0].spokenText = `${edited.scenes[0].turns[0].spokenText} (edited)`;
    const after = planFor(edited);
    const second = new WritingSynth();
    const manifest = await synthesizeDialoguePlan(after.plan, after.voices, second, { basePath });

    expect(second.calls).toBe(1);
    expect(manifest.reusedClipCount).toBe(after.plan.clipCount - 1);
    const editedPath = path.join(process.cwd(), basePath, `${edited.metadata.id}/${edited.scenes[0].id}_${edited.scenes[0].turns[0].id}.wav`);
    expect(fs.readFileSync(editedPath).toString('base64')).not.toBe(originalBytes.get(`${edited.scenes[0].id}_${edited.scenes[0].turns[0].id}`));
    // Every other turn is byte-identical to the first run.
    for (const clip of after.plan.clips) {
      if (clip.sceneId === edited.scenes[0].id && clip.turnId === edited.scenes[0].turns[0].id) continue;
      const p = path.join(process.cwd(), basePath, `${edited.metadata.id}/${clip.sceneId}_${clip.turnId}.wav`);
      expect(fs.readFileSync(p).toString('base64')).toBe(originalBytes.get(`${clip.sceneId}_${clip.turnId}`));
    }
  });

  it('a tampered WAV is detected by hash and re-synthesized, never silently reused', async () => {
    const scenario = cloneScenario();
    const basePath = `${TMP}/tampered/audio/dialogue`;
    const { plan, voices } = planFor(scenario);
    const first = new WritingSynth();
    await synthesizeDialoguePlan(plan, voices, first, { basePath });

    const clip = plan.clips[0];
    const file = path.join(process.cwd(), basePath, `${scenario.metadata.id}/${clip.sceneId}_${clip.turnId}.wav`);
    fs.writeFileSync(file, Buffer.from('tampered-bytes'));
    const expected = wavFor(clip.spokenText).toString('base64');

    const second = new WritingSynth();
    const manifest = await synthesizeDialoguePlan(plan, voices, second, { basePath });
    expect(second.calls).toBe(1);
    expect(manifest.reusedClipCount).toBe(plan.clipCount - 1);
    expect(fs.readFileSync(file).toString('base64')).toBe(expected);
  });

  it('a missing WAV is detected and re-synthesized', async () => {
    const scenario = cloneScenario();
    const basePath = `${TMP}/missing/audio/dialogue`;
    const { plan, voices } = planFor(scenario);
    await synthesizeDialoguePlan(plan, voices, new WritingSynth(), { basePath });
    const clip = plan.clips[1];
    const file = path.join(process.cwd(), basePath, `${scenario.metadata.id}/${clip.sceneId}_${clip.turnId}.wav`);
    fs.rmSync(file, { force: true });

    const second = new WritingSynth();
    await synthesizeDialoguePlan(plan, voices, second, { basePath });
    expect(second.calls).toBe(1);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('a different voice resolution or engine identity invalidates reuse', async () => {
    const scenario = cloneScenario();
    const basePath = `${TMP}/identity/audio/dialogue`;
    const { plan, voices } = planFor(scenario);
    await synthesizeDialoguePlan(plan, voices, new WritingSynth(), { basePath });

    // Same request but a DIFFERENT engine/model: must not reuse.
    const otherEngine = new WritingSynth('mock-writer', 'mock-model-2');
    const manifestEngine = await synthesizeDialoguePlan(plan, voices, otherEngine, { basePath });
    expect(otherEngine.calls).toBe(plan.clipCount);
    expect(manifestEngine.reusedClipCount).toBe(0);

    // Same engine, but a modified voice profile for the first clip's slot.
    const slot = plan.clips[0].voiceSlot;
    const alteredVoices = JSON.parse(JSON.stringify(voices)) as typeof voices;
    alteredVoices.bySlot[slot] = { ...alteredVoices.bySlot[slot], id: `${alteredVoices.bySlot[slot].id}-alt` };
    const voiceSynth = new WritingSynth();
    const manifestVoice = await synthesizeDialoguePlan(plan, alteredVoices, voiceSynth, { basePath });
    expect(voiceSynth.calls).toBeGreaterThan(0);
    expect(manifestVoice.reusedClipCount).toBeLessThan(plan.clipCount);
  });

  it('reuse: false forces the engine even for unchanged dialogue', async () => {
    const scenario = cloneScenario();
    const basePath = `${TMP}/forced/audio/dialogue`;
    const { plan, voices } = planFor(scenario);
    await synthesizeDialoguePlan(plan, voices, new WritingSynth(), { basePath });
    const forced = new WritingSynth();
    const manifest = await synthesizeDialoguePlan(plan, voices, forced, { basePath, reuse: false });
    expect(forced.calls).toBe(plan.clipCount);
    expect(manifest.reusedClipCount).toBe(0);
    expect(manifest.synthesizedClipCount).toBe(plan.clipCount);
  });

  it('the synchronous variant reuses identically', () => {
    const scenario = cloneScenario();
    const basePath = `${TMP}/sync/audio/dialogue`;
    const { plan, voices } = planFor(scenario);
    const first = new WritingSynth();
    const manifest1 = synthesizeDialoguePlanSync(plan, voices, first, { basePath });
    expect(first.calls).toBe(plan.clipCount);
    expect(manifest1.reusedClipCount).toBe(0);

    const second = new WritingSynth();
    const manifest2 = synthesizeDialoguePlanSync(plan, voices, second, { basePath });
    expect(second.calls).toBe(0);
    expect(manifest2.reusedClipCount).toBe(plan.clipCount);
  });

  it('keeps separate Long/Short authority: two scenarios keep two physical file sets', async () => {
    const longScenario = cloneScenario();
    const shortScenario = cloneScenario();
    shortScenario.metadata = { ...shortScenario.metadata, id: `${shortScenario.metadata.id}-short` };
    shortScenario.scenes[0] = { ...shortScenario.scenes[0], turns: [{ ...shortScenario.scenes[0].turns[0], spokenText: 'A distinct Short-only line.' }] };
    const long = planFor(longScenario);
    const short = planFor(shortScenario);
    const basePath = `${TMP}/targets/audio/dialogue`;
    const synth = new WritingSynth();
    await synthesizeDialoguePlan(long.plan, long.voices, synth, { basePath });
    synth.calls = 0;
    await synthesizeDialoguePlan(short.plan, short.voices, synth, { basePath });
    expect(synth.calls).toBe(short.plan.clipCount);

    const longFirst = path.join(process.cwd(), basePath, `${longScenario.metadata.id}/${long.plan.clips[0].sceneId}_${long.plan.clips[0].turnId}.wav`);
    const shortFirst = path.join(process.cwd(), basePath, `${shortScenario.metadata.id}/${short.plan.clips[0].sceneId}_${short.plan.clips[0].turnId}.wav`);
    expect(fs.existsSync(longFirst)).toBe(true);
    expect(fs.existsSync(shortFirst)).toBe(true);
    expect(longFirst).not.toBe(shortFirst);
  });
});

/** Silence the unused-helper warning without changing behaviour. */
void firstTurnRef;
