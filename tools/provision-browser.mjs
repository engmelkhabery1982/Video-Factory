#!/usr/bin/env node
/**
 * Provision a local headless Chromium for Remotion.
 *
 * Why this exists: Remotion normally downloads "Chrome Headless Shell" from
 * Google's storage bucket. In locked-down / offline / air-gapped environments
 * (and on corporate networks that block storage.googleapis.com) that download
 * fails and the whole product dies. This script builds the browser from an npm
 * tarball instead, so `npm install` alone is enough.
 *
 * The Chromium build shipped by @sparticuz/chromium is open source and is
 * designed to run as a self-contained, headless, sandbox-free binary. We unpack
 * it together with the shared libraries it needs, so the renderer never depends
 * on system packages.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { provisionDecision, resolveChrome } from './chrome-resolution.mjs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.browser');
const EXEC = path.join(OUT, 'chrome');
// LD_LIBRARY_PATH must contain OUT (for the swiftshader/EGL libs, extracted
// flat) and OUT/lib (for the nss/nspr family, which the tarball nests).
const LIBS = [path.join(OUT, 'lib'), OUT];
const MARKER = path.join(OUT, '.ok');

const log = (...a) => console.log('[provision]', ...a);

async function brotliTo(src, dest) {
  await pipeline(fs.createReadStream(src), zlib.createBrotliDecompress(), fs.createWriteStream(dest));
}

function extractTar(tarPath, into) {
  execFileSync('tar', ['-xf', tarPath, '-C', into], { stdio: 'pipe' });
}

async function main() {
  const resolved = resolveChrome({ root: ROOT, env: process.env, platform: process.platform });
  const decision = provisionDecision(resolved, process.platform, process.env);
  if (decision.action === 'use') {
    log(`browser ready (${resolved.source}) =`, resolved.path);
    if (decision.writeMarker && fs.existsSync(EXEC)) fs.writeFileSync(MARKER, new Date().toISOString());
    return;
  }
  if (!decision.unpack) {
    log('ERROR:', resolved.message);
    for (const failure of resolved.failures) log(' -', failure.source, failure.path, failure.reason);
    if (process.platform === 'win32') {
      log('A Linux Chromium package was not unpacked, and an ELF binary was not renamed to chrome.exe.');
      log('Set BUILDTRAKE_CHROME_PATH to the installed Chrome, for example:');
      log('  C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    }
    if (fs.existsSync(MARKER)) {
      fs.rmSync(MARKER, { force: true });
      log('Removed a stale .browser/.ok marker. A marker is not a runnable browser.');
    }
    process.exit(1);
  }
  if (fs.existsSync(MARKER) && fs.existsSync(EXEC)) {
    log('bundled browser did not run; the existing marker is not success. Rebuilding the Linux runtime.');
  }

  let binDir;
  try {
    // The package's `exports` map does not expose package.json, so walk up
    // from the resolved entry point instead of resolving the manifest.
    const entry = require.resolve('@sparticuz/chromium');
    const pkgRoot = path.resolve(path.dirname(entry), '..');
    binDir = path.join(pkgRoot, 'bin');
    if (!fs.existsSync(path.join(binDir, 'chromium.br'))) throw new Error('bin/chromium.br missing');
  } catch (err) {
    log('ERROR: @sparticuz/chromium is not installed or is incomplete. Run `npm install` first.');
    log('       detail:', err.message);
    process.exit(1);
  }

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = path.join(OUT, '.tmp');
  fs.mkdirSync(tmp, { recursive: true });

  log('unpacking chromium runtime (~200 MB, one time)...');
  await brotliTo(path.join(binDir, 'chromium.br'), EXEC);
  fs.chmodSync(EXEC, 0o755);

  log('unpacking shared libraries...');
  // al2023.tar contains lib/libnspr4.so, lib/libnss3.so, ... -> OUT/lib/*
  const alTar = path.join(tmp, 'al2023.tar');
  await brotliTo(path.join(binDir, 'al2023.tar.br'), alTar);
  extractTar(alTar, OUT);

  // swiftshader.tar contains libEGL.so, libGLESv2.so, libvulkan.so.1, ...
  const ssTar = path.join(tmp, 'swiftshader.tar');
  await brotliTo(path.join(binDir, 'swiftshader.tar.br'), ssTar);
  extractTar(ssTar, OUT);
  fs.rmSync(tmp, { recursive: true, force: true });

  const verified = resolveChrome({ root: ROOT, env: process.env, platform: process.platform });
  if (!verified.ok || verified.source !== 'bundled') {
    if (fs.existsSync(MARKER)) fs.rmSync(MARKER, { force: true });
    log('ERROR: unpacked browser did not run. The success marker was not written.');
    if (!verified.ok) log(verified.message);
    process.exit(1);
  }
  fs.writeFileSync(MARKER, new Date().toISOString());
  log(`done -> ${EXEC} (${(fs.statSync(EXEC).size / 1e6).toFixed(0)} MB)`);
}

main().catch((e) => {
  console.error('[provision] failed:', e);
  process.exit(1);
});
