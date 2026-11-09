/**
 * Pure rules for the explicit video-audio policy. No I/O, no engine: the API supplies measured
 * stream facts, and these rules only decide satisfiability and which clips keep their sound.
 * HTTP/engine evidence (real ffprobe facts, real applies) lives in
 * tests/factory-video-audio-policy-http.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { evaluateVideoAudioPolicy, type VideoAudioShotFact } from '../packages/core/src/factory/video-audio-policy.js';

const voiced = (sceneId: string, assetId = 'v1'): VideoAudioShotFact => ({ sceneId, kind: 'video', hasAudio: true, assetId });
const silent = (sceneId: string, assetId = 'v2'): VideoAudioShotFact => ({ sceneId, kind: 'video', hasAudio: false, assetId });
const unmeasured = (sceneId: string, assetId = 'v3'): VideoAudioShotFact => ({ sceneId, kind: 'video', hasAudio: false, unmeasured: true, assetId });
const still = (sceneId: string): VideoAudioShotFact => ({ sceneId, kind: 'image', hasAudio: false, assetId: 'i1' });

const base = { narrationMode: 'generate' as const, separateAudioAttached: false, hasNarrationWords: true };

describe('evaluateVideoAudioPolicy', () => {
  it('null policy is the legacy muted path: no problems, no kept audio', () => {
    const r = evaluateVideoAudioPolicy({ ...base, policy: null, shots: [voiced('s1')] });
    expect(r.problems).toEqual([]);
    expect(r.keepAudioAssetIds).toEqual([]);
    expect(r.clipsMuted).toBe(true);
  });

  it('original keeps every measured voiced clip and refuses silent ones by name', () => {
    const ok = evaluateVideoAudioPolicy({ ...base, narrationMode: 'none', policy: 'original', shots: [voiced('s1'), voiced('s2', 'v1')] });
    expect(ok.problems).toEqual([]);
    expect(ok.keepAudioAssetIds).toEqual(['v1']);
    expect(ok.clipsMuted).toBe(false);

    const blocked = evaluateVideoAudioPolicy({ ...base, narrationMode: 'none', policy: 'original', shots: [voiced('s1'), silent('s2')] });
    expect(blocked.problems).toHaveLength(1);
    expect(blocked.problems[0].sceneId).toBe('s2');
    expect(blocked.problems[0].reason).toMatch(/no audio stream/);
  });

  it('never calls an unmeasurable clip silent: original and add name the measurement gap precisely', () => {
    for (const policy of ['original', 'add'] as const) {
      const r = evaluateVideoAudioPolicy({ ...base, policy, shots: [unmeasured('s1')] });
      expect(r.problems.some((p) => p.reason.includes('could not be measured'))).toBe(true);
      expect(r.problems.every((p) => !p.reason.includes('no audio stream'))).toBe(true);
    }
  });

  it('add keeps clip audio and requires narration; separate audio or words both satisfy it', () => {
    const needsNarration = evaluateVideoAudioPolicy({ ...base, hasNarrationWords: false, policy: 'add', shots: [voiced('s1')] });
    expect(needsNarration.problems.some((p) => p.kind === 'conflict')).toBe(true);

    const withWords = evaluateVideoAudioPolicy({ ...base, hasNarrationWords: true, policy: 'add', shots: [voiced('s1')] });
    expect(withWords.problems).toEqual([]);
    expect(withWords.keepAudioAssetIds).toEqual(['v1']);

    const withAudio = evaluateVideoAudioPolicy({ ...base, hasNarrationWords: false, separateAudioAttached: true, narrationMode: 'supplied', policy: 'add', shots: [voiced('s1')] });
    expect(withAudio.problems).toEqual([]);
  });

  it('replace mutes every clip and needs narration words or a separate track', () => {
    const blocked = evaluateVideoAudioPolicy({ ...base, narrationMode: 'none', hasNarrationWords: false, policy: 'replace', shots: [voiced('s1')] });
    expect(blocked.problems.some((p) => p.kind === 'conflict')).toBe(true);
    expect(blocked.keepAudioAssetIds).toEqual([]);

    const ok = evaluateVideoAudioPolicy({ ...base, narrationMode: 'supplied', separateAudioAttached: true, hasNarrationWords: false, policy: 'replace', shots: [voiced('s1'), silent('s2')] });
    expect(ok.problems).toEqual([]);
    expect(ok.clipsMuted).toBe(true);
  });

  it('silent mutes everything and conflicts with any non-none narration', () => {
    expect(evaluateVideoAudioPolicy({ ...base, narrationMode: 'none', policy: 'silent', shots: [voiced('s1'), still('s2')] }).problems).toEqual([]);
    const noisy = evaluateVideoAudioPolicy({ ...base, narrationMode: 'generate', policy: 'silent', shots: [voiced('s1')] });
    expect(noisy.problems[0].reason).toMatch(/allows no sound/);
  });

  it('a policy on a stills-only draft names the missing footage', () => {
    const r = evaluateVideoAudioPolicy({ ...base, policy: 'original', narrationMode: 'none', shots: [still('s1')] });
    expect(r.problems[0].reason).toMatch(/needs at least one video clip/);
  });
});
