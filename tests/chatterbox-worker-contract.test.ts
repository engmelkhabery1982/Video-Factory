/**
 * Runs the offline Python contract against the real Chatterbox worker.
 * The Python file stubs perth and the model classes. It does not download
 * weights or import torch.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Chatterbox worker contract', () => {
  it('imports worker.py and checks watermark, generate arguments, and variant selection', () => {
    const result = spawnSync('python3', [path.join('tests', 'chatterbox-worker-contract.py')], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});
