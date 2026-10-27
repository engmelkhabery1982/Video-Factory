/**
 * No-material starting point: deterministic rule-based topic suggestions.
 * Pure unit evidence (no I/O, no provider). These are labelled local_rules:
 * they prove determinism and profile/language differences, not semantic AI.
 */
import { describe, expect, it } from 'vitest';
import { purposeKeywords, suggestTopics } from '../packages/core/src/factory/topic-starter.js';

describe('topic starter: deterministic local rules, not semantic AI', () => {
  it('returns three suggestions labelled local_rules for every profile', () => {
    for (const profile of ['religious', 'educational', 'promotional'] as const) {
      const r = suggestTopics(profile);
      expect(r.route).toBe('local_rules');
      expect(r.language).toBe('en');
      expect(r.suggestions).toHaveLength(3);
      expect(r.suggestions.every((s) => s.id && s.title && s.angle && s.nextStep)).toBe(true);
      expect(new Set(r.suggestions.map((s) => s.id))).toEqual(new Set(['topic-1', 'topic-2', 'topic-3']));
    }
  });

  it('is deterministic: the same inputs give byte-identical output', () => {
    const a = suggestTopics('educational', 'crane safety training on site');
    const b = suggestTopics('educational', 'crane safety training on site');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('weaves the first channel-purpose keyword into educational and promotional titles', () => {
    const r = suggestTopics('educational', 'A channel about concrete mixing');
    expect(r.suggestions.some((s) => s.title.includes('concrete'))).toBe(true);
  });

  it('falls back to the profile anchor topic when the purpose has no usable keyword', () => {
    const r = suggestTopics('promotional', '');
    expect(r.suggestions[0].title.length).toBeGreaterThan(5);
    const again = suggestTopics('promotional', 'the and for you'); // stop words only
    expect(again.suggestions[0].title).toBe(r.suggestions[0].title);
  });

  it('religious suggestions stay thematic and contain no generated scripture or quotation marks', () => {
    const r = suggestTopics('religious', '');
    const all = r.suggestions.map((s) => `${s.title} ${s.angle}`).join(' ');
    expect(all).not.toMatch(/[﴿﴾«»"“"]/);
    expect(r.suggestions.every((s) => /passage|supplied|النص|مراجَع/i.test(s.nextStep + s.angle))).toBe(true);
  });

  it('detects an Arabic purpose and returns Arabic-labelled suggestions', () => {
    const r = suggestTopics('educational', 'قناة عن السلامة المهنية في المصانع');
    expect(r.language).toBe('ar');
    expect(r.suggestions.every((s) => /[\u0600-\u06FF]/.test(s.title))).toBe(true);
  });

  it('clamps the requested count between 1 and 6', () => {
    expect(suggestTopics('educational', '', { count: 0 }).suggestions).toHaveLength(1);
    expect(suggestTopics('educational', '', { count: 99 }).suggestions).toHaveLength(6);
    expect(suggestTopics('educational', '', { count: 2 }).suggestions).toHaveLength(2);
  });

  it('keyword extraction drops stop words, de-duplicates and caps at three', () => {
    expect(purposeKeywords('crane crane boom the and safety', 'en')).toEqual(['crane', 'boom', 'safety']);
    const ar = purposeKeywords('السلامة السلامة في المصانع مع', 'ar');
    expect(ar[0]).toBe('السلامة');
    expect(ar).not.toContain('في');
    expect(ar).not.toContain('مع');
  });

  it('the three profiles give meaningfully different angles for the same purpose', () => {
    const purpose = 'pump maintenance';
    const angles = new Set(['religious', 'educational', 'promotional'].map((p) => suggestTopics(p, purpose).suggestions[0].angle));
    expect(angles.size).toBe(3);
  });
});
