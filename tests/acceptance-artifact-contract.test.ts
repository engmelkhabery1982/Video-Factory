import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = fs.readFileSync(path.join(process.cwd(), '.github', 'workflows', 'final-product-acceptance.yml'), 'utf8');
const driver = fs.readFileSync(path.join(process.cwd(), 'scripts', 'final-product-acceptance.ts'), 'utf8');

function uploadBlock(name: string): string {
  const marker = `name: ${name}`;
  const start = workflow.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const end = workflow.indexOf('retention-days:', start);
  expect(end).toBeGreaterThan(start);
  return workflow.slice(start, end);
}

describe('acceptance artifact handoffs', () => {
  it('preflight carries the identity evidence that the final evidence validator opens', () => {
    expect(driver).toContain("identityEvidenceFile: 'EVIDENCE/final-product/audio-per-turn-identity.json'");
    expect(uploadBlock('final-acceptance-preflight')).toContain('EVIDENCE/final-product/audio-per-turn-identity.json');
    expect(uploadBlock('final-acceptance-preflight')).toContain('.stills/final-acceptance/stage');
  });

  it('second project carries both its evidence and its stage document into aggregation', () => {
    expect(driver).toContain("saveStage('second-project'");
    const block = uploadBlock('final-acceptance-second-project');
    expect(block).toContain('EVIDENCE/final-product/second-project-verification.json');
    expect(block).toContain('.stills/final-acceptance/stage/second-project.json');
  });

  it('carries every required stage and media path through the gated artifact chain', () => {
    const preflight = uploadBlock('final-acceptance-preflight');
    for (const required of [
      '.stills/final-acceptance/data',
      '.stills/final-acceptance/stage',
      '.stills/final-acceptance/audio-artifact',
      'EVIDENCE/final-product/preflight-verification.json',
      'EVIDENCE/final-product/audio-per-turn-identity.json',
    ]) expect(preflight).toContain(required);

    const smoke = uploadBlock('final-acceptance-short-smoke');
    for (const required of [
      '.stills/final-acceptance/output',
      '.stills/final-acceptance/stage',
      'EVIDENCE/final-product/short-smoke-media-verification.json',
    ]) expect(smoke).toContain(required);

    const production = uploadBlock('final-acceptance-production');
    for (const required of [
      '.stills/final-acceptance/output',
      '.stills/final-acceptance/stage',
      'EVIDENCE/final-product/long-media-verification.json',
      'EVIDENCE/final-product/short-media-verification.json',
      'EVIDENCE/final-product/package-verification.json',
    ]) expect(production).toContain(required);

    const state = uploadBlock('final-acceptance-state');
    expect(state).toContain('.stills/final-acceptance/data');
    expect(state).toContain('.stills/final-acceptance/stage/final-production.json');
    expect(workflow).toContain('pattern: final-acceptance-*');
    expect(workflow).toContain('merge-multiple: true');
  });

  it('requires stage documents and the audio identity proof before each upload', () => {
    for (const stage of ['preflight', 'short-smoke', 'final-production', 'second-project']) {
      expect(workflow).toContain(`test -f .stills/final-acceptance/stage/${stage}.json`);
    }
    expect(workflow).toContain('test -f EVIDENCE/final-product/audio-per-turn-identity.json');
  });

  it('does not require independently allocated localhost ports to differ', () => {
    expect(driver).not.toMatch(/!String\(finalAuthority\.longAbsoluteUrl\)\.includes\(`127\.0\.0\.1:\$\{preflightPort\}/);
    expect(driver).toContain('finalAuthority.longAbsoluteUrl.startsWith(`http://127.0.0.1:${finalPort}/media/asset/`)');
  });
});
