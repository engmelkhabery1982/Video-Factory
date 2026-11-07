/**
 * G7: Masked / regional still correction — PURE-CONTRACT tests.
 *
 * Run: node --experimental-transform-types --test tests/factory-masked-correction-pure.test.mjs
 *
 * These exercise the masked-correction service with stubbed factory-service
 * and @buildtrack/core dependencies. They are NOT HTTP evidence. The HTTP
 * integration test (factory-masked-correction.test.ts) covers the real routes.
 *
 * The mock runner is a LABELLED TEST DOUBLE. It is NOT a real inpainting
 * engine. Real correction remains NOT RUN.
 */
import { registerHooks } from 'node:module';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// --- Module resolution: map @buildtrack/core and factory-service to in-memory stubs ---
// The stubs are provided via the `load` hook so no external files are needed.
const CORE_STUB = `
export class FactoryError extends Error {
  constructor(code, message, status = 422, details = {}) {
    super(message);
    this.name = 'FactoryError';
    this.code = code;
    this.status = status;
    this.missing = details.missing;
    this.details = details.details;
    this.currentRevision = details.currentRevision;
  }
}
`;

const FACTORY_SERVICE_STUB = `
export function getDraft(draftId) {
  return { draftId, revision: 0 };
}
export function bindLocalImage(draftId, body) {
  return { draftId, revision: 1 };
}
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@buildtrack/core') {
      return { url: 'data:text/javascript,' + encodeURIComponent(CORE_STUB), format: 'module', shortCircuit: true };
    }
    if (specifier.includes('factory-service')) {
      return { url: 'data:text/javascript,' + encodeURIComponent(FACTORY_SERVICE_STUB), format: 'module', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const {
  createMaskedCorrection,
  getMaskedCorrection,
  listMaskedCorrections,
  reviewMaskedCorrection,
  applyMaskedCorrection,
  createMockRunner,
  setMaskedCorrectionRunner,
  getMaskedCorrectionRunner,
  resetMaskedCorrectionForTests,
} = await import(
  '../apps/api/src/services/masked-correction.ts'
);

// --- Helpers ---

const DRAFT_ID = 'test-draft';
const SCENE_ID = 'scene-1';
const ASSET_ID = 'asset-1';
const ASSET_SHA = 'a'.repeat(64);
const MASK_DATA = Buffer.from('{"type":"mask","regions":[]}').toString('base64');

function makeBody(overrides = {}) {
  return {
    expectedRevision: 0,
    maskData: MASK_DATA,
    originalAssetId: ASSET_ID,
    originalHash: ASSET_SHA,
    instructions: 'Remove clutter',
    ...overrides,
  };
}

async function waitJob(jobId) {
  for (let i = 0; i < 100; i++) {
    const job = getMaskedCorrection(jobId);
    if (job.status !== 'pending' && job.status !== 'running') return job;
    await new Promise((res) => setTimeout(res, 1));
  }
  throw new Error('job did not finish');
}

// --- Reset before each test ---
beforeEach(() => {
  resetMaskedCorrectionForTests();
});

// --- Tests ---

test('creates a job and runs it to completion with the mock runner', async () => {
  setMaskedCorrectionRunner(createMockRunner({ resultAssetId: ASSET_ID, resultHash: ASSET_SHA }));
  const job = createMaskedCorrection(DRAFT_ID, SCENE_ID, makeBody());
  assert.equal(job.status, 'pending');
  assert.equal(job.originalAssetId, ASSET_ID);
  assert.equal(job.originalHash, ASSET_SHA);
  assert.match(job.maskHash, /^[0-9a-f]{64}$/);

  const done = await waitJob(job.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.resultAssetId, ASSET_ID);
  assert.equal(done.resultHash, ASSET_SHA);
  assert.equal(done.error, null);
});

test('rejects creation with wrong revision', () => {
  setMaskedCorrectionRunner(createMockRunner());
  try {
    createMaskedCorrection(DRAFT_ID, SCENE_ID, makeBody({ expectedRevision: 999 }));
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, 'FACTORY_REVISION_CONFLICT');
    assert.equal(err.status, 409);
  }
});

test('rejects creation without maskData', () => {
  setMaskedCorrectionRunner(createMockRunner());
  try {
    createMaskedCorrection(DRAFT_ID, SCENE_ID, makeBody({ maskData: '' }));
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, 'FACTORY_VALIDATION');
    assert.equal(err.status, 422);
  }
});

test('rejects creation without originalAssetId', () => {
  setMaskedCorrectionRunner(createMockRunner());
  try {
    createMaskedCorrection(DRAFT_ID, SCENE_ID, makeBody({ originalAssetId: '' }));
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, 'FACTORY_VALIDATION');
  }
});

test('rejects creation without originalHash', () => {
  setMaskedCorrectionRunner(createMockRunner());
  try {
    createMaskedCorrection(DRAFT_ID, SCENE_ID, makeBody({ originalHash: '' }));
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, 'FACTORY_VALIDATION');
  }
});

test('rejects creation with non-object body', () => {
  setMaskedCorrectionRunner(createMockRunner());
  try {
    createMaskedCorrection(DRAFT_ID, SCENE_ID, 'not an object');
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, 'FACTORY_VALIDATION');
  }
});

test('reviews a completed job: approved sets status to reviewed', async () => {
  setMaskedCorrectionRunner(createMockRunner({ resultAssetId: ASSET_ID, resultHash: ASSET_SHA }));
  const job = createMaskedCorrection(DRAFT_ID, SCENE_ID, makeBody());
  await waitJob(job.id);

  const reviewed = reviewMaskedCorrection(job.id, { state: 'approved', notes: 'Looks good' });
  assert.equal(reviewed.status, 'reviewed');
  assert.equal(reviewed.reviewed, true);
  assert.equal(reviewed.reviewNotes, 'Looks good');
});

test('reviews a completed job: rejected sets status to rejected', async () => {
  setMaskedCorrectionRunner(createMockRunner({ resultAssetId: ASSET_ID, resultHash: ASSET_SHA }));
  const job = createMaskedCorrection(DRAFT_ID, SCENE_ID, makeBody());
  await waitJob(job.id);

  const rejected = reviewMaskedCorrection(job.id, { state: 'rejected', notes: 'Artifacts visible' });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reviewed, true);
});

test('rejects review of a non-completed job', () => {
  setMaskedCorrectionRunner(createMockRunner({ delayMs: 100 }));
  const job = createMaskedCorrection(DRAFT_ID, SCENE_ID, makeBody());
  // Job is still pending
  try {
    reviewMaskedCorrection(job.id, { state: 'approved' });
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, 'FACTORY_VALIDATION');
  }
});

test('rejects review with invalid state', async () => {
  setMaskedCorrectionRunner(createMockRunner({ resultAssetId: ASSET_ID, resultHash: ASSET_SHA }));
  const job = createMaskedCorrection(DRAFT_ID, SCENE_ID, makeBody());
  await waitJob(job.id);

  try {
    reviewMaskedCorrection(job.id, { state: 'maybe' });
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, 'FACTORY_VALIDATION');
  }
});

test('rejects apply of a job that is not reviewed', async () => {
  setMaskedCorrectionRunner(createMockRunner({ resultAssetId: ASSET_ID, resultHash: ASSET_SHA }));
  const job = createMaskedCorrection(DRAFT_ID, SCENE_ID, makeBody());
  await waitJob(job.id);
  // Job is completed but not reviewed

  try {
    applyMaskedCorrection(job.id, { expectedRevision: 0 });
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, 'FACTORY_VALIDATION');
  }
});

test('rejects apply of a job that is not completed', () => {
  setMaskedCorrectionRunner(createMockRunner({ delayMs: 100 }));
  const job = createMaskedCorrection(DRAFT_ID, SCENE_ID, makeBody());
  // Job is still pending

  try {
    applyMaskedCorrection(job.id, { expectedRevision: 0 });
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, 'FACTORY_VALIDATION');
  }
});

test('applies a reviewed job and binds the corrected still', async () => {
  setMaskedCorrectionRunner(createMockRunner({ resultAssetId: ASSET_ID, resultHash: ASSET_SHA }));
  const job = createMaskedCorrection(DRAFT_ID, SCENE_ID, makeBody());
  await waitJob(job.id);
  const reviewed = reviewMaskedCorrection(job.id, { state: 'approved' });
  assert.equal(reviewed.status, 'reviewed');

  const result = applyMaskedCorrection(job.id, { expectedRevision: 0 });
  assert.equal(result.draftId, DRAFT_ID);
  assert.equal(result.revision, 1);

  const done = getMaskedCorrection(job.id);
  assert.equal(done.status, 'applied');
});

test('gets a job by ID and returns error for unknown', () => {
  const job = createMaskedCorrection(DRAFT_ID, SCENE_ID, makeBody());
  const got = getMaskedCorrection(job.id);
  assert.equal(got.id, job.id);

  try {
    getMaskedCorrection('mc-nonexistent');
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, 'FACTORY_MASKED_CORRECTION_NOT_FOUND');
    assert.equal(err.status, 404);
  }
});

test('lists jobs for a draft', () => {
  setMaskedCorrectionRunner(createMockRunner());
  const j1 = createMaskedCorrection(DRAFT_ID, SCENE_ID, makeBody());
  const j2 = createMaskedCorrection(DRAFT_ID, SCENE_ID, makeBody());
  const list = listMaskedCorrections(DRAFT_ID);
  assert.equal(list.length, 2);
  assert.ok(list.some((j) => j.id === j1.id));
  assert.ok(list.some((j) => j.id === j2.id));
});

test('handles runner failure: job becomes failed with error', async () => {
  setMaskedCorrectionRunner(createMockRunner({ fail: true }));
  const job = createMaskedCorrection(DRAFT_ID, SCENE_ID, makeBody());
  const done = await waitJob(job.id);
  assert.equal(done.status, 'failed');
  assert.match(done.error, /Mock runner forced failure/);
});

test('throws when runner is not set', async () => {
  resetMaskedCorrectionForTests(); // Clears runner
  const job = createMaskedCorrection(DRAFT_ID, SCENE_ID, makeBody());
  // The runner is null, so getMaskedCorrectionRunner should throw
  // But the job is created synchronously — the error is caught in runJob
  const done = getMaskedCorrection(job.id);
  assert.equal(done.status, 'pending');
  // Wait for the async runJob to catch the error
  const finished = await waitJob(job.id);
  assert.equal(finished.status, 'failed');
  assert.match(finished.error, /No masked correction runner configured/);
});

test('computes a stable maskHash for the same mask data', () => {
  setMaskedCorrectionRunner(createMockRunner());
  const j1 = createMaskedCorrection(DRAFT_ID, SCENE_ID, makeBody());
  const j2 = createMaskedCorrection(DRAFT_ID, SCENE_ID, makeBody());
  assert.equal(j1.maskHash, j2.maskHash);
  assert.match(j1.maskHash, /^[0-9a-f]{64}$/);
});

test('records provenance: originalHash, maskHash, resultHash are all tracked', async () => {
  setMaskedCorrectionRunner(createMockRunner({ resultAssetId: ASSET_ID, resultHash: ASSET_SHA }));
  const job = createMaskedCorrection(DRAFT_ID, SCENE_ID, makeBody());
  const done = await waitJob(job.id);
  assert.equal(done.originalAssetId, ASSET_ID);
  assert.equal(done.originalHash, ASSET_SHA);
  assert.match(done.maskHash, /^[0-9a-f]{64}$/);
  assert.equal(done.resultAssetId, ASSET_ID);
  assert.equal(done.resultHash, ASSET_SHA);
  assert.equal(done.revision, 0);
});

test('truncates instructions to 2000 characters', () => {
  setMaskedCorrectionRunner(createMockRunner());
  const longInstructions = 'x'.repeat(3000);
  const job = createMaskedCorrection(DRAFT_ID, SCENE_ID, makeBody({ instructions: longInstructions }));
  assert.equal(job.parameters.instructions.length, 2000);
});

test('truncates review notes to 2000 characters', async () => {
  setMaskedCorrectionRunner(createMockRunner({ resultAssetId: ASSET_ID, resultHash: ASSET_SHA }));
  const job = createMaskedCorrection(DRAFT_ID, SCENE_ID, makeBody());
  await waitJob(job.id);
  const longNotes = 'y'.repeat(3000);
  const reviewed = reviewMaskedCorrection(job.id, { state: 'approved', notes: longNotes });
  assert.equal(reviewed.reviewNotes.length, 2000);
});

test('rejects creation with maskData exceeding 5 MB', () => {
  setMaskedCorrectionRunner(createMockRunner());
  const bigMask = 'a'.repeat(5_000_001);
  try {
    createMaskedCorrection(DRAFT_ID, SCENE_ID, makeBody({ maskData: bigMask }));
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, 'FACTORY_VALIDATION');
  }
});

test('original is preserved: apply does not modify originalAssetId or originalHash', async () => {
  setMaskedCorrectionRunner(createMockRunner({ resultAssetId: ASSET_ID, resultHash: ASSET_SHA }));
  const job = createMaskedCorrection(DRAFT_ID, SCENE_ID, makeBody());
  await waitJob(job.id);
  reviewMaskedCorrection(job.id, { state: 'approved' });
  applyMaskedCorrection(job.id, { expectedRevision: 0 });

  const done = getMaskedCorrection(job.id);
  // The original is still tracked — never destroyed
  assert.equal(done.originalAssetId, ASSET_ID);
  assert.equal(done.originalHash, ASSET_SHA);
  assert.equal(done.status, 'applied');
});

test('rejects creation with non-integer expectedRevision', () => {
  setMaskedCorrectionRunner(createMockRunner());
  try {
    createMaskedCorrection(DRAFT_ID, SCENE_ID, makeBody({ expectedRevision: 1.5 }));
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, 'FACTORY_VALIDATION');
  }
});

test('rejects creation with negative expectedRevision', () => {
  setMaskedCorrectionRunner(createMockRunner());
  try {
    createMaskedCorrection(DRAFT_ID, SCENE_ID, makeBody({ expectedRevision: -1 }));
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, 'FACTORY_VALIDATION');
  }
});

test('rejects apply with non-integer expectedRevision', async () => {
  setMaskedCorrectionRunner(createMockRunner({ resultAssetId: ASSET_ID, resultHash: ASSET_SHA }));
  const job = createMaskedCorrection(DRAFT_ID, SCENE_ID, makeBody());
  await waitJob(job.id);
  reviewMaskedCorrection(job.id, { state: 'approved' });

  try {
    applyMaskedCorrection(job.id, { expectedRevision: 1.5 });
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, 'FACTORY_VALIDATION');
  }
});

test('getMaskedCorrectionRunner throws when not set', () => {
  resetMaskedCorrectionForTests();
  try {
    getMaskedCorrectionRunner();
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, 'FACTORY_RUNNER_NOT_SET');
    assert.equal(err.status, 503);
  }
});
