/**
 * ACCEPTANCE CONTENT — duplicate-structure regression (Retry-5 Gate N).
 *
 * Retry 5 failed Gate N on "each per-turn audio file is independently
 * synthesized" (36 physical WAVs, 34 unique SHA256 hashes). That assertion
 * encoded a false contract: Kokoro production synthesis is deterministic, so
 * two turns sharing one acoustic synthesis request legitimately produce
 * identical bytes while the product still writes one physical WAV per turn.
 *
 * This test reproduces the classification with the REAL production generator
 * (no Kokoro needed - the synthesis KEY does not depend on the model running):
 *
 *   36 expected dialogue turns
 *   34 unique acoustic synthesis keys
 *    2 duplicate-key groups, each a Long/Short pair of the same sentence spoken
 *      by the same character with the same resolved Kokoro voice
 *    0 turns sharing a physical output path
 *
 * If the acceptance content ever changes the duplicate structure, this test
 * fails and the classification must be re-established before another retry.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodeOs = process.getBuiltinModule('node:os') as typeof import('node:os');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'vf-content-'));
  nodeFs.mkdirSync(nodePath.join(dir, 'data'), { recursive: true });
  nodeFs.mkdirSync(nodePath.join(dir, 'output'), { recursive: true });
  process.env.BUILDTRAKE_DATA = nodePath.join(dir, 'data');
  process.env.BUILDTRAKE_OUTPUT = nodePath.join(dir, 'output');
  return { dir };
});

import { newProject, saveProject } from '../apps/api/src/services/store.js';
import { generateProductionState, personaObservationFromState } from '../apps/api/src/services/production-engine.js';
import {
  appendProductionHistoryEntry,
  loadProductionHistory,
} from '../apps/api/src/services/production-state.js';
import { planDialogueAudio, resolveDialogueAudioPlanVoices } from '@buildtrack/core';
import { resolveKokoroVoice, KOKORO_MODEL_ID, KOKORO_VOICE_BY_SLOT } from '../packages/core/dist/scenario/kokoro-dialogue-synthesizer.js';
import { generateDeterministicOutputPath } from '../packages/core/dist/scenario/synthesize-dialogue.js';
import {
  ACCEPTANCE_INPUT,
  ACCEPTANCE_VIDEO_ID,
  SECOND_ACCEPTANCE_INPUT,
  SECOND_ACCEPTANCE_VIDEO_ID,
  SECOND_SOURCE_NUMBERS,
  SOURCE_NUMBERS,
} from '../scripts/acceptance-content.js';

interface SynthesisRecord {
  target: string;
  scenarioId: string;
  sceneId: string;
  turnId: string;
  speakerId: string;
  voiceSlot: string;
  resolvedKokoroVoice: string;
  synthesisSpeed: number;
  engine: string;
  modelId: string;
  spokenText: string;
  wavPath: string;
}

function recordsFor(scenario: any, target: string): SynthesisRecord[] {
  const plan = planDialogueAudio(scenario);
  const resolution = resolveDialogueAudioPlanVoices(plan);
  return (plan.clips as any[]).map((clip) => {
    const profile = resolution.bySlot[clip.voiceSlot] ?? null;
    return {
      target,
      scenarioId: String(scenario.metadata.id),
      sceneId: clip.sceneId,
      turnId: clip.turnId,
      speakerId: clip.speakerId,
      voiceSlot: clip.voiceSlot,
      resolvedKokoroVoice: resolveKokoroVoice({ voiceSlot: clip.voiceSlot, voiceProfile: profile }),
      synthesisSpeed: 1,
      engine: 'kokoro-js',
      modelId: KOKORO_MODEL_ID,
      spokenText: clip.spokenText,
      wavPath: generateDeterministicOutputPath(
        { sceneId: clip.sceneId, turnId: clip.turnId },
        String(scenario.metadata.id),
        'audio/dialogue',
      ),
    };
  });
}

const keyOf = (r: SynthesisRecord) =>
  JSON.stringify([r.spokenText, r.resolvedKokoroVoice, r.synthesisSpeed, r.engine, r.modelId]);

function generate(id: string, input: unknown) {
  const project = newProject({ ...(input as any), videoId: id } as any);
  saveProject(project);
  return generateProductionState(project, { productionHistory: [], legacyVisualHistory: { videos: [] } } as any);
}

describe('acceptance content — semantic duplicate structure (Retry-5 Gate N classification)', () => {
  const state = generate(ACCEPTANCE_VIDEO_ID, ACCEPTANCE_INPUT);
  const longRecords = recordsFor((state as any).scenarios.long, 'long');
  const shortRecords = recordsFor((state as any).scenarios.short_1, 'short_1');
  const all = [...longRecords, ...shortRecords];

  it('the acceptance content produces 36 dialogue turns (24 Long + 12 Short)', () => {
    expect(longRecords).toHaveLength(24);
    expect(shortRecords).toHaveLength(12);
    expect(all).toHaveLength(36);
  });

  it('the 36 turns carry 34 unique acoustic synthesis keys: two identical-request pairs', () => {
    const keys = new Set(all.map(keyOf));
    expect(keys.size).toBe(34);
    expect(all.length - keys.size).toBe(2);

    const byKey = new Map<string, SynthesisRecord[]>();
    for (const record of all) {
      const k = keyOf(record);
      byKey.set(k, [...(byKey.get(k) ?? []), record]);
    }
    const groups = [...byKey.values()].filter((g) => g.length > 1);
    expect(groups).toHaveLength(2);

    for (const group of groups) {
      expect(group).toHaveLength(2);
      // One member from each accepted target: the same sentence in the Long and
      // in the Short scenario (this is why 36 files share 34 hashes).
      expect(group.map((r) => r.target).sort()).toEqual(['long', 'short_1']);
      // Same speaker, same slot, same resolved voice, same text, same settings.
      expect(new Set(group.map((r) => r.speakerId)).size).toBe(1);
      expect(new Set(group.map((r) => r.voiceSlot)).size).toBe(1);
      expect(new Set(group.map((r) => r.resolvedKokoroVoice)).size).toBe(1);
      expect(new Set(group.map((r) => r.spokenText)).size).toBe(1);
      expect(new Set(group.map((r) => r.synthesisSpeed)).size).toBe(1);
    }

    // The two duplicated sentences are the ones the Retry-5 run tripped on.
    const duplicatedTexts = groups.map((g) => g[0]!.spokenText).sort();
    expect(duplicatedTexts).toEqual(
      ['Start your BuildTrack trial', 'The control rule reviews the whole register every 48 hours.'].sort(),
    );
  });

  it('every turn owns a distinct physical output path under the product audio root', () => {
    const paths = new Set(all.map((r) => r.wavPath));
    expect(paths.size).toBe(all.length);
    for (const record of all) {
      expect(record.wavPath).toBe(`audio/dialogue/${record.scenarioId}/${record.sceneId}_${record.turnId}.wav`);
      expect(record.wavPath.startsWith('audio/dialogue/')).toBe(true);
    }
  });

  it('resolves voices deterministically from the registry and uses at least two distinct Kokoro voices', () => {
    const voices = new Set(all.map((r) => r.resolvedKokoroVoice));
    expect(voices.size).toBeGreaterThanOrEqual(2);
    for (const record of all) {
      expect(KOKORO_VOICE_BY_SLOT[record.voiceSlot]).toBe(record.resolvedKokoroVoice);
    }
  });

  it('a SECOND fresh project consumes project 1 production history and speaks only its own numbers', () => {
    const observation = personaObservationFromState(state);
    appendProductionHistoryEntry({
      videoId: ACCEPTANCE_VIDEO_ID,
      at: new Date().toISOString(),
      casting: observation.personas,
      styleFingerprint: observation.styleFingerprint ?? '',
    } as any);

    const project = newProject({ ...(SECOND_ACCEPTANCE_INPUT as any), videoId: SECOND_ACCEPTANCE_VIDEO_ID } as any);
    saveProject(project);
    const second = generateProductionState(project, {
      productionHistory: loadProductionHistory(),
      legacyVisualHistory: { videos: [] },
    } as any);

    expect((second as any).historyInput.source).toBe('production');
    expect((second as any).historyInput.videoIds).toContain(ACCEPTANCE_VIDEO_ID);
    expect((second as any).historyInput.personaKeyCount).toBeGreaterThan(0);

    const spoken = (second as any).scenarios.long.scenes
      .flatMap((scene: any) => scene.turns.map((turn: any) => turn.spokenText))
      .join(' ');
    for (const match of spoken.matchAll(/(?<![\d.])\d+(?:\.\d+)?(?![\d.])/g)) {
      expect(SECOND_SOURCE_NUMBERS.has(match[0]), `second project invented the number ${match[0]}`).toBe(true);
    }
    // The allow lists govern different scenarios; project 2 must never claim a
    // number that is outside ITS OWN list (checked above).
    expect(SOURCE_NUMBERS.size).toBeGreaterThan(0);
    // Second project is generation only: no rendered artifacts and no MP4 on
    // disk (the product legitimately writes project.json into the output root).
    expect(((second as any).artifacts ?? []).filter((a: any) => a.kind === 'video' || a.kind === 'package')).toHaveLength(0);
    const secondOut = path.join(tmp.dir, 'output', SECOND_ACCEPTANCE_VIDEO_ID);
    const mp4s = fs.existsSync(secondOut)
      ? fs.readdirSync(secondOut, { recursive: true }).filter((f) => String(f).endsWith('.mp4'))
      : [];
    expect(mp4s).toHaveLength(0);
  });
});
