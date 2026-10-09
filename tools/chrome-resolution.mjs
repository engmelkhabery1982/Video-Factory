/**
 * One browser resolution for doctor, provision, and the renderer.
 *
 * Priority, same spelling everywhere:
 *   1. BUILDTRAKE_CHROME_PATH, when set, is authoritative. A bad override
 *      does not fall through to another binary.
 *   2. The bundled binary for this platform only (.browser/chrome.exe on
 *      Windows, .browser/chrome elsewhere).
 *   3. An installed Chrome, then Edge, without changing that install.
 *   4. A browser on PATH.
 *
 * A file is not enough. The binary must match the platform (a Linux ELF is
 * never renamed to chrome.exe and is never selected on Windows) and it must
 * actually run. An old .ok marker is not an input.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function shouldUnpackBundledChromium(platform = process.platform) {
  return platform !== 'win32';
}

export function bundledChromeName(platform = process.platform) {
  return platform === 'win32' ? 'chrome.exe' : 'chrome';
}

function whichExecutable(name, env, platform) {
  const dirs = String(env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name.endsWith(ext) ? name : name + ext);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function magicOf(bytes) {
  if (!bytes || bytes.length < 2) return 'unreadable';
  if (bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) return 'elf';
  if (bytes[0] === 0x4d && bytes[1] === 0x5a) return 'pe';
  if (bytes.length >= 4) {
    const hex = Buffer.from(bytes.subarray(0, 4)).toString('hex');
    if (hex === 'feedface' || hex === 'feedfacf' || hex === 'cefaedfe' || hex === 'cffaedfe') return 'macho';
  }
  return 'unknown';
}

function magicAllowed(platform, magic) {
  if (platform === 'win32') return magic === 'pe';
  if (platform === 'darwin') return magic === 'macho' || magic === 'unknown';
  return magic === 'elf' || magic === 'unknown';
}

function defaultRunVersion(file, extraEnv = {}) {
  try {
    const out = execFileSync(file, ['--version'], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv },
    });
    const text = String(out ?? '').trim();
    return { ok: text.length > 0, detail: text.split('\n')[0].slice(0, 160) };
  } catch (error) {
    const stdout = error && error.stdout ? String(error.stdout) : '';
    const stderr = error && error.stderr ? String(error.stderr) : '';
    const text = (stdout || stderr || (error && error.message) || 'the browser did not run').trim();
    return { ok: false, detail: text.split('\n')[0].slice(0, 180) };
  }
}

function joinFor(platform, ...parts) {
  return (platform === 'win32' ? path.win32 : path.posix).join(...parts);
}

function candidatesFor(platform, env, root, which) {
  const bundled = joinFor(platform, root, '.browser', bundledChromeName(platform));
  const list = [];
  if (typeof env.BUILDTRAKE_CHROME_PATH === 'string' && env.BUILDTRAKE_CHROME_PATH.trim()) {
    list.push({ source: 'BUILDTRAKE_CHROME_PATH', path: env.BUILDTRAKE_CHROME_PATH.trim() });
    return list;
  }
  list.push({ source: 'bundled', path: bundled });
  if (platform === 'win32') {
    const programFiles = env.PROGRAMFILES || 'C:\\Program Files';
    const programFilesX86 = env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const local = env.LOCALAPPDATA;
    list.push(
      { source: 'local-install', path: joinFor('win32', programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { source: 'local-install', path: joinFor('win32', programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    );
    if (local) list.push({ source: 'local-install', path: joinFor('win32', local, 'Google', 'Chrome', 'Application', 'chrome.exe') });
    list.push({ source: 'local-install', path: joinFor('win32', programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe') });
  }
  const names = platform === 'win32' ? ['chrome', 'msedge', 'chromium'] : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'];
  for (const name of names) {
    const found = which(name);
    if (found) list.push({ source: 'path', path: found });
  }
  return list;
}

/**
 * @returns {{ ok: true, path: string, source: string, detail: string } | { ok: false, message: string, failures: Array<{ source: string, path: string, reason: string }> }}
 */
export function resolveChrome(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const root = options.root ?? ROOT;
  const exists = options.exists ?? ((file) => fs.existsSync(file));
  const stat = options.stat ?? ((file) => fs.statSync(file));
  const readMagic = options.readMagic ?? ((file) => fs.readFileSync(file).subarray(0, 4));
  const runVersion = options.runVersion ?? defaultRunVersion;
  const which = options.which ?? ((name) => whichExecutable(name, env, platform));
  const failures = [];
  const override = typeof env.BUILDTRAKE_CHROME_PATH === 'string' && env.BUILDTRAKE_CHROME_PATH.trim();

  for (const candidate of candidatesFor(platform, env, root, which)) {
    if (!exists(candidate.path)) {
      failures.push({ source: candidate.source, path: candidate.path, reason: 'file not found' });
      continue;
    }
    let info;
    try {
      info = stat(candidate.path);
    } catch (error) {
      failures.push({ source: candidate.source, path: candidate.path, reason: error.message || 'could not stat file' });
      continue;
    }
    if (!info.isFile() || info.isSymbolicLink?.()) {
      failures.push({ source: candidate.source, path: candidate.path, reason: 'not a regular file' });
      continue;
    }
    const magic = magicOf(readMagic(candidate.path));
    if (platform === 'win32' && magic === 'elf') {
      failures.push({
        source: candidate.source,
        path: candidate.path,
        reason: 'Linux ELF binary is not a Windows browser and was not renamed to chrome.exe',
      });
      continue;
    }
    if (!magicAllowed(platform, magic)) {
      failures.push({ source: candidate.source, path: candidate.path, reason: `binary format ${magic} cannot run on ${platform}` });
      continue;
    }
    const extraEnv = {};
    if (candidate.source === 'bundled' && platform !== 'win32') {
      const lib = joinFor(platform, root, '.browser', 'lib');
      const browserDir = joinFor(platform, root, '.browser');
      extraEnv.LD_LIBRARY_PATH = [lib, browserDir, env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter);
    }
    const ran = runVersion(candidate.path, extraEnv);
    if (!ran.ok) {
      failures.push({ source: candidate.source, path: candidate.path, reason: `browser did not run: ${ran.detail}` });
      continue;
    }
    return { ok: true, path: candidate.path, source: candidate.source, detail: ran.detail };
  }

  const first = failures[0];
  const message = override
    ? `BUILDTRAKE_CHROME_PATH is set but is not a runnable browser for ${platform}: ${first ? first.reason : 'no path'}. No other browser was selected.`
    : `No runnable browser for ${platform}. An old provision marker is not success. Set BUILDTRAKE_CHROME_PATH to an installed Chrome, or run npm run provision on Linux.`;
  return { ok: false, message, failures };
}

/**
 * What provision should do after resolution. An old marker is not an input.
 * Windows never unpacks the Linux Chromium package.
 */
export function provisionDecision(resolved, platform = process.platform, env = process.env) {
  if (resolved.ok) return { action: 'use', unpack: false, writeMarker: resolved.source === 'bundled', path: resolved.path, source: resolved.source };
  if (typeof env.BUILDTRAKE_CHROME_PATH === 'string' && env.BUILDTRAKE_CHROME_PATH.trim()) {
    return { action: 'fail', unpack: false, writeMarker: false, reason: 'override-not-runnable' };
  }
  if (!shouldUnpackBundledChromium(platform)) {
    return { action: 'fail', unpack: false, writeMarker: false, reason: 'windows-no-browser' };
  }
  return { action: 'unpack', unpack: true, writeMarker: false, reason: 'linux-bundled-missing' };
}
