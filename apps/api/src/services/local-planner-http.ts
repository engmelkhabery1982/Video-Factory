import { request } from 'node:http';
import type { FetchLike } from './gemini-client.js';

/** Loopback-only, bounded response transport. The caller owns the single
 * deadline/abort signal; Node fetch's separate 300s header deadline must not
 * cut a configured longer CPU inference short. No redirect or external host. */
export const localPlannerHttp: FetchLike = (raw, init) => new Promise((resolve, reject) => {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
    reject(new Error('Local planner transport requires loopback HTTP.'));
    return;
  }
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  const req = request(url, { method: init.method, headers: init.headers, signal: init.signal, maxHeaderSize: 16384 }, res => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    res.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        const error = new Error('Local planner response exceeds 1 MiB.');
        reject(error);
        res.destroy(error);
        return;
      }
      chunks.push(chunk);
    });
    res.on('error', reject);
    res.on('aborted', () => reject(new Error('Local planner response interrupted.')));
    res.on('end', () => {
      const status = res.statusCode ?? 0;
      const text = Buffer.concat(chunks).toString('utf8');
      resolve({ status, ok: status >= 200 && status < 300, json: async () => JSON.parse(text) });
    });
  });
  req.on('error', reject);
  req.end(init.body);
});
