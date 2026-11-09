import { describe, expect, it } from 'vitest';
import { buildSpeechRequestBody, buildTextRequestBody } from '@buildtrack/core';
import { generateContentRaw, parseSpeechResponse, parseStructuredText } from '../apps/api/src/services/gemini-client.js';
import { b64, makeWav, scriptedFetch } from './gemini/helpers.js';

describe('Model-specific REST contracts (labelled fixtures, no network)', () => {
  it('uses Interactions with JSON schema for the current 3.8 planning model', async () => {
    const fixture = { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"fixture":true}' }] }] };
    const fx = scriptedFetch([{ kind: 'json', status: 200, body: fixture }]);
    const result = await generateContentRaw({ model: 'gemini-3.8-flash', apiKey: 'FIXTURE_ONLY', timeoutMs: 1000, fetchImpl: fx.fn, body: buildTextRequestBody('fixture') });
    expect(fx.calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(fx.calls[0].body.input).toBe('fixture');
    expect(fx.calls[0].body.response_format.mime_type).toBe('application/json');
    expect(fx.calls[0].body.response_format.schema.required).toContain('treatments');
    expect(fx.calls[0].body.store).toBe(false);
    expect(parseStructuredText(result).value).toEqual({ fixture: true });
    expect(() => parseStructuredText({ status: 'failed', steps: [] })).toThrow(/did not complete/);
  });
  it.each(['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'])('uses the documented Interactions contract for %s', async model => {
    const bytes = makeWav({ seconds: 1 });
    const fixture = { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/wav', data: b64(bytes) }] }] };
    const fx = scriptedFetch([{ kind: 'json', status: 200, body: fixture }]);
    const response = await generateContentRaw({ model, apiKey: 'FIXTURE_ONLY', timeoutMs: 1000, fetchImpl: fx.fn,
      body: buildSpeechRequestBody({ text: 'مرحبا', style: 'calm', voiceName: 'Kore', language: 'ar' }) });
    expect(fx.calls).toHaveLength(1);
    expect(fx.calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(fx.calls[0].body).toEqual({ model, store: false, input: [{ type: 'user_input', content: [{ type: 'text', text: 'مرحبا', annotations: [{ type: 'speech_metadata', style: 'calm' }] }] }], response_format: { type: 'audio' }, generation_config: { speech_config: [{ voice: 'Kore' }] } });
    expect(parseSpeechResponse(response).bytes).toEqual(bytes);
  });
  it('uses the established JSON schema fields for 2.5 text, without a retry', async () => {
    const fx = scriptedFetch([{ kind: 'json', status: 404, body: {} }]);
    await expect(generateContentRaw({ model: 'gemini-2.5-flash', apiKey: 'FIXTURE_ONLY', timeoutMs: 1000, fetchImpl: fx.fn, body: buildTextRequestBody('fixture') })).rejects.toThrow(/not found/);
    expect(fx.calls).toHaveLength(1);
    expect(fx.calls[0].body.generationConfig.responseMimeType).toBe('application/json');
    expect(fx.calls[0].body.generationConfig.responseJsonSchema).toBeTruthy();
    expect(fx.calls[0].body.generationConfig.responseFormat).toBeUndefined();
  });
  it.each(['in_progress', 'failed', 'cancelled'])('refuses an incomplete %s interaction', status => {
    expect(() => parseSpeechResponse({ status, steps: [] })).toThrow(/did not complete/);
  });
  it('refuses multiple returned audio blocks instead of silently dropping speech', () => {
    expect(() => parseSpeechResponse({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'audio' }, { type: 'audio' }] }] })).toThrow(/exactly one/);
  });
});
