/**
 * Regression for the post-VS4 CI repair.
 *
 * Run 37852142691 failed because ubuntu-latest has Python 3.12 as `python3`
 * and no `python3.11`. The fake-worker harness, the provisioning check and the
 * worker parse test all require that name. The repair installs CPython 3.11
 * in CI and does not install Chatterbox weights.
 *
 * The same run's push workflow also executed Chromium render suites. Those
 * files stay listed and runnable from the named render lane, and the push
 * gate must keep them out.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const RENDER_LANE = [
  'tests/phase6b-real-render.test.ts',
  'tests/phase6c-real-short-render.test.ts',
  'tests/phase6d-real-package.test.ts',
];

describe('post-VS4 CI: non-render gate and Python 3.11 harness', () => {
  it('keeps the inspected Chromium suites in an explicit list', () => {
    const listed = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/render-lane-tests.json'), 'utf8')) as string[];
    expect(listed).toEqual(RENDER_LANE);
    for (const file of listed) expect(fs.existsSync(path.join(ROOT, file))).toBe(true);
  });

  it('excludes that list from the push lane and not from a local run', async () => {
    const config = fs.readFileSync(path.join(ROOT, 'vitest.config.ts'), 'utf8');
    expect(config).toContain("process.env.BUILDTRACK_CI_LANE === 'non-render'");
    expect(config).toContain('render-lane-tests.json');
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(workflow).toContain('BUILDTRACK_CI_LANE: non-render');
    for (const file of RENDER_LANE) expect(workflow).not.toContain(file);
  });

  it('installs Python 3.11 for the fake worker and does not provision Chatterbox', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(workflow).toContain('actions/setup-python@v5');
    expect(workflow).toContain("python-version: '3.11'");
    expect(workflow).toContain('CHATTERBOX_PYTHON=');
    expect(workflow).toContain('echo "python3.11=$py $version"');
    expect(workflow).not.toContain('provision:voice-clone');
    expect(workflow).not.toContain('chatterbox-tts');
    expect(workflow).not.toContain('--apply');
  });

  it('keeps the render lane named and untriggered by push', () => {
    const render = fs.readFileSync(path.join(ROOT, '.github/workflows/render-checks.yml'), 'utf8');
    expect(render).toContain('name: Render checks');
    expect(render).toContain('workflow_dispatch:');
    expect(render).not.toMatch(/^on:\s*\n(?:\s+push:|\s+pull_request:)/m);
    expect(render).toContain('scripts/render-lane-tests.json');
    const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).not.toContain('workflow_dispatch');
    expect(ci).not.toContain('ci-failure-summary.mjs');
  });
});
