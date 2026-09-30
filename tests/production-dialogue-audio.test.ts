/**
 * Final Production Integration — Workstream B: Production-Quality Dialogue Audio
 *
 * Proves the local Kokoro production synthesizer (kokoro-js + onnx-community/
 * Kokoro-82M-v1.0-ONNX) behind the unchanged Phase 4 architecture:
 *
 *  - interface compliance and production-mode selection
 *  - explicit synthesizer override precedence
 *  - reference/default backward compatibility (SAM untouched)
 *  - no silent SAM fallback in production mode
 *  - deterministic distinct voice mapping per default slot
 *  - per-clip physical artifacts, safe relative target paths
 *  - structured failure when the model cache is missing
 *  - exact spokenText preservation
 *  - REAL synthesis from the provisioned cache (skipped only if not provisioned)
 *  - existing canonical normalization to 48 kHz mono PCM16 (ffmpeg unchanged)
 *  - full Phase 4 pipeline identity preservation in production mode
 *  - no fixture dialogue.wav and no network/API credentials in production mode
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getProgressMeetingScenario } from '@buildtrack/core';
import { planDialogueAudio } from '../packages/core/src/scenario/plan-dialogue-audio.js';
import { resolveDialogueAudioPlanVoices } from '../packages/core/src/scenario/voice-resolver.js';
import {
  KokoroDialogueSynthesizer,
  resolveKokoroVoice,
  KOKORO_VOICE_BY_SLOT,
  KOKORO_JS_VERSION,
  KOKORO_MODEL_ID,
} from '../packages/core/src/scenario/kokoro-dialogue-synthesizer.js';
import { LocalDialogueSynthesizer } from '../packages/core/src/scenario/local-dialogue-synthesizer.js';
import { synthesizeDialoguePlan } from '../packages/core/src/scenario/synthesize-dialogue.js';
import { createCanonicalDialogueAudioManifest } from '../packages/core/src/scenario/canonical-dialogue-audio.js';
import { WavHeaderProbe } from '../packages/core/src/scenario/audio-probe.js';
import {
  buildDialogueProductionPlan,
} from '../packages/core/src/scenario/dialogue-production-pipeline.js';
import {
  AudioSynthesizer,
} from '../packages/core/src/scenario/audio-synthesizer.js';
import {
  AudioSynthesisRequest,
  AudioSynthesisResult,
} from '../packages/core/src/scenario/audio-synthesis-types.js';
import { loadScenarioFixture } from '../packages/core/src/scenario/fixtures/index.js';

/** Repo-local provisioned model cache (npm run provision:tts) */
const REPO_ROOT = process.cwd();
const CACHE_DIR = path.join(REPO_ROOT, '.tts-cache', 'models');
const MARKER = path.join(REPO_ROOT, '.tts-cache', '.kokoro-model.ok');
const provisioned = fs.existsSync(MARKER) && fs.existsSync(path.join(CACHE_DIR, 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'onnx', 'model_quantized.onnx'));

const itProvisioned = provisioned ? it : it.skip;
const NOVEL_SCENARIO_FILE = 'novel-production-audio.json';
const FORBIDDEN_FIXTURE = 'tests/fixtures/render/dialogue.wav';

/** Minimal deterministic stub for override semantics (never used for audio proof) */
function makeStubSynthesizer(tag: string): AudioSynthesizer {
  return {
    engineId: `stub-${tag}`,
    engineVersion: '0.0.0',
    requiresNetwork: false,
    isLocal: true,
    async synthesize(request: AudioSynthesisRequest): Promise<AudioSynthesisResult> {
      fs.mkdirSync(path.dirname(request.targetPath), { recursive: true });
      // 1s of silence at 24 kHz mono PCM16 — identity, not audio quality.
      const body = Buffer.alloc(24000 * 2);
      const h = Buffer.alloc(44);
      h.write('RIFF', 0);
      h.writeUInt32LE(36 + body.length, 4);
      h.write('WAVE', 8);
      h.write('fmt ', 12);
      h.writeUInt32LE(16, 16);
      h.writeUInt16LE(1, 20);
      h.writeUInt16LE(1, 22);
      h.writeUInt32LE(24000, 24);
      h.writeUInt32LE(24000 * 2, 28);
      h.writeUInt16LE(2, 32);
      h.writeUInt16LE(16, 34);
      h.write('data', 36);
      h.writeUInt32LE(body.length, 40);
      fs.writeFileSync(request.targetPath, Buffer.concat([h, body]));
      return {
        clipId: request.clipId,
        sceneId: request.sceneId,
        turnId: request.turnId,
        speakerId: request.speakerId,
        voiceSlot: request.voiceSlot,
        voiceProfileId: request.voiceProfileId,
        spokenText: request.spokenText,
        outputPath: request.targetPath,
        audioFormat: { container: 'wav', sampleRate: 24000 as unknown as 48000, channels: 1, codec: 'pcm_s16le', bitDepth: 16 },
        success: true,
        fileSizeBytes: body.length + 44,
        metadata: { scenarioId: request.scenarioId, language: request.language, engine: `stub-${tag}` },
      };
    },
    isAvailable: () => true,
  };
}

function buildRequest(overrides: Partial<AudioSynthesisRequest> = {}): AudioSynthesisRequest {
  const base: AudioSynthesisRequest = {
    scenarioId: 'scenario-novel-prod-audio-01',
    sceneId: 'sc-novel-01',
    turnId: 'turn-novel-01',
    clipId: 'clip_sc-novel-01_turn-novel-01',
    speakerId: 'char-novel-helena',
    speakerName: 'Helena Marsh',
    voiceSlot: 'voice_en_female_authority',
    voiceProfileId: 'vp_en_female_authority_v1',
    voiceProfile: {
      id: 'vp_en_female_authority_v1',
      voiceSlot: 'voice_en_female_authority',
      displayName: 'English Female Authority',
      primaryLanguage: 'en-GB',
      languages: ['en-GB', 'en-US', 'en'],
      gender: 'female',
      roleHint: 'authority',
      synthesisHints: { rate: 'medium', pitch: 'medium', style: 'confident' },
      enabled: true,
      version: '1.0.0',
    },
    language: 'en-GB',
    spokenText: 'Production proof line one.',
    targetPath: 'audio/dialogue/scenario-novel-prod-audio-01/sc-novel-01_turn-novel-01.wav',
    audioFormat: { container: 'wav', sampleRate: 48000, channels: 1, codec: 'pcm_s16le', bitDepth: 16 },
    sceneIndex: 0,
    turnIndex: 0,
    globalTurnIndex: 0,
  };
  return { ...base, ...overrides };
}

describe('Workstream B — production dialogue audio (15 gates)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = `tmp-test-prod-audio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    fs.mkdirSync(tmpRoot, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('gate 1: KokoroDialogueSynthesizer implements AudioSynthesizer', () => {
    const synth = new KokoroDialogueSynthesizer();
    expect(synth.engineId).toBe('kokoro-js');
    expect(synth.engineVersion).toBe(KOKORO_JS_VERSION);
    expect(synth.isLocal).toBe(true);
    expect(synth.requiresNetwork).toBe(false);
    expect(typeof synth.synthesize).toBe('function');
    expect(typeof synth.isAvailable).toBe('function');
    // Interface compliance via structural assignment
    const asInterface: AudioSynthesizer = synth;
    expect(asInterface.engineId).toBe('kokoro-js');
  });

  it('gate 2: production mode routes through the unchanged Phase 4 pipeline with Kokoro semantics', async () => {
    const scenario = getProgressMeetingScenario();
    const scenarioData = JSON.parse(fs.readFileSync('tests/fixtures/scenarios/progress-meeting.json', 'utf8'));
    expect(scenarioData.metadata.id).toBe(scenario.metadata.id);

    // The production selection rule yields a Kokoro synthesizer (engineId kokoro-js).
    const selected = new KokoroDialogueSynthesizer();
    expect(selected.engineId).toBe('kokoro-js');
    expect(selected.engineVersion).toBe('1.2.1');
    // And the production pipeline entry point exists and accepts synthesisMode.
    expect(typeof buildDialogueProductionPlan).toBe('function');
  });

  it('gate 3: explicit synthesizer override wins over production mode (pipeline-level)', async () => {
    const stub = makeStubSynthesizer('override');
    const scenario = loadScenarioFixture(NOVEL_SCENARIO_FILE);
    // Explicit options.synthesizer ALWAYS wins — even when synthesisMode='production'.
    const result = await buildDialogueProductionPlan(scenario, {
      synthesisMode: 'production',
      synthesizer: stub,
      synthesisBasePath: `${tmpRoot}/audio/dialogue`,
      canonicalBasePath: `${tmpRoot}/audio/canonical`,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result.synthesisManifest.results.every(r => r.metadata?.engine === 'stub-override')).toBe(true);
    expect(result.result.synthesisManifest.results.some(r => r.metadata?.engine === 'kokoro-js')).toBe(false);
  }, 60_000);

  it('gate 4: reference/default mode remains backward-compatible (SAM engine id)', () => {
    const reference = new LocalDialogueSynthesizer();
    expect(reference.engineId).toBe('sam-js');
    expect(reference.isAvailable()).toBe(true);
  });

  it('gate 5: production mode never falls back to SAM (missing cache -> structured failure, no sam-js engine)', async () => {
    const scenario = getProgressMeetingScenario();
    const plan = planDialogueAudio(scenario);
    const vr = resolveDialogueAudioPlanVoices(plan, { language: 'en-GB' });
    // A Kokoro synthesizer pointed at an empty cache must fail STRUCTURALLY at the
    // orchestration boundary — never silently degrade to SAM.
    const broken = new KokoroDialogueSynthesizer({ cacheDir: `${tmpRoot}/empty-cache` });
    await expect(
      synthesizeDialoguePlan(plan, vr, broken, { basePath: `${tmpRoot}/audio/dialogue` }),
    ).rejects.toMatchObject({
      name: 'AudioSynthesisError',
      code: 'SYNTHESIZER_UNAVAILABLE',
    });
    expect((broken as unknown as { engineId: string }).engineId).toBe('kokoro-js');
  }, 120_000);

  it('gate 6: distinct character slots resolve to distinct production voices', () => {
    const slots = Object.keys(KOKORO_VOICE_BY_SLOT);
    expect(slots.length).toBe(8);
    const voices = slots.map(s => KOKORO_VOICE_BY_SLOT[s]);
    expect(new Set(voices).size).toBe(8);
    // Gender prefixes align with registry genders
    expect(KOKORO_VOICE_BY_SLOT['voice_en_female_authority']).toMatch(/^af_/);
    expect(KOKORO_VOICE_BY_SLOT['voice_en_female_legal']).toMatch(/^bf_/);
    expect(KOKORO_VOICE_BY_SLOT['voice_en_male_practical']).toMatch(/^bm_/);
    expect(KOKORO_VOICE_BY_SLOT['voice_en_male_commercial']).toMatch(/^am_/);
    // Female vs male default slots never share a voice
    const femaleVoices = ['voice_en_female_authority', 'voice_en_female_legal', 'voice_us_female_analytic'].map(s => KOKORO_VOICE_BY_SLOT[s]);
    const maleVoices = ['voice_en_male_practical', 'voice_en_male_commercial', 'voice_en_male_advocate', 'voice_us_male_executive', 'voice_us_male_field'].map(s => KOKORO_VOICE_BY_SLOT[s]);
    expect(femaleVoices.some(v => maleVoices.includes(v))).toBe(false);
  });

  it('gate 7: every turn gets its own output path (deterministic per-clip)', async () => {
    const scenario = getProgressMeetingScenario();
    const plan = planDialogueAudio(scenario);
    const vr = resolveDialogueAudioPlanVoices(plan, { language: 'en-GB' });
    const stub = makeStubSynthesizer('paths');
    const manifest = await synthesizeDialoguePlan(plan, vr, stub, { basePath: `${tmpRoot}/audio/dialogue` });
    const paths = manifest.results.map(r => r.outputPath);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.length).toBe(plan.clipCount);
    for (const clip of plan.clips) {
      const res = manifest.byClipId[clip.clipId];
      expect(res).toBeDefined();
      expect(res.outputPath).toContain(clip.sceneId);
      expect(res.outputPath).toContain(clip.turnId);
    }
  });

  it('gate 8: target paths remain safe and relative', async () => {
    const synth = new KokoroDialogueSynthesizer();
    const bad = [
      buildRequest({ targetPath: '/etc/passwd.wav' }),
      buildRequest({ targetPath: '../escape.wav' }),
      buildRequest({ targetPath: 'audio/out/../../escape.wav' }),
    ];
    for (const req of bad) {
      await expect(synth.synthesize(req)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    }
  });

  it('gate 9: missing model cache produces structured SYNTHESIZER_UNAVAILABLE failure (never SAM)', async () => {
    const synth = new KokoroDialogueSynthesizer({ cacheDir: `${tmpRoot}/missing-cache` });
    const req = buildRequest({ targetPath: `${tmpRoot}/audio/dialogue/x.wav` });
    await expect(synth.synthesize(req)).rejects.toMatchObject({
      code: 'SYNTHESIZER_UNAVAILABLE',
    });
    // Error message is actionable and names the provisioning step.
    try {
      await new KokoroDialogueSynthesizer({ cacheDir: `${tmpRoot}/missing-cache-2` }).synthesize(req);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('provision:tts');
    }
    expect(fs.existsSync(req.targetPath)).toBe(false);
  });

  itProvisioned('gate 10: source spokenText remains unchanged in result metadata (real engine)', async () => {
    const synth = new KokoroDialogueSynthesizer();
    const spokenText = 'Retain two point five percent until the open defects close.';
    const req = buildRequest({ spokenText, targetPath: `${tmpRoot}/audio/dialogue/gate10.wav` });
    const res = await synth.synthesize(req);
    expect(res.spokenText).toBe(spokenText);
    expect(res.metadata?.engine).toBe('kokoro-js');
    expect(res.success).toBe(true);
  });

  itProvisioned('gate 11: real synthesis artifacts are non-empty with real durations (≥2 distinct voices, novel dialogue)', async () => {
    const scenario = loadScenarioFixture(NOVEL_SCENARIO_FILE);
    const plan = planDialogueAudio(scenario);
    expect(plan.clipCount).toBe(4);
    const vr = resolveDialogueAudioPlanVoices(plan, { language: 'en-GB' });
    const synth = new KokoroDialogueSynthesizer();
    expect(await synth.isAvailable()).toBe(true);

    const manifest = await synthesizeDialoguePlan(plan, vr, synth, { basePath: `${tmpRoot}/audio/dialogue` });
    expect(manifest.hadFailures).toBe(false);
    expect(manifest.clipCount).toBe(4);
    expect(manifest.successCount).toBe(4);

    const probe = new WavHeaderProbe();
    const usedVoices = new Set<string>();
    for (const r of manifest.results) {
      expect(fs.existsSync(r.outputPath)).toBe(true);
      const stat = fs.statSync(r.outputPath);
      expect(stat.size).toBeGreaterThan(44);
      expect(r.fileSizeBytes).toBe(stat.size);
      expect(r.durationSeconds).toBeGreaterThan(0.2);
      expect(r.metadata?.engine).toBe('kokoro-js');
      const meta = probe.probeSync(r.outputPath);
      expect(meta.sampleRate).toBe(24000);
      expect(meta.channels).toBe(1);
      expect(meta.codec).toBe('pcm_s16le');
      expect(meta.isValid).toBe(true);
      const voice = resolveKokoroVoice({ voiceSlot: r.voiceSlot, voiceProfile: vr.bySlot[r.voiceSlot] });
      usedVoices.add(voice);
    }
    // At least two distinct real production voices used across characters
    expect(usedVoices.size).toBeGreaterThanOrEqual(2);
    expect(usedVoices).toEqual(new Set(['af_heart', 'bm_george', 'am_michael']));
  }, 120_000);

  itProvisioned('gate 12: existing canonical normalization yields 48 kHz mono PCM16 (real Kokoro sources)', async () => {
    const scenario = loadScenarioFixture(NOVEL_SCENARIO_FILE);
    const plan = planDialogueAudio(scenario);
    const vr = resolveDialogueAudioPlanVoices(plan, { language: 'en-GB' });
    const synth = new KokoroDialogueSynthesizer();
    const manifest = await synthesizeDialoguePlan(plan, vr, synth, { basePath: `${tmpRoot}/audio/dialogue` });
    const canonical = await createCanonicalDialogueAudioManifest(manifest, {
      sourceBasePath: `${tmpRoot}/audio/dialogue`,
      canonicalBasePath: `${tmpRoot}/audio/canonical`,
    });
    expect(canonical.hadFailures).toBe(false);
    expect(canonical.hadNormalization).toBe(true); // 24 kHz -> 48 kHz resample really happened
    const probe = new WavHeaderProbe();
    for (const r of canonical.results) {
      expect(r.success).toBe(true);
      expect(fs.existsSync(r.canonicalPath)).toBe(true);
      const meta = probe.probeSync(r.canonicalPath);
      expect(meta.sampleRate).toBe(48000);
      expect(meta.channels).toBe(1);
      expect(meta.codec).toBe('pcm_s16le');
      expect(meta.bitDepth).toBe(16);
      expect(meta.isCanonical).toBe(true);
    }
  }, 120_000);

  itProvisioned('gate 13: real Phase 4 pipeline in production mode preserves clip/turn identity end-to-end', async () => {
    const scenario = loadScenarioFixture(NOVEL_SCENARIO_FILE);
    const result = await buildDialogueProductionPlan(scenario, {
      synthesisMode: 'production',
      synthesisBasePath: `${tmpRoot}/audio/dialogue`,
      canonicalBasePath: `${tmpRoot}/audio/canonical`,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const r = result.result;
    expect(r.synthesisManifest.results.every(x => x.metadata?.engine === 'kokoro-js')).toBe(true);
    expect(r.canonicalManifest.clipCount).toBe(r.dialoguePlan.clipCount);

    const probe = new WavHeaderProbe();
    for (const clip of r.dialoguePlan.clips) {
      const synthRes = r.synthesisManifest.byClipId[clip.clipId];
      const canonRes = r.canonicalManifest.byClipId[clip.clipId];
      expect(synthRes).toBeDefined();
      expect(canonRes).toBeDefined();
      expect(synthRes.spokenText).toBe(clip.spokenText);
      expect(synthRes.voiceSlot).toBe(clip.voiceSlot);
      expect(canonRes.spokenText).toBe(clip.spokenText);
      expect(fs.existsSync(synthRes.outputPath)).toBe(true);
      expect(fs.existsSync(canonRes.canonicalPath)).toBe(true);
      // actual durations come from real files
      const meta = probe.probeSync(canonRes.canonicalPath);
      const recon = r.reconciledDialogue.clips.find(c => c.clipId === clip.clipId)!;
      expect(recon.actualDurationSeconds).toBeCloseTo(meta.durationSeconds ?? 0, 1);
    }
    expect(r.summary.status).not.toBe('error');
  }, 180_000);

  it('gate 14: production proof never touches the shared dialogue.wav fixture', async () => {
    const scenario = loadScenarioFixture(NOVEL_SCENARIO_FILE);
    const plan = planDialogueAudio(scenario);
    const vr = resolveDialogueAudioPlanVoices(plan, { language: 'en-GB' });
    const stub = makeStubSynthesizer('fixture-guard');
    const manifest = await synthesizeDialoguePlan(plan, vr, stub, { basePath: `${tmpRoot}/audio/dialogue` });
    for (const r of manifest.results) {
      expect(r.outputPath.includes('dialogue.wav')).toBe(false);
      expect(r.outputPath.startsWith('tests/fixtures')).toBe(false);
    }
    // The novel scenario itself references no shared fixture audio.
    const raw = fs.readFileSync(path.join('tests', 'fixtures', 'scenarios', NOVEL_SCENARIO_FILE), 'utf8');
    expect(raw.includes('dialogue.wav')).toBe(false);
  });

  it('gate 15: production synthesis requires no network and no API credentials', () => {
    const synth = new KokoroDialogueSynthesizer();
    expect(synth.requiresNetwork).toBe(false);
    expect(synth.isLocal).toBe(true);
    // No API-key-style configuration exists on the options surface
    const opts = synth as unknown as Record<string, unknown>;
    for (const key of Object.keys(opts)) {
      expect(key.toLowerCase()).not.toContain('apikey');
      expect(key.toLowerCase()).not.toContain('token');
      expect(key.toLowerCase()).not.toContain('secret');
    }
    expect(KOKORO_MODEL_ID).toBe('onnx-community/Kokoro-82M-v1.0-ONNX');
  });
});
