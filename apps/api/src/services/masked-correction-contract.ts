/**
 * Pure, dependency-free contract for G7 masked/regional correction.
 *
 * The HTTP service owns asset/draft I/O. This module owns the canonical mask
 * representation and fingerprints so formatting, key order or an arbitrary
 * non-empty string can never stand in for a real mask or a fresh review.
 */
import { createHash } from 'node:crypto';

export const MASKED_CORRECTION_CONTRACT_VERSION = 1 as const;
export const MASKED_CORRECTION_LIMITS = Object.freeze({
  maxMaskBytes: 1024 * 1024,
  maxMaskDataChars: 1_500_000,
  maxRegions: 64,
  maxInstructionChars: 2000,
  maxJobsPerDraft: 50,
  maxTotalJobs: 500,
  maxJobFileBytes: 2 * 1024 * 1024,
  maxAttempts: 3,
  jobsAtOnce: 1,
  runnerTimeoutMs: 15 * 60 * 1000,
});

export interface MaskRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Pixel rectangles are unioned by the runner. Region order is retained for review. */
export interface CanonicalMask {
  version: 1;
  coordinateSpace: 'pixels';
  width: number;
  height: number;
  regions: MaskRegion[];
}

export class MaskedMaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaskedMaskError';
  }
}

function positiveDimension(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 16_384) {
    throw new MaskedMaskError(`${label} must be a positive integer no greater than 16384.`);
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new MaskedMaskError(`${label} contains unsupported field ${unknown[0]}.`);
}

function regionOf(raw: unknown, index: number, width: number, height: number): MaskRegion {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new MaskedMaskError(`Mask region ${index + 1} must be an object.`);
  }
  const value = raw as Record<string, unknown>;
  exactKeys(value, ['x', 'y', 'width', 'height'], `Mask region ${index + 1}`);
  const x = value.x;
  const y = value.y;
  const w = value.width;
  const h = value.height;
  for (const [label, n] of [['x', x], ['y', y], ['width', w], ['height', h]] as const) {
    if (typeof n !== 'number' || !Number.isSafeInteger(n)) {
      throw new MaskedMaskError(`Mask region ${index + 1} ${label} must be an integer.`);
    }
  }
  const region = { x: x as number, y: y as number, width: w as number, height: h as number };
  if (region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0) {
    throw new MaskedMaskError(`Mask region ${index + 1} must have non-negative x/y and positive width/height.`);
  }
  if (region.x + region.width > width || region.y + region.height > height) {
    throw new MaskedMaskError(`Mask region ${index + 1} exceeds the original image bounds ${width}x${height}.`);
  }
  return region;
}

/** Parse the only supported mask format: base64 of the canonical JSON descriptor. */
export function parseCanonicalMask(maskData: unknown, original: { width: number; height: number }): CanonicalMask {
  if (typeof maskData !== 'string' || maskData.trim().length === 0) {
    throw new MaskedMaskError('maskData is required: base64 JSON with version 1, pixel dimensions and at least one region.');
  }
  const encoded = maskData.trim();
  if (encoded.length > MASKED_CORRECTION_LIMITS.maxMaskDataChars) {
    throw new MaskedMaskError('maskData is too large (maximum 1 MB decoded).');
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new MaskedMaskError('maskData must be canonical base64 (padding included).');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0 || bytes.length > MASKED_CORRECTION_LIMITS.maxMaskBytes || bytes.toString('base64') !== encoded) {
    throw new MaskedMaskError('maskData is not valid canonical base64 or exceeds 1 MB decoded.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new MaskedMaskError('maskData must decode to a JSON mask descriptor, not arbitrary text or image data.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MaskedMaskError('The mask descriptor must be a JSON object.');
  }
  const value = parsed as Record<string, unknown>;
  exactKeys(value, ['version', 'coordinateSpace', 'width', 'height', 'regions'], 'The mask descriptor');
  if (value.version !== 1 || value.coordinateSpace !== 'pixels') {
    throw new MaskedMaskError('The mask descriptor must use version 1 and coordinateSpace "pixels".');
  }
  const width = positiveDimension(value.width, 'Mask width');
  const height = positiveDimension(value.height, 'Mask height');
  const originalWidth = positiveDimension(original.width, 'Original width');
  const originalHeight = positiveDimension(original.height, 'Original height');
  if (width !== originalWidth || height !== originalHeight) {
    throw new MaskedMaskError(`Mask dimensions ${width}x${height} must match the original image ${originalWidth}x${originalHeight}.`);
  }
  if (!Array.isArray(value.regions) || value.regions.length === 0) {
    throw new MaskedMaskError('The mask must contain at least one non-empty region.');
  }
  if (value.regions.length > MASKED_CORRECTION_LIMITS.maxRegions) {
    throw new MaskedMaskError(`The mask has more than ${MASKED_CORRECTION_LIMITS.maxRegions} regions.`);
  }
  return {
    version: 1,
    coordinateSpace: 'pixels',
    width,
    height,
    regions: value.regions.map((region, index) => regionOf(region, index, width, height)),
  };
}

/** Recursively sort object keys. Arrays retain their semantic order. */
export function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(source).sort().map((key) => [key, canonicalValue(source[key])]));
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function maskFingerprint(mask: CanonicalMask): string {
  return fingerprint({ kind: 'vf-mask-v1', mask });
}

export function encodeCanonicalMask(mask: CanonicalMask): string {
  return Buffer.from(JSON.stringify(mask), 'utf8').toString('base64');
}

/** Build a mask from the current UI without allowing fractional/out-of-bounds values. */
export function makeCanonicalMask(original: { width: number; height: number }, regions: MaskRegion[]): CanonicalMask {
  const candidate: CanonicalMask = { version: 1, coordinateSpace: 'pixels', width: original.width, height: original.height, regions };
  return parseCanonicalMask(encodeCanonicalMask(candidate), original);
}
