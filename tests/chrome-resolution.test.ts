import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { provisionDecision, resolveChrome } from '../tools/chrome-resolution.mjs';

const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]);
const PE = Buffer.from([0x4d, 0x5a, 0x90, 0, 0, 0, 0, 0]);

function harness(options: {
  platform: NodeJS.Platform;
  env?: Record<string, string>;
  files?: Record<string, Buffer>;
  runs?: Record<string, boolean>;
}) {
  const files = options.files ?? {};
  const runs = options.runs ?? {};
  const renamed: string[] = [];
  return {
    renamed,
    resolve: () =>
      resolveChrome({
        platform: options.platform,
        env: options.env ?? {},
        root: '/proj',
        exists: (file: string) => Object.prototype.hasOwnProperty.call(files, file),
        stat: (file: string) => ({
          isFile: () => Object.prototype.hasOwnProperty.call(files, file),
          isSymbolicLink: () => false,
        }),
        readMagic: (file: string) => files[file] ?? Buffer.alloc(0),
        runVersion: (file: string) => ({ ok: runs[file] === true, detail: runs[file] ? 'Chrome 120' : 'did not start' }),
        which: () => null,
      }),
    rename: renamed,
  };
}

describe('browser resolution is the same for doctor, provision, and runtime', () => {
  it('does not select a Linux ELF on Windows, and an old marker is not success', () => {
    const seen = harness({
      platform: 'win32',
      files: {
        '/proj/.browser/chrome': ELF,
        '\\proj\\.browser\\chrome.exe': ELF,
        '/proj/.browser/.ok': Buffer.from('old-marker'),
      },
    });
    const resolved = seen.resolve();
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.failures.some((failure) => failure.reason.includes('not renamed to chrome.exe'))).toBe(true);
      expect(resolved.message).not.toMatch(/already provisioned/i);
    }
    expect(seen.rename).toEqual([]);
  });

  it('honors BUILDTRAKE_CHROME_PATH with that exact spelling and does not fall through', () => {
    const resolved = harness({
      platform: 'win32',
      env: {
        BUILDTRAKE_CHROME_PATH: 'C:\\Tools\\chrome.exe',
        BUILDTRACK_CHROME_PATH: 'C:\\Wrong\\chrome.exe',
        PROGRAMFILES: 'C:\\Program Files',
      },
      files: {
        'C:\\Tools\\chrome.exe': PE,
        'C:\\Wrong\\chrome.exe': PE,
        '/proj/.browser/chrome': ELF,
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe': PE,
      },
      runs: { 'C:\\Tools\\chrome.exe': true, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe': true },
    }).resolve();
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.path).toBe('C:\\Tools\\chrome.exe');
      expect(resolved.source).toBe('BUILDTRAKE_CHROME_PATH');
    }
  });

  it('a set override that does not run is a failure, not a silent ELF fallback', () => {
    const resolved = harness({
      platform: 'win32',
      env: { BUILDTRAKE_CHROME_PATH: 'C:\\Missing\\chrome.exe' },
      files: { '/proj/.browser/chrome': ELF },
    }).resolve();
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.message).toContain('BUILDTRAKE_CHROME_PATH');
  });

  it('uses a runnable installed Chrome on Windows when no override is set', () => {
    const resolved = harness({
      platform: 'win32',
      env: { PROGRAMFILES: 'C:\\Program Files' },
      files: {
        '/proj/.browser/chrome': ELF,
        '\\proj\\.browser\\chrome.exe': ELF,
        [path.win32.join('C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe')]: PE,
      },
      runs: { [path.win32.join('C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe')]: true },
    }).resolve();
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.source).toBe('local-install');
      expect(resolved.path).toContain('chrome.exe');
    }
  });

  it('keeps Linux bundled provisioning when that binary runs', () => {
    const resolved = harness({
      platform: 'linux',
      files: { '/proj/.browser/chrome': ELF },
      runs: { '/proj/.browser/chrome': true },
    }).resolve();
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.source).toBe('bundled');
    expect(provisionDecision(resolved, 'linux', {}).unpack).toBe(false);
  });

  it('does not unpack the Linux package on Windows, and does unpack on Linux when nothing runs', () => {
    const failed = { ok: false as const, message: 'none', failures: [] };
    expect(provisionDecision(failed, 'win32', {}).unpack).toBe(false);
    expect(provisionDecision(failed, 'win32', {}).reason).toBe('windows-no-browser');
    expect(provisionDecision(failed, 'linux', {}).unpack).toBe(true);
    expect(provisionDecision(failed, 'win32', { BUILDTRAKE_CHROME_PATH: 'C:\\Missing\\chrome.exe' }).unpack).toBe(false);
  });
});
