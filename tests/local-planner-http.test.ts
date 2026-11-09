import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { localPlanCompletion } from '../apps/api/src/services/local-planner.js';

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void, run: (url: string, server: Server) => Promise<void>) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  try { await run(`http://127.0.0.1:${address.port}`, server); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
const cfg = (url: string, timeoutMs = 1000) => ({ enabled: true, url, model: 'TEST-local-http', license: 'TEST', timeoutMs, maxTokens: 256 });

describe('native loopback planner transport (HTTP test server, not model quality)', () => {
  it('uses the caller deadline and avoids the separate global-fetch transport', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Fetch must not own a hidden inference deadline'));
    try {
      await serve((_req, res) => { setTimeout(() => res.end(JSON.stringify({ choices: [{ message: { content: '{"httpTest":true}' }, finish_reason: 'stop' }] })), 100); }, async url => {
        const result = await localPlanCompletion({ cfg: cfg(url), prompt: 'HTTP test, not a generated plan' });
        expect(result.candidates[0].content.parts[0].text).toBe('{"httpTest":true}');
        expect(spy).not.toHaveBeenCalled();
      });
    } finally { spy.mockRestore(); }
  });
  it('enforces the configured deadline while waiting for headers', async () => {
    await serve(() => {}, async url => {
      await expect(localPlanCompletion({ cfg: cfg(url, 40), prompt: 'HTTP deadline test' })).rejects.toMatchObject({ code: 'FACTORY_PROVIDER_TIMEOUT', status: 504 });
    });
  });
  it('cancels while reading a partial response body', async () => {
    await serve((_req, res) => { res.writeHead(200); res.write('{"choices":'); }, async url => {
      const controller = new AbortController();
      const pending = localPlanCompletion({ cfg: cfg(url), prompt: 'HTTP cancellation test', signal: controller.signal });
      const timer = setTimeout(() => controller.abort(), 40);
      try { await expect(pending).rejects.toMatchObject({ code: 'FACTORY_JOB_CANCELLED', status: 409 }); }
      finally { clearTimeout(timer); }
    });
  });
  it('does not follow redirects off loopback', async () => {
    await serve((_req, res) => { res.writeHead(302, { location: 'https://example.com/private' }); res.end(); }, async url => {
      await expect(localPlanCompletion({ cfg: cfg(url), prompt: 'HTTP redirect test' })).rejects.toMatchObject({ code: 'FACTORY_PROVIDER_UNAVAILABLE', status: 503 });
    });
  });
  it('rejects an oversized response without exposing its content', async () => {
    await serve((_req, res) => res.end('PRIVATE_TEST_BODY'.repeat(70000)), async url => {
      const error = await localPlanCompletion({ cfg: cfg(url), prompt: 'HTTP bound test' }).catch(e => e);
      expect(error.code).toBe('FACTORY_PROVIDER_UNAVAILABLE');
      expect(error.message).not.toContain('PRIVATE_TEST_BODY');
    });
  });
});
