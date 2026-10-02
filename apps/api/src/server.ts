import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { ASSETS_DIR, DATA_DIR, OUTPUT_DIR, ROOT, chromePath, ensureDirs, ffmpegPath, ffprobePath, prepareBrowserEnv } from './services/platform.js';
import { registerAssetRoutes, loadAssetIndex } from './routes/assets.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerTargetAudioRoutes } from './routes/target-audio.js';
import { registerProductionRoutes } from './routes/production.js';
import { seedBrandAssets } from './routes/assets.js';
import { setProductionMediaOrigin } from './services/render.js';

const PORT = Number(process.env.PORT ?? 3000);

/**
 * Bind host (audit item L).
 *
 * The local API/UI is a single-user, on-machine app: it must NOT be reachable
 * from the LAN by default. It therefore binds to the loopback interface unless
 * the operator EXPLICITLY configures `HOST` (e.g. `HOST=0.0.0.0` for a
 * container/proxy setup). Media, output and SPA routes serve local files, so a
 * silent 0.0.0.0 default would expose them to the network.
 */
export function resolveServerHost(env: NodeJS.ProcessEnv = process.env): string {
  const configured = typeof env.HOST === 'string' ? env.HOST.trim() : '';
  return configured || '127.0.0.1';
}

const HOST = resolveServerHost();

/** Shown in the startup banner; both loopback and wildcard are user-facing "localhost". */
function displayHost(host: string): string {
  return host === '0.0.0.0' || host === '127.0.0.1' || host === '::1' ? 'localhost' : host;
}

/**
 * Build the complete API/UI Fastify instance WITHOUT listening.
 *
 * Exported so the media, output and static/SPA routes can be tested directly
 * with `app.inject()` (audit item L) instead of booting a socket.
 */
export async function buildServerApp(options: { webDist?: string } = {}) {
  ensureDirs();
  prepareBrowserEnv();
  seedBrandAssets();

  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 * 1024 });
  await app.register(multipart, { limits: { fileSize: 512 * 1024 * 1024 } });

  // CORS is permissive on purpose: this is a local-only app, and the Vite dev
  // server runs on a different port than the API.
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', req.headers.origin ?? '*');
    reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type');
    reply.header('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') {
      reply.code(204).send();
    }
  });

  /* ---- media: assets, project files, rendered output ---- */
  const streamFile = async (file: string, reply: any, download?: string) => {
    if (!fs.existsSync(file)) return reply.code(404).send({ error: 'not found' });
    // Directories (and anything not a regular file) are never streamed.
    if (!fs.statSync(file).isFile()) return reply.code(404).send({ error: 'not found' });
    const stat = await open(file, 'r');
    void stat;
    const ext = path.extname(file).toLowerCase();
    const types: Record<string, string> = {
      '.mp4': 'video/mp4', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml', '.srt': 'text/plain', '.vtt': 'text/vtt', '.json': 'application/json',
      '.md': 'text/markdown', '.csv': 'text/csv', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
      '.txt': 'text/plain', '.html': 'text/html',
    };
    reply.header('Content-Type', types[ext] ?? 'application/octet-stream');
    if (download) reply.header('Content-Disposition', `attachment; filename="${path.basename(file)}"`);
    reply.header('Cache-Control', 'no-cache');
    return reply.send(fs.createReadStream(file));
  };

  /**
   * Resolve a client-supplied relative path INSIDE `root`; null when it would
   * escape the root (dot-dot, absolute, symlink-free lexical escape). Every
   * file-serving route below goes through this guard (audit item L).
   */
  const resolveInside = (root: string, rel: string): string | null => {
    const rootResolved = path.resolve(root);
    const abs = path.resolve(rootResolved, rel ?? '');
    if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) return null;
    return abs;
  };

  app.get('/media/asset/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const a = loadAssetIndex().find((x) => x.id === id);
    if (!a) return reply.code(404).send({ error: 'asset not found' });
    // The asset record is data, not a path the client controls: use its
    // basename inside the assets root.
    const abs = resolveInside(ASSETS_DIR, path.basename(a.path));
    if (!abs) return reply.code(404).send({ error: 'asset not found' });
    return streamFile(abs, reply);
  });

  app.get('/media/project/:id/:name', async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    const abs = resolveInside(OUTPUT_DIR, path.join(id, path.basename(name)));
    if (!abs) return reply.code(404).send({ error: 'not found' });
    return streamFile(abs, reply);
  });

  /**
   * PRODUCTION AUDIO TRANSPORT for the plan renderer (read-only, media-safe).
   *
   * The Remotion browser cannot resolve the plan's repo-relative
   * `.production/<videoId>/audio/...` canonical paths against the bundle root
   * served from `.remotion`, so `renderCompositionPlan` maps those srcs to
   * this route. This SERVES the single product audio authority — it moves
   * nothing, copies nothing and creates no second root: the bytes streamed
   * here are exactly the files `productionAudioBasePaths()` owns under
   * `<repoRoot>/.production`.
   *
   * Hardened with the same guards as every other file route: containment
   * inside the production audio root, canonical shape
   * `<videoId>/audio/<dialogue|canonical>/<file>.wav`, regular files, `.wav`
   * only. Anything else is a JSON 404, never a directory or a listing.
   */
  const PRODUCTION_AUDIO_ROOT = path.join(ROOT, '.production');
  app.get('/media/production-audio/*', async (req, reply) => {
    const raw = (req.raw.url ?? '').split('?')[0] ?? '';
    const prefix = '/media/production-audio/';
    if (!raw.startsWith(prefix)) return reply.code(404).send({ error: 'not found' });
    let rel = raw.slice(prefix.length);
    try {
      rel = decodeURIComponent(rel);
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }
    if (rel.includes('\0') || rel.includes('\\')) return reply.code(404).send({ error: 'not found' });
    const abs = resolveInside(PRODUCTION_AUDIO_ROOT, rel);
    if (!abs || path.extname(abs).toLowerCase() !== '.wav') return reply.code(404).send({ error: 'not found' });
    const relFromRoot = path.relative(PRODUCTION_AUDIO_ROOT, abs).split(path.sep).join('/');
    if (!/^[^/]+\/audio\/(?:canonical|dialogue)\/[^/]+$/.test(relFromRoot)) return reply.code(404).send({ error: 'not found' });
    return streamFile(abs, reply);
  });

  app.get('/output/*', async (req, reply) => {
    const rel = (req.params as Record<string, string>)['*'];
    const abs = resolveInside(OUTPUT_DIR, rel);
    if (!abs) return reply.code(404).send({ error: 'not found' });
    return streamFile(abs, reply, (req.query as any)?.download === '1' ? rel : undefined);
  });

  app.get('/data/visual_history.json', async (_req, reply) => streamFile(path.join(DATA_DIR, 'visual_history.json'), reply));

  /* ---- health / doctor ---- */
  app.get('/api/health', async () => {
    const ok = (p: string) => fs.existsSync(p);
    return {
      ok: true,
      node: process.version,
      platform: process.platform,
      ffmpeg: ffmpegPath(),
      ffmpegOk: ok(ffmpegPath()),
      ffprobe: ffprobePath(),
      ffprobeOk: ok(ffprobePath()),
      chrome: (() => {
        try {
          return { path: chromePath(), ok: true };
        } catch (e) {
          return { path: null, ok: false, error: (e as Error).message };
        }
      })(),
      dirs: { data: DATA_DIR, output: OUTPUT_DIR, root: ROOT },
    };
  });

  await registerAssetRoutes(app);
  await registerProjectRoutes(app);
  await registerTargetAudioRoutes(app);
  await registerProductionRoutes(app);

  /* ---- serve the built web UI (single port, one command to run) ---- */
  const webDist = options.webDist ?? path.join(ROOT, 'apps/web/dist');
  if (fs.existsSync(webDist)) {
    /*
     * STATIC SERVING (audit item L) — deliberately WITHOUT @fastify/static.
     *
     * The `@fastify/static` line pinned in this product's frozen lockfile
     * (gate 20 forbids any package-lock.json change) carries high-severity
     * advisories in its wildcard static route (directory-listing traversal and
     * route-guard bypass via encoded separators). A compatible upgrade is not
     * possible while the lockfile is frozen, so the runtime EXPOSURE is removed
     * instead: the SPA build output is served by a small explicit handler.
     *
     * Hardening (tested in tests/server-media-security.test.ts):
     *   - only regular FILES inside the web dist are streamed, never directories
     *     and therefore never a directory listing;
     *   - path segments starting with `.` are refused (no dotfiles);
     *   - an extension allowlist limits what can ever be served;
     *   - extensionless paths fall back to index.html (client-side routing) and
     *     /api, /media, /output keep their JSON 404;
     *   - encoded traversal cannot escape the root (same containment guard as
     *     the media/output routes).
     */
    const WEB_CONTENT_TYPES: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.mjs': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json',
      '.map': 'application/json',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.ico': 'image/x-icon',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
      '.txt': 'text/plain; charset=utf-8',
    };
    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/media') || req.url.startsWith('/output')) {
        return reply.code(404).send({ error: 'not found' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return reply.code(404).send({ error: 'not found' });
      let rel: string;
      try {
        rel = decodeURIComponent((req.url.split('?')[0] ?? '/').replace(/^\/+/, '')).replace(/\\/g, '/');
      } catch {
        return reply.code(404).send({ error: 'not found' });
      }
      if (rel.split('/').some((segment) => segment.startsWith('.') && segment !== '')) {
        return reply.code(404).send({ error: 'not found' });
      }
      if (path.extname(rel) === '') {
        // Client-side route → the SPA entry point (never a listing).
        return streamFile(path.join(webDist, 'index.html'), reply);
      }
      const abs = resolveInside(webDist, rel);
      if (!abs) return reply.code(404).send({ error: 'not found' });
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return reply.code(404).send({ error: 'not found' });
      const type = WEB_CONTENT_TYPES[path.extname(abs).toLowerCase()];
      if (!type) return reply.code(404).send({ error: 'not found' });
      const stream = fs.createReadStream(abs);
      reply.header('Content-Type', type);
      reply.header('Cache-Control', 'no-cache');
      return reply.send(stream);
    });
  } else {
    app.setNotFoundHandler(async (req, reply) => reply.code(404).send({ error: 'not found. Run `npm run build:web` to enable the UI.' }));
  }

  return app;
}

async function main() {
  const app = await buildServerApp();
  await app.listen({ port: PORT, host: HOST });

  /*
   * Production audio transport (renderer boundary, Phase 6B): once this
   * server is actually listening, plan renders resolve the plan's
   * repo-relative `.production/<videoId>/audio/...` canonical audio srcs
   * against THIS origin (`/media/production-audio/*`). Same loopback-origin
   * convention the Phase 6A mediaMap URLs already use for images, and read
   * from the same single audio authority - no copy, no second root.
   */
  const bound = app.server.address();
  if (bound && typeof bound === 'object') {
    setProductionMediaOrigin(`http://127.0.0.1:${bound.port}`);
  }

  const shown = displayHost(HOST);
  console.log('');
  console.log('  BuildTrack Video Factory');
  console.log('  ------------------------');
  console.log(`  UI:  http://${shown}:${PORT}`);
  console.log(`  API: http://${shown}:${PORT}/api/health`);
  console.log(`  Output: ${OUTPUT_DIR}`);
  console.log('');
}

/**
 * Run only when this file is the process entry point (`npm start` /
 * `node --import tsx apps/api/src/server.ts`). Importing the module for tests
 * must not open a socket.
 */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((e) => {
    console.error('server failed to start:', e);
    process.exit(1);
  });
}
