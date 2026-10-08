import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

/**
 * Chromium/Remotion suites. They stay in the repository and in the named
 * render lane (`.github/workflows/render-checks.yml`). The push CI gate sets
 * BUILDTRACK_CI_LANE=non-render so `npm test` and the count guard do not
 * start them. Inspected execution, not filenames:
 *   - phase6d beforeAll always calls renderProductionDeliveryTargets
 *   - phase6b describeReal calls renderPlanStill / renderCompositionPlan
 *   - phase6c describeReal calls renderProductionDeliveryTargets
 * ffmpeg mux tests (VS4 duration preservation) are not in this list.
 */
const renderLaneTests = JSON.parse(
  readFileSync(new URL('./scripts/render-lane-tests.json', import.meta.url), 'utf8'),
) as string[];

const nonRenderLane = process.env.BUILDTRACK_CI_LANE === 'non-render';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: nonRenderLane
      ? ['**/node_modules/**', '**/dist/**', ...renderLaneTests]
      : ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
