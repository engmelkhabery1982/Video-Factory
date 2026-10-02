import { describe, expect, it } from 'vitest';
import { productionJobFailureDetail } from '../scripts/acceptance-render-diagnostics.js';

describe('acceptance render failure diagnostics', () => {
  it('reports the inner render error even when the job itself completed', () => {
    const detail = productionJobFailureDetail({
      status: 'done',
      result: {
        status: 'error',
        renderResults: {
          status: 'error',
          failedTargetIds: ['short_1'],
          results: [{
            targetId: 'short_1',
            success: false,
            error: { code: 'PLAN_RENDER_FAILED', message: 'Remotion render failed: example' },
          }],
        },
      },
    });
    expect(detail).toMatchObject({
      jobStatus: 'done',
      status: 'error',
      renderStatus: 'error',
      failedTargetIds: ['short_1'],
      targetErrors: [{
        targetId: 'short_1',
        error: { code: 'PLAN_RENDER_FAILED', message: 'Remotion render failed: example' },
      }],
    });
  });

  it('does not dump plans, media maps or unrelated target results', () => {
    const detail = productionJobFailureDetail({
      status: 'done',
      result: {
        status: 'partial',
        targetSet: { plan: 'private plan' },
        renderResults: {
          results: [
            { targetId: 'long', success: true, renderResult: { outputFile: 'private path' } },
            { targetId: 'short_1', success: false, error: { code: 'FAIL', message: 'failed' } },
          ],
        },
      },
    });
    expect(detail.targetErrors).toEqual([{ targetId: 'short_1', error: { code: 'FAIL', message: 'failed' } }]);
    expect(JSON.stringify(detail)).not.toContain('private');
  });

  it('handles an absent result without hiding a job-level failure', () => {
    expect(productionJobFailureDetail({ status: 'failed', error: 'server stopped' })).toMatchObject({
      jobStatus: 'failed', error: 'server stopped', targetErrors: [],
    });
  });
});
