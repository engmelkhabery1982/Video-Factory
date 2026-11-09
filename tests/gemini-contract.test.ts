/**
 * Milestone 3 pure contract tests (core, no network). Fixture data is labelled as such.
 * Covers: strict plan validation, religious and product rules, the prompt's data scope,
 * the TTS request shape (verbatim text, separate style), and WAV validation.
 */
import { describe, expect, it } from 'vitest';
import {
  GEMINI_PREBUILT_VOICES,
  buildPlanPrompt,
  buildSpeechRequestBody,
  buildTextRequestBody,
  parseWav,
  validateGeneratedPlan,
} from '@buildtrack/core';
import { educationalCtx, fixtureEducationalPlan, makeWav } from './gemini/helpers.js';

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('strict plan validation (fixture data)', () => {
  it('accepts a complete educational plan with three distinct treatments', () => {
    const r = validateGeneratedPlan(fixtureEducationalPlan(), educationalCtx());
    expect(r.ok).toBe(true);
    expect(r.plan?.treatments.map((t) => t.method)).toEqual([
      'problem_worked_example_action',
      'conversational_walkthrough',
      'result_then_explanation',
    ]);
    expect(r.plan?.productMention.enabled).toBe(false);
  });

  it('rejects a method that is not allowed for the profile', () => {
    const p = clone(fixtureEducationalPlan()) as any;
    p.treatments[1].method = 'passage_then_reflection';
    const r = validateGeneratedPlan(p, educationalCtx());
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/not allowed for educational/);
  });

  it('rejects repeated treatment methods', () => {
    const p = clone(fixtureEducationalPlan()) as any;
    p.treatments[2].method = p.treatments[0].method;
    expect(validateGeneratedPlan(p, educationalCtx()).errors.join(' ')).toMatch(/repeated/);
  });

  it('rejects treatments that only change titles, not shot sequences', () => {
    const p = clone(fixtureEducationalPlan()) as any;
    p.treatments[1].scenes = clone(p.treatments[0].scenes).map((s: any) => ({ ...s, lineIds: s.lineIds }));
    p.treatments[1].scenes[0].lineIds = ['L01', 'L02'];
    p.treatments[1].scenes[1].lineIds = ['L03'];
    p.treatments[1].scenes[1].shotType = 'screen_recording';
    p.treatments[1].scenes.push({ id: 'S3', lineIds: [], shotType: 'wide', visualRequirement: 'x', why: 'x', assetNeed: 'none' });
    const r = validateGeneratedPlan(p, educationalCtx());
    expect(r.ok).toBe(false);
  });

  it('rejects a treatment that drops or repeats a script line', () => {
    const p = clone(fixtureEducationalPlan()) as any;
    p.treatments[0].scenes = p.treatments[0].scenes.slice(0, 2);
    expect(validateGeneratedPlan(p, educationalCtx()).errors.join(' ')).toMatch(/every script line exactly once/);
  });

  it('rejects scenes that refer to unknown lines', () => {
    const p = clone(fixtureEducationalPlan()) as any;
    p.treatments[0].scenes[0].lineIds = ['L99'];
    expect(validateGeneratedPlan(p, educationalCtx()).errors.join(' ')).toMatch(/unknown line "L99"/);
  });

  it('rejects an unknown shot type or asset need', () => {
    const p = clone(fixtureEducationalPlan()) as any;
    p.treatments[0].scenes[0].shotType = 'drone';
    p.treatments[0].scenes[1].assetNeed = 'paid_video';
    const errs = validateGeneratedPlan(p, educationalCtx()).errors.join(' ');
    expect(errs).toMatch(/unknown shotType/);
    expect(errs).toMatch(/unknown assetNeed/);
  });

  it('refuses a source that was not supplied, and refuses a named source on an unverified claim', () => {
    const p = clone(fixtureEducationalPlan()) as any;
    p.sourceNotes = [{ claim: 'Invented study', status: 'supplied_source', sourceRef: 'R-404' }];
    expect(validateGeneratedPlan(p, educationalCtx({ suppliedReferenceIds: ['R1'] })).errors.join(' ')).toMatch(/was not supplied/);
    const q = clone(fixtureEducationalPlan()) as any;
    q.sourceNotes = [{ claim: 'Claim', status: 'needs_verification', sourceRef: 'R1' }];
    expect(validateGeneratedPlan(q, educationalCtx({ suppliedReferenceIds: ['R1'] })).errors.join(' ')).toMatch(/must not name a source/);
  });

  it('keeps product mention off by default and refuses an unrequested mention', () => {
    const p = clone(fixtureEducationalPlan()) as any;
    p.productMention = { enabled: true, factId: 'F1', text: 'Try it' };
    expect(validateGeneratedPlan(p, educationalCtx({ productFactIds: ['F1'] })).errors.join(' ')).toMatch(/was not requested/);
    expect(validateGeneratedPlan(p, educationalCtx({ productFactIds: ['F1'], productMentionRequested: true })).ok).toBe(true);
    expect(validateGeneratedPlan(p, educationalCtx({ productFactIds: [], productMentionRequested: true })).errors.join(' ')).toMatch(/owner-supplied product fact/);
  });

  it('a product mention uses the supplied fact text exactly: added wording or claims are refused', () => {
    const fact = 'Delivery confirmations are logged with the crew name and the time.';
    const ctx = educationalCtx({ productFactIds: ['F1'], productMentionRequested: true, productFactTexts: { F1: fact } });
    const p = clone(fixtureEducationalPlan()) as any;
    p.productMention = { enabled: true, factId: 'F1', text: fact };
    expect(validateGeneratedPlan(p, ctx).ok).toBe(true);
    // Whitespace differences are not wording.
    p.productMention = { enabled: true, factId: 'F1', text: `  ${fact.replace(' ', '   ')}  ` };
    expect(validateGeneratedPlan(p, ctx).ok).toBe(true);
    // Invented wording around the fact is refused.
    p.productMention = { enabled: true, factId: 'F1', text: `${fact} Guaranteed to save a day.` };
    expect(validateGeneratedPlan(p, ctx).errors.join(' ')).toMatch(/exactly/);
    // A fact id that was not supplied with its text is refused.
    p.productMention = { enabled: true, factId: 'F1', text: fact };
    expect(validateGeneratedPlan(p, { ...ctx, productFactTexts: {} }).errors.join(' ')).toMatch(/exactly/);
  });

  it('returns a safe error for non-object output', () => {
    expect(validateGeneratedPlan('nope', educationalCtx()).ok).toBe(false);
    expect(validateGeneratedPlan([], educationalCtx()).ok).toBe(false);
  });
});

describe('religious rules (fixture data)', () => {
  const religiousPlan = () => {
    const p = clone(fixtureEducationalPlan()) as any;
    p.script.lines[0] = { id: 'L01', speaker: 'narrator', language: 'en', text: 'The passage says "be patient" in the supplied text.', quotedSourceRef: 'REF1' };
    p.treatments[0].method = 'passage_then_reflection';
    p.treatments[1].method = 'reflection_then_passage';
    p.treatments[2].method = 'reflection_without_quotation';
    p.treatments.forEach((t: any) => t.scenes.forEach((s: any) => { if (s.shotType === 'screen_recording') s.shotType = 'close_up'; }));
    return p;
  };
  const ctx = { profile: 'religious' as const, suppliedReferenceIds: ['REF1'], productFactIds: [], productMentionRequested: false };

  it('accepts a quotation that cites a supplied reference', () => {
    expect(validateGeneratedPlan(religiousPlan(), ctx).ok).toBe(true);
  });

  it('refuses a quotation with no supplied reference', () => {
    const p = religiousPlan();
    p.script.lines[0].quotedSourceRef = null;
    expect(validateGeneratedPlan(p, ctx).errors.join(' ')).toMatch(/quotes text without a supplied reference/);
  });

  it('refuses a product mention and screen recordings in religious content', () => {
    const p = religiousPlan();
    p.productMention = { enabled: true, factId: 'F1', text: 'Buy' };
    p.treatments[0].scenes[1].shotType = 'screen_recording';
    const errs = validateGeneratedPlan(p, { ...ctx, productFactIds: ['F1'], productMentionRequested: true }).errors.join(' ');
    expect(errs).toMatch(/cannot include a product mention/);
    expect(errs).toMatch(/does not use screen recordings/);
  });
});

describe('prompt data scope and request shapes', () => {
  it('includes only the brief and supplied references, and product facts only when requested', () => {
    const base = {
      profile: 'educational' as const,
      format: 'portrait' as const,
      brief: 'Explain why deliveries need confirmation.',
      references: [{ id: 'R1', text: 'Supplied note about delivery windows.' }],
      productFacts: [{ id: 'F1', text: 'Product fact that must stay out unless requested.' }],
      productMentionRequested: false,
    };
    const p = buildPlanPrompt(base);
    expect(p).toContain('Explain why deliveries');
    expect(p).toContain('R1: Supplied note');
    expect(p).not.toContain('Product fact that must stay out');
    expect(p).toMatch(/product mention is NOT requested/);
    const p2 = buildPlanPrompt({ ...base, productMentionRequested: true });
    expect(p2).toContain('F1: Product fact');
  });

  it('caps max output tokens at 4096 even if asked for more', () => {
    const body = buildTextRequestBody('x', 99999) as any;
    expect(body.generationConfig.maxOutputTokens).toBe(4096);
    expect(body.generationConfig.responseFormat.text.mimeType).toBe('APPLICATION_JSON');
    expect(body.generationConfig.responseFormat.text.schema.required).toContain('treatments');
    expect(body.generationConfig).not.toHaveProperty('responseMimeType');
    expect(body.generationConfig).not.toHaveProperty('responseJsonSchema');
  });

  it('sends verbatim text and keeps delivery style in speech_metadata, never in the text', () => {
    const text = 'وَاعْتَصِمُوا بِحَبْلِ اللَّهِ'; // Arabic diacritics preserved, FIXTURE text
    const body = buildSpeechRequestBody({ text, style: 'calm and slow', voiceName: 'Kore' }) as any;
    const part = body.contents[0].parts[0];
    expect(part.text).toBe(text);
    expect(part.speechMetadata).toEqual({ style: 'calm and slow' });
    expect(body.generationConfig.responseModalities).toEqual(['AUDIO']);
    expect(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Kore');
    expect(body.generationConfig.responseFormat.audio).toEqual({ mimeType: 'AUDIO_WAV', delivery: 'INLINE', sampleRate: 24000 });
    expect(JSON.stringify(body)).not.toMatch(/calm and slow[^"]*"\s*,\s*"text"/);
  });

  it('rejects angle-bracket tags, empty text, and overlong text or style', () => {
    expect(() => buildSpeechRequestBody({ text: 'Wait <pause> now', style: '', voiceName: 'Kore' })).toThrow(/angle-bracket/);
    expect(() => buildSpeechRequestBody({ text: '   ', style: '', voiceName: 'Kore' })).toThrow(/empty/);
    expect(() => buildSpeechRequestBody({ text: 'x'.repeat(351), style: '', voiceName: 'Kore' })).toThrow(/limit/);
    expect(() => buildSpeechRequestBody({ text: 'ok', style: 's'.repeat(201), voiceName: 'Kore' })).toThrow(/limit/);
  });

  it('lists the 30 documented prebuilt voices and nothing else', () => {
    expect(GEMINI_PREBUILT_VOICES).toHaveLength(30);
    expect(GEMINI_PREBUILT_VOICES).toContain('Kore');
    expect(GEMINI_PREBUILT_VOICES).toContain('Puck');
  });
});

describe('WAV validation (synthesized fixture WAV files)', () => {
  it('accepts a 24 kHz mono 16-bit PCM file and reports duration', () => {
    const w = parseWav(makeWav({ seconds: 2 }));
    expect(w.valid).toBe(true);
    expect(w.sampleRate).toBe(24000);
    expect(w.channels).toBe(1);
    expect(w.bitsPerSample).toBe(16);
    expect(w.durationSec).toBe(2);
  });

  it('accepts stereo 16-bit PCM', () => {
    expect(parseWav(makeWav({ seconds: 1, channels: 2 })).valid).toBe(true);
  });

  it('rejects non-RIFF, non-PCM, 8-bit, empty and too-short data', () => {
    expect(parseWav(new Uint8Array(100)).valid).toBe(false);
    expect(parseWav(makeWav({ seconds: 1, format: 3 })).reason).toMatch(/not PCM/);
    expect(parseWav(makeWav({ seconds: 1, bits: 8 })).reason).toMatch(/not 16-bit/);
    expect(parseWav(makeWav({ seconds: 1, dataBytesOverride: 0 })).reason).toMatch(/no audio data/);
    expect(parseWav(new Uint8Array(10)).reason).toMatch(/shorter/);
  });

  it('rejects an unsupported sample rate', () => {
    expect(parseWav(makeWav({ seconds: 1, sampleRate: 96000 })).reason).toMatch(/sample rate/);
  });
});
