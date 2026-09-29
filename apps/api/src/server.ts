import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { open } from 'node:fs/promises';
import { ASSETS_DIR, DATA_DIR, OUTPUT_DIR, ROOT, chromePath, ensureDirs, ffmpegPath, ffprobePath, prepareBrowserEnv } from './services/platform.js';
import { registerAssetRoutes, loadAssetIndex } from './routes/assets.js';
import { registerProjectRoutes } from './routes/projects.js';
import { seedBrandAssets } from './routes/assets.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

async function main() {
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

  app.get('/media/asset/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const a = loadAssetIndex().find((x) => x.id === id);
    if (!a) return reply.code(404).send({ error: 'asset not found' });
    return streamFile(path.join(ASSETS_DIR, path.basename(a.path)), reply);
  });

  app.get('/media/project/:id/:name', async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    return streamFile(path.join(OUTPUT_DIR, id, path.basename(name)), reply);
  });

  app.get('/output/*', async (req, reply) => {
    const rel = (req.params as Record<string, string>)['*'];
    return streamFile(path.join(OUTPUT_DIR, rel), reply, (req.query as any)?.download === '1' ? rel : undefined);
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

  /* ---- serve the built web UI (single port, one command to run) ---- */
  const webDist = path.join(ROOT, 'apps/web/dist');
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' });
    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/media') || req.url.startsWith('/output')) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler(async (req, reply) => reply.code(404).send({ error: 'not found. Run `npm run build:web` to enable the UI.' }));
  }

  await app.listen({ port: PORT, host: HOST });
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log('');
  console.log('  BuildTrack Video Factory');
  console.log('  ------------------------');
  console.log(`  UI:  http://${shown}:${PORT}`);
  console.log(`  API: http://${shown}:${PORT}/api/health`);
  console.log(`  Output: ${OUTPUT_DIR}`);
  console.log('');
}

main().catch((e) => {
  console.error('server failed to start:', e);
  process.exit(1);
});
