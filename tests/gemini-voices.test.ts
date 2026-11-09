import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
const tmp = vi.hoisted(() => {
  const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const os = process.getBuiltinModule('node:os') as typeof import('node:os');
  const path = process.getBuiltinModule('node:path') as typeof import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'google-voices-'));
  process.env.BUILDTRAKE_DATA = root;
  process.env.GEMINI_API_KEY = 'FIXTURE-ONLY-CATALOG';
  return root;
});
import { isKnownGoogleVoice, refreshGoogleVoices, savedGoogleVoices } from '../apps/api/src/services/gemini-voices.js';
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
describe('Google voice library (labelled metadata doubles, no generation)', () => {
  it('validates catalog voices before allowing selection, and excludes custom or invalid ids', async () => {
    expect(isKnownGoogleVoice('cruz')).toBe(false);
    const fn = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toContain('/voices?'); expect(String(url)).not.toContain('generateContent');
      expect(String(url)).not.toContain('FIXTURE-ONLY');
      expect(init.headers['x-goog-api-key']).toBe('FIXTURE-ONLY-CATALOG');
      return new Response(JSON.stringify({ voices: [
        { id: 'cruz', display_name: 'Cruz', type: 'prebuilt', language_code: 'en-US', gender: 'male', pitch: 'low', description: 'Fixture description' },
        { id: 'kore', display_name: 'Kore', type: 'prebuilt' },
        { id: 'voice_custom', display_name: 'Custom', type: 'prompted' },
        { id: '../escape', type: 'prebuilt' },
      ], next_page_token: 'FIXTURE-NEXT' }));
    });
    const result = await refreshGoogleVoices({ search: 'Cruz' }, fn);
    expect(result.voices.map(v => v.id)).toEqual(['cruz','Kore']);
    expect(result.nextPageToken).toBe('FIXTURE-NEXT'); expect(fn).toHaveBeenCalledOnce();
    expect(isKnownGoogleVoice('cruz')).toBe(true); expect(isKnownGoogleVoice('voice_custom')).toBe(false);
    expect(savedGoogleVoices()[0].description).toBe('Fixture description');
  });
  it('keeps saved choices on provider failure and never retries', async () => {
    const fn = vi.fn(async () => new Response('{}', { status: 429 }));
    await expect(refreshGoogleVoices({}, fn)).rejects.toThrow(/429/);
    expect(fn).toHaveBeenCalledOnce(); expect(isKnownGoogleVoice('cruz')).toBe(true);
  });
  it('refuses invalid filters before any network call', async () => {
    const fn = vi.fn();
    await expect(refreshGoogleVoices({ gender: 'bad' }, fn)).rejects.toThrow(/gender/);
    expect(fn).not.toHaveBeenCalled();
  });
  it('does not reuse catalog eligibility from another key', () => {
    process.env.GEMINI_API_KEY = 'DIFFERENT-FIXTURE';
    expect(savedGoogleVoices()).toEqual([]); expect(isKnownGoogleVoice('cruz')).toBe(false);
    expect(isKnownGoogleVoice('Kore')).toBe(true);
    process.env.GEMINI_API_KEY = 'FIXTURE-ONLY-CATALOG';
  });
});
