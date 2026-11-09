/**
 * ffprobe resolution shared by the acceptance planner.
 * No download, no provisioning, and no private path in a failure message.
 */
import { describe, expect, it } from 'vitest';
import { parseProbeDuration, resolveFfprobeExecutable } from '../scripts/ffprobe-resolution.js';

const lookup = {
  exists: (file: string) => file === '/opt/ffprobe' || file === '/bundled/ffprobe' || file === '/legacy/ffprobe',
  which: (command: string) => command === 'ffprobe' ? '/usr/bin/ffprobe' : null,
  bundled: () => '/bundled/ffprobe',
};

describe('ffprobe resolution', () => {
  it('uses BUILDTRAKE_FFPROBE when that executable exists', () => {
    const resolved = resolveFfprobeExecutable({
      ...lookup,
      env: { BUILDTRAKE_FFPROBE: '/opt/ffprobe', BUILDTRACK_FFPROBE: '/legacy/ffprobe' },
    });
    expect(resolved).toEqual({ executable: '/opt/ffprobe', source: 'BUILDTRAKE_FFPROBE', problem: null });
  });

  it('still accepts the older BUILDTRACK_FFPROBE name', () => {
    const resolved = resolveFfprobeExecutable({
      ...lookup,
      env: { BUILDTRACK_FFPROBE: '/legacy/ffprobe' },
    });
    expect(resolved.source).toBe('BUILDTRACK_FFPROBE');
    expect(resolved.executable).toBe('/legacy/ffprobe');
  });

  it('uses the bundled executable when PATH has none', () => {
    const resolved = resolveFfprobeExecutable({
      env: {},
      exists: (file) => file === '/bundled/ffprobe',
      which: () => null,
      bundled: () => '/bundled/ffprobe',
    });
    expect(resolved).toEqual({ executable: '/bundled/ffprobe', source: 'bundled', problem: null });
  });

  it('reports a missing executable without echoing the configured path', () => {
    const secret = '/home/operator/private/ffprobe';
    const resolved = resolveFfprobeExecutable({
      env: { BUILDTRAKE_FFPROBE: secret },
      exists: () => false,
      which: () => null,
      bundled: () => null,
    });
    expect(resolved.executable).toBeNull();
    expect(resolved.problem).toMatch(/BUILDTRAKE_FFPROBE/);
    expect(resolved.problem).not.toContain(secret);
    expect(resolved.problem).not.toMatch(/\/home\/operator/);
  });

  it('rejects failed or invalid probe output', () => {
    expect(parseProbeDuration('')).toBeNull();
    expect(parseProbeDuration('not-a-duration')).toBeNull();
    expect(parseProbeDuration('NaN')).toBeNull();
    expect(parseProbeDuration('-1')).toBeNull();
    expect(parseProbeDuration('Infinity')).toBeNull();
    expect(parseProbeDuration('58.84')).toBe(58.84);
  });
});
