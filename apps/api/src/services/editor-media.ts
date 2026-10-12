/**
 * Media responses for the editor (narration and preview). Uses the same
 * single-range rules as the owner's narration player (services/byte-range.ts):
 * 206 with exact bytes, 416 when unsatisfiable, otherwise 200 with the full file.
 * Callers run their access checks first; this only serves the bytes.
 */
import fs from 'node:fs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { contentRangeHeader, parseSingleByteRange, unsatisfiableRangeHeader } from './byte-range.js';

export function sendEditorMedia(req: FastifyRequest, reply: FastifyReply, file: string, mimeType: string) {
  const size = fs.statSync(file).size;
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Cache-Control', 'no-cache');
  const plan = parseSingleByteRange(req.headers.range, size);
  if (plan.kind === 'unsatisfiable') {
    reply.header('Content-Range', unsatisfiableRangeHeader(size));
    reply.header('Content-Type', 'application/json; charset=utf-8');
    return reply.code(416).send({ code: 'RANGE_NOT_SATISFIABLE', error: 'The requested byte range cannot be satisfied.' });
  }
  reply.header('Content-Type', mimeType);
  if (plan.kind === 'partial') {
    reply.header('Content-Range', contentRangeHeader(plan.start, plan.end, size));
    reply.header('Content-Length', plan.end - plan.start + 1);
    return reply.code(206).send(fs.createReadStream(file, { start: plan.start, end: plan.end }));
  }
  reply.header('Content-Length', size);
  return reply.code(200).send(fs.createReadStream(file));
}
