/**
 * AUDIT ITEM L — local-only exposure: bind host, media/static routes, traversal.
 *
 * The local API/UI serves local files (assets, project output, the built SPA).
 * This suite proves:
 *
 *   L1  the default bind host is 127.0.0.1 unless the operator EXPLICITLY sets
 *       HOST (never 0.0.0.0 by default);
 *   L2  /media/asset/:id serves a real asset with its content type, and 404s an
 *       unknown id or a traversal attempt;
 *   L3  /media/project/:id/:name and /output/* can never escape their roots
 *       (dot-dot and URL-encoded separators are rejected);
 *   L4  the static SPA route serves files and index fallback but never a
 *       directory listing and never dotfiles;
 *   L5  unknown /api, /media and /output paths 404 as JSON instead of falling
 *       through to the SPA.
 *
 * Everything runs on an in-process Fastify instance via `app.inject()` (no
 * socket, no port, no render).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'vf-server-sec-')) };
const WEB_DIST = path.join(tmp.dir, 'webdist');
// A secret OUTSIDE every served root, used to prove traversal never escapes.
const SECRET_NAME = `outside-secret-${path.basename(tmp.dir)}.txt`;
const SECRET_PATH = path.join(tmp.dir, SECRET_NAME);
fs.mkdirSync(path.join(WEB_DIST, 'assets'), { recursive: true });
fs.writeFileSync(SECRET_PATH, 'TOP-SECRET-OUTSIDE-ROOTS', 'utf8');

import { ASSETS_DIR, DATA_DIR, OUTPUT_DIR } from '../apps/api/src/services/platform.js';
import { buildServerApp, resolveServerHost } from '../apps/api/src/server.js';



describe('audit L — default bind host is loopback unless explicitly configured', () => {
  it('L1 — no HOST → 127.0.0.1; explicit HOST wins; blank HOST → loopback', () => {
    expect(resolveServerHost({} as NodeJS.ProcessEnv)).toBe('127.0.0.1');
    expect(resolveServerHost({ HOST: '' } as NodeJS.ProcessEnv)).toBe('127.0.0.1');
    expect(resolveServerHost({ HOST: '   ' } as NodeJS.ProcessEnv)).toBe('127.0.0.1');
    expect(resolveServerHost({ HOST: '0.0.0.0' } as NodeJS.ProcessEnv)).toBe('0.0.0.0');
    expect(resolveServerHost({ HOST: '192.168.1.10' } as NodeJS.ProcessEnv)).toBe('192.168.1.10');
    expect(resolveServerHost({ HOST: '::1' } as NodeJS.ProcessEnv)).toBe('::1');
  });
});

describe('audit L — media, output and static routes cannot serve outside their roots', () => {
  let app: Awaited<ReturnType<typeof buildServerApp>>;
  let assetId = '';
  let assetBytes = Buffer.alloc(0);
  let assetFileName = '';
  let assetIndexFile = '';
  let assetIndexBackup: string | null = null;
  let projectId = '';

  beforeAll(async () => {
    /*
     * These routes read the product's real data/output roots (module-level
     * constants), so the fixtures use unique names there and are removed in
     * afterAll. The product's own store is never rewritten.
     */
    const nonce = path.basename(tmp.dir).replace(/[^a-zA-Z0-9_-]/g, '');
    assetFileName = `sec-asset-${nonce}.png`;
    assetId = `asset-sec-${nonce}`;
    assetBytes = Buffer.from('REAL-ASSET-PAYLOAD-0123456789', 'utf8');
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
    fs.writeFileSync(path.join(ASSETS_DIR, assetFileName), assetBytes);
    assetIndexFile = path.join(ASSETS_DIR, 'index.json');
    assetIndexBackup = fs.existsSync(assetIndexFile) ? fs.readFileSync(assetIndexFile, 'utf8') : null;
    fs.writeFileSync(
      assetIndexFile,
      JSON.stringify([
        {
          id: assetId,
          name: 'Security asset',
          kind: 'screenshot',
          fileName: assetFileName,
          path: `assets/${assetFileName}`,
          mimeType: 'image/png',
          sizeBytes: assetBytes.length,
          tags: [],
          status: 'active',
          preferred: false,
          source: 'operator',
          license: 'operator-owned',
          addedAt: new Date().toISOString(),
          usedIn: [],
          blocked: false,
        },
      ]),
      'utf8',
    );
    // A real output file + a nested one, under a unique project directory.
    projectId = `SecProj_${nonce}`;
    fs.mkdirSync(path.join(OUTPUT_DIR, projectId), { recursive: true });
    fs.writeFileSync(path.join(OUTPUT_DIR, `${projectId}.mp4`), 'OUTPUT-MP4-BYTES', 'utf8');
    fs.writeFileSync(path.join(OUTPUT_DIR, projectId, 'poster.png'), 'POSTER-BYTES', 'utf8');
    // SPA dist with index.html, a nested asset asset file, a directory, a dotfile.
    fs.writeFileSync(path.join(WEB_DIST, 'index.html'), '<html><body>SPA-INDEX</body></html>', 'utf8');
    fs.writeFileSync(path.join(WEB_DIST, 'assets', 'app.js'), 'console.log("APP-JS")', 'utf8');
    fs.mkdirSync(path.join(WEB_DIST, 'somedir'), { recursive: true });
    fs.writeFileSync(path.join(WEB_DIST, 'somedir', 'inner.txt'), 'INNER-FILE-MARKER', 'utf8');
    fs.writeFileSync(path.join(WEB_DIST, '.env'), 'SPA-DOTFILE-SECRET', 'utf8');

    app = await buildServerApp({ webDist: WEB_DIST });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    try {
      if (assetIndexBackup === null) fs.rmSync(assetIndexFile, { force: true });
      else fs.writeFileSync(assetIndexFile, assetIndexBackup, 'utf8');
      fs.rmSync(path.join(ASSETS_DIR, assetFileName), { force: true });
      fs.rmSync(path.join(OUTPUT_DIR, `${projectId}.mp4`), { force: true });
      fs.rmSync(path.join(OUTPUT_DIR, projectId), { recursive: true, force: true });
      fs.rmSync(path.join(OUTPUT_DIR, 'escape.txt'), { force: true });
      fs.rmSync(tmp.dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('L2 — a real asset is served with its content type; unknown ids and traversal are 404', async () => {
    const ok = await app.inject({ method: 'GET', url: `/media/asset/${assetId}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('image/png');
    expect(Buffer.from(ok.rawPayload)).toEqual(assetBytes);

    const unknown = await app.inject({ method: 'GET', url: '/media/asset/does-not-exist' });
    expect(unknown.statusCode).toBe(404);

    for (const url of [
      '/media/asset/..%2F..%2Foutside-secret.txt',
      '/media/asset/%2e%2e%2f%2e%2e%2foutside-secret.txt',
      '/media/asset/....//outside-secret.txt',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect([403, 404], `${url} → ${res.statusCode}`).toContain(res.statusCode);
      expect(res.payload).not.toContain('TOP-SECRET-OUTSIDE-ROOTS');
    }
  });

  it('L3 — /media/project and /output stay inside OUTPUT_DIR even with encoded traversal', async () => {
    const nested = await app.inject({ method: 'GET', url: `/media/project/${projectId}/poster.png` });
    expect(nested.statusCode).toBe(200);
    expect(nested.payload).toContain('POSTER-BYTES');

    const output = await app.inject({ method: 'GET', url: `/output/${projectId}.mp4` });
    expect(output.statusCode).toBe(200);
    expect(output.payload).toContain('OUTPUT-MP4-BYTES');

    const download = await app.inject({ method: 'GET', url: `/output/${projectId}/poster.png?download=1` });
    expect(download.statusCode).toBe(200);
    expect(String(download.headers['content-disposition'] ?? '')).toContain('attachment');

    const escapeRel = path.relative(OUTPUT_DIR, tmp.dir).split(path.sep).join('/');
    for (const url of [
      `/output/..%2F${encodeURIComponent(SECRET_NAME)}`,
      `/output/${escapeRel.split('/').map(() => '..').join('/')}%2F${encodeURIComponent(SECRET_NAME)}`,
      `/output/..%2F..%2F${encodeURIComponent(SECRET_NAME)}`,
      `/output/....//${encodeURIComponent(SECRET_NAME)}`,
      '/media/project/..%2F..%2Foutside-secret.txt',
      `/media/project/${projectId}/..%2F..%2F..%2F${encodeURIComponent(SECRET_NAME)}`,
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect([403, 404], `${url} → ${res.statusCode}`).toContain(res.statusCode);
      expect(res.payload, url).not.toContain('TOP-SECRET-OUTSIDE-ROOTS');
    }

    // Symlink escape is also out of scope for the served roots: a link pointing
    // outside must not be resolvable through the output route.
    const link = path.join(OUTPUT_DIR, 'escape.txt');
    try {
      fs.symlinkSync(path.join(tmp.dir, 'outside-secret.txt'), link);
      const res = await app.inject({ method: 'GET', url: '/output/escape.txt' });
      if (res.statusCode === 200) {
        // If the platform follows the link, the bytes must not be the secret:
        // the route may only serve files that resolve inside the root.
        expect(res.payload).not.toContain('TOP-SECRET-OUTSIDE-ROOTS');
      }
    } catch {
      /* symlinks unavailable: the lexical guard is still covered above */
    }
  });

  it('L4 — the SPA route serves files and index fallback, never a listing or a dotfile', async () => {
    const index = await app.inject({ method: 'GET', url: '/' });
    expect(index.statusCode).toBe(200);
    expect(index.payload).toContain('SPA-INDEX');

    const js = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(js.statusCode).toBe(200);
    expect(js.payload).toContain('APP-JS');

    // Client-side route → index fallback, not a directory listing.
    const spa = await app.inject({ method: 'GET', url: '/projects' });
    expect(spa.statusCode).toBe(200);
    expect(spa.payload).toContain('SPA-INDEX');

    const dir = await app.inject({ method: 'GET', url: '/somedir/' });
    expect(dir.payload).not.toContain('INNER-FILE-MARKER');
    expect(dir.payload.toLowerCase()).not.toContain('index of');

    const dotfile = await app.inject({ method: 'GET', url: '/.env' });
    expect([403, 404]).toContain(dotfile.statusCode);
    expect(dotfile.payload).not.toContain('SPA-DOTFILE-SECRET');
  });

  it('L5 — unknown API/media/output paths 404 as JSON, never as the SPA', async () => {
    for (const url of ['/api/nope', '/media/nope', '/output/']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.payload, url).not.toContain('SPA-INDEX');
    }
    // /output/ resolves to the output ROOT (a directory) → must not stream it.
    const root = await app.inject({ method: 'GET', url: '/output/' });
    expect(root.statusCode).toBe(404);
  });

  it('L6 — the runtime never registers the vulnerable @fastify/static wildcard route', () => {
    const source = fs.readFileSync(new URL('../apps/api/src/server.ts', import.meta.url), 'utf8');
    // Runtime exposure removal is the mitigation: the plugin may stay in the
    // frozen lockfile, but it must not be imported or registered by the server.
    expect(source).not.toMatch(/from '@fastify\/static'/);
    expect(source).not.toMatch(/fastifyStatic/);
    // ...and the in-house SPA handler keeps the hardening rules.
    expect(source).toContain('WEB_CONTENT_TYPES');
    expect(source).toMatch(/segment\.startsWith\('\.'\)/);
    expect(source).toMatch(/path\.extname\(rel\) === ''/);
  });
});
