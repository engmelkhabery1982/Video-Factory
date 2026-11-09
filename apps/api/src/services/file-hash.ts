/**
 * Streamed SHA-256 of a file, cached by path, size and modified time. Large weight files (the CLIP image encoder is
 * about 2.5 GB) are never read into memory at once. The cache only skips recomputing an unchanged file.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

const cache = new Map<string, { key: string; sha256: string }>();

export function sha256FileStream(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (chunk) => h.update(chunk));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

export async function cachedFileSha256(file: string): Promise<string> {
  const st = fs.statSync(file);
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = cache.get(file);
  if (hit && hit.key === key) return hit.sha256;
  const sha256 = await sha256FileStream(file);
  cache.set(file, { key, sha256 });
  return sha256;
}
