/**
 * G7 PURE mask/fingerprint tests (no I/O, route, engine or TypeScript-union evidence).
 * Run: node --experimental-transform-types --test tests/factory-masked-correction-pure.test.mjs
 * Real scene/source/hash/revision/Apply checks live in factory-masked-correction.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MASKED_CORRECTION_LIMITS,
  MaskedMaskError,
  canonicalJson,
  encodeCanonicalMask,
  fingerprint,
  makeCanonicalMask,
  maskFingerprint,
  parseCanonicalMask,
} from '../apps/api/src/services/masked-correction-contract.ts';

const original = { width: 4, height: 3 };
const validMask = {
  version: 1,
  coordinateSpace: 'pixels',
  width: 4,
  height: 3,
  regions: [{ x: 1, y: 1, width: 2, height: 1 }],
};
const data = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').toString('base64');
const invalid = (encoded, pattern) => assert.throws(() => parseCanonicalMask(encoded, original), (err) => {
  assert.ok(err instanceof MaskedMaskError);
  if (pattern) assert.match(err.message, pattern);
  return true;
});

test('parses a bounded pixel mask with a nonempty region', () => {
  assert.deepEqual(parseCanonicalMask(data(validMask), original), validMask);
});

test('mask fingerprint is stable across JSON whitespace and key order', () => {
  const spaced = `{\n "regions":[{"height":1,"width":2,"y":1,"x":1}], "height":3, "width":4, "coordinateSpace":"pixels", "version":1 }`;
  assert.equal(maskFingerprint(parseCanonicalMask(data(spaced), original)), maskFingerprint(validMask));
});

test('canonical encoding is identical for semantically identical descriptors', () => {
  const reordered = { regions: validMask.regions, height: 3, width: 4, coordinateSpace: 'pixels', version: 1 };
  assert.equal(encodeCanonicalMask(parseCanonicalMask(data(reordered), original)), encodeCanonicalMask(validMask));
});

test('changing a region changes the mask fingerprint', () => {
  const changed = { ...validMask, regions: [{ x: 0, y: 1, width: 2, height: 1 }] };
  assert.notEqual(maskFingerprint(changed), maskFingerprint(validMask));
});

test('region order remains meaningful instead of being silently sorted', () => {
  const regions = [{ x: 0, y: 0, width: 1, height: 1 }, { x: 2, y: 2, width: 1, height: 1 }];
  assert.notEqual(maskFingerprint({ ...validMask, regions }), maskFingerprint({ ...validMask, regions: [...regions].reverse() }));
});

test('rejects an arbitrary nonempty base64 string as a mask', () => invalid(data('mask'), /JSON|descriptor/i));
test('rejects malformed base64', () => invalid('not base64!', /base64/i));
test('rejects base64 that is not canonical UTF-8 JSON', () => invalid(Buffer.from([0xff, 0xfe, 0xfd]).toString('base64'), /JSON/i));
test('rejects a JSON array descriptor', () => invalid(data([]), /object/i));
test('rejects an unsupported mask version', () => invalid(data({ ...validMask, version: 2 }), /version 1/i));
test('rejects unknown descriptor fields', () => invalid(data({ ...validMask, path: '/tmp/client-controlled' }), /unsupported field/i));
test('rejects empty regions', () => invalid(data({ ...validMask, regions: [] }), /at least one/i));
test('rejects dimensions that disagree with the original', () => invalid(data({ ...validMask, width: 5 }), /must match/i));
test('rejects invalid original dimensions', () => assert.throws(() => parseCanonicalMask(data(validMask), { width: 0, height: 3 }), /Original width/i));
test('rejects negative region coordinates', () => invalid(data({ ...validMask, regions: [{ x: -1, y: 0, width: 1, height: 1 }] }), /non-negative/i));
test('rejects zero-area regions', () => invalid(data({ ...validMask, regions: [{ x: 0, y: 0, width: 0, height: 1 }] }), /positive width/i));
test('rejects fractional region geometry', () => invalid(data({ ...validMask, regions: [{ x: 0.5, y: 0, width: 1, height: 1 }] }), /integer/i));
test('rejects regions outside original bounds', () => invalid(data({ ...validMask, regions: [{ x: 3, y: 2, width: 2, height: 1 }] }), /exceeds/i));
test('rejects unknown region fields', () => invalid(data({ ...validMask, regions: [{ x: 0, y: 0, width: 1, height: 1, opacity: 0.5 }] }), /unsupported field/i));
test('rejects more than the bounded region count', () => {
  const regions = Array.from({ length: MASKED_CORRECTION_LIMITS.maxRegions + 1 }, () => ({ x: 0, y: 0, width: 1, height: 1 }));
  invalid(data({ ...validMask, regions }), /more than 64/i);
});
test('rejects overlong encoded input before decoding', () => invalid('A'.repeat(MASKED_CORRECTION_LIMITS.maxMaskDataChars + 4), /too large/i));
test('rejects decoded payloads over 1 MB', () => {
  const bytes = Buffer.alloc(MASKED_CORRECTION_LIMITS.maxMaskBytes + 1, 32);
  invalid(bytes.toString('base64'), /exceeds 1 MB/i);
});
test('makeCanonicalMask constructs the same verified UI mask', () => {
  assert.deepEqual(makeCanonicalMask(original, validMask.regions), validMask);
});
test('makeCanonicalMask cannot bypass bounds validation', () => {
  assert.throws(() => makeCanonicalMask(original, [{ x: 4, y: 0, width: 1, height: 1 }]), /exceeds/i);
});
test('canonical fingerprint sorts object keys recursively', () => {
  assert.equal(fingerprint({ b: { z: 1, a: 2 }, a: true }), fingerprint({ a: true, b: { a: 2, z: 1 } }));
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
});
test('canonical fingerprint does not erase array order', () => {
  assert.notEqual(fingerprint({ regions: [1, 2] }), fingerprint({ regions: [2, 1] }));
});
test('job/resource limits are finite and explicitly bounded', () => {
  assert.equal(MASKED_CORRECTION_LIMITS.jobsAtOnce, 1);
  assert.equal(MASKED_CORRECTION_LIMITS.maxAttempts, 3);
  assert.ok(MASKED_CORRECTION_LIMITS.maxJobsPerDraft > 0);
  assert.ok(MASKED_CORRECTION_LIMITS.maxTotalJobs >= MASKED_CORRECTION_LIMITS.maxJobsPerDraft);
  assert.ok(MASKED_CORRECTION_LIMITS.maxJobFileBytes >= MASKED_CORRECTION_LIMITS.maxMaskBytes);
  assert.ok(MASKED_CORRECTION_LIMITS.runnerTimeoutMs > 0);
});
