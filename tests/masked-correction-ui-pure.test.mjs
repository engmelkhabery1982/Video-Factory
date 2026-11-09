/** PURE browser-mask assembly tests; no DOM, runner, image output or engine claim. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMaskedCorrectionData, parseMaskInteger } from '../apps/web/src/lib/masked-correction.ts';
import { parseCanonicalMask } from '../apps/api/src/services/masked-correction-contract.ts';

const original = { width: 4, height: 3 };

test('browser mask is accepted by the canonical server parser', () => {
  const encoded = makeMaskedCorrectionData(original, { x: 1, y: 1, width: 2, height: 1 });
  const parsed = parseCanonicalMask(encoded, original);
  assert.deepEqual(parsed.regions, [{ x: 1, y: 1, width: 2, height: 1 }]);
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), JSON.stringify(parsed));
});

test('browser mask uses original pixel dimensions rather than display dimensions', () => {
  const parsed = parseCanonicalMask(makeMaskedCorrectionData(original, { x: 0, y: 0, width: 4, height: 3 }), original);
  assert.equal(parsed.width, 4);
  assert.equal(parsed.height, 3);
  assert.equal(parsed.coordinateSpace, 'pixels');
});

test('out-of-bounds browser masks are rejected before submission', () => {
  assert.throws(() => makeMaskedCorrectionData(original, { x: 3, y: 2, width: 2, height: 1 }), /fit inside/);
  assert.throws(() => makeMaskedCorrectionData(original, { x: -1, y: 0, width: 1, height: 1 }), /non-negative/);
  assert.throws(() => makeMaskedCorrectionData(original, { x: 0, y: 0, width: 0, height: 1 }), /positive/);
});

test('fractional geometry is rejected instead of rounded', () => {
  assert.throws(() => makeMaskedCorrectionData(original, { x: 0.5, y: 0, width: 1, height: 1 }), /integers/);
});

test('integer form fields reject blank, decimal and unsafe values', () => {
  assert.equal(parseMaskInteger(' 12 ', 'x'), 12);
  for (const value of ['', '1.5', '1e2', 'abc', '9007199254740992']) {
    assert.throws(() => parseMaskInteger(value, 'x'));
  }
});

test('negative integer syntax is parsed and then rejected by region bounds', () => {
  assert.equal(parseMaskInteger('-1', 'x'), -1);
  assert.throws(() => makeMaskedCorrectionData(original, { x: parseMaskInteger('-1', 'x'), y: 0, width: 1, height: 1 }), /non-negative/);
});
