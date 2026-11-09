/** Gate 3: one channel-identity resolver for the document. Code-level, no browser. */
import { describe, expect, it } from 'vitest';
import { resolveDocumentIdentity } from '../packages/core/src/editor/identity.js';

describe('channel identity of an editor document (Gate 3)', () => {
  it('a blank identity is NOT bound and is never shown as BuildTrack, for any profile', () => {
    for (const contentProfile of ['religious', 'educational', 'promotional']) {
      const id = resolveDocumentIdentity({ channelBrandId: null, contentProfile });
      expect(id.status).toBe('none');
      expect(id.brand).toBeNull();
      expect(id.logoAssetId).toBeNull();
    }
    expect(resolveDocumentIdentity({ channelBrandId: '   ', contentProfile: 'promotional' }).status).toBe('none');
  });

  it('religious content with no identity stays unbound; BuildTrack is refused, never substituted', () => {
    expect(resolveDocumentIdentity({ channelBrandId: 'unbound-religious', contentProfile: 'religious' }).status).toBe('none');
    const refused = resolveDocumentIdentity({ channelBrandId: 'buildtrack', contentProfile: 'religious' });
    expect(refused.status).toBe('refused');
    expect(refused.brand).toBeNull();
    expect(refused.refusal).toContain('BuildTrack was not substituted');
  });

  it('a deliberate educational BuildTrack selection resolves to the bound brand that owns its logo', () => {
    const bound = resolveDocumentIdentity({ channelBrandId: 'buildtrack', contentProfile: 'educational' });
    expect(bound.status).toBe('bound');
    expect(bound.brand?.id).toBe('buildtrack');
    expect(bound.logoAssetId).toBe('brand-logo-buildtrack');
  });

  it('an unregistered preset is refused with a clear reason, not silently replaced', () => {
    const r = resolveDocumentIdentity({ channelBrandId: 'owner-religious-channel', contentProfile: 'religious' });
    expect(r.status).toBe('refused');
    expect(r.refusal).toContain('is not registered');
  });
});
