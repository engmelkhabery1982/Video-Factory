/**
 * Channel identity of an editor document. This is the ONE place that decides
 * what the editor UI, the preview renderer and the final export show as the
 * channel identity. The document's `channelBrandId` is authoritative; the
 * legacy project `brandPreset` is only the default it was created from.
 *
 * Rules (closure round, Gate 3):
 * - blank / null  -> no identity is bound. It is never displayed as BuildTrack.
 * - a religious document with BuildTrack, or an unregistered preset -> refused.
 * - a registered preset that owns a logo asset -> bound.
 * - a registered preset without a logo -> not bound (no logo is invented).
 */
import { getBrandPreset } from '../brand.js';
import type { BrandPreset } from '../types.js';
import { resolveContentBrand } from '../content-led.js';

export type DocumentIdentityStatus = 'none' | 'bound' | 'refused';

export interface DocumentIdentity {
  status: DocumentIdentityStatus;
  /** Set only when status is `bound`. Never set for `none` or `refused`. */
  brand: BrandPreset | null;
  /** The brand that owns the logo asset id, when bound. */
  logoAssetId: string | null;
  /** The preset id the document asked for (null when blank). */
  requestedId: string | null;
  refusal: string | null;
}

export function resolveDocumentIdentity(doc: { channelBrandId: string | null; contentProfile: string }): DocumentIdentity {
  const requested = (doc.channelBrandId ?? '').trim();
  if (!requested) {
    return { status: 'none', brand: null, logoAssetId: null, requestedId: null, refusal: null };
  }
  const r = resolveContentBrand({ brandPreset: requested, contentProfile: doc.contentProfile });
  if (r.refusedPreset) {
    return { status: 'refused', brand: null, logoAssetId: null, requestedId: requested, refusal: r.refusal };
  }
  if (r.identityBound) {
    return { status: 'bound', brand: r.brand, logoAssetId: r.brand.logoAssetId, requestedId: requested, refusal: null };
  }
  return { status: 'none', brand: null, logoAssetId: null, requestedId: requested, refusal: r.refusal };
}

/** The neutral visual system used when no identity is bound. It has no name and no logo. */
export function unboundVisualSystem(profile: string): BrandPreset {
  return getBrandPreset(profile === 'educational' ? 'unbound-educational' : 'unbound-religious');
}
