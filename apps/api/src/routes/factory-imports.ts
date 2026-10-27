/**
 * Storyboard import routes. The PDF importer uses the built-in, dependency-free
 * parser (services/pdf-storyboard.ts) and writes extracted JPEG pictures through
 * the same library rules as a measured upload: recorded source and licence,
 * sha256 identity, no silent licensing. It creates no draft: the canonical
 * POST /api/factory/drafts path stays the single way to create one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Asset, FactoryStoryboardV1 } from '@buildtrack/core';
import { ASSETS_DIR, ensureDirs } from '../services/platform.js';
import { readWritableAssetIndex, saveAssetIndex, sniffImageMime } from './assets.js';
import { parsePdfStoryboard, PdfStoryboardError, PDF_MAX_BYTES, PDF_PARSER_ID } from '../services/pdf-storyboard.js';

/** JPEG frame dimensions from SOF markers, matching the measured-upload rule (no image dependency). */
function jpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

const slug = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'picture';

export async function registerFactoryImportRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/factory/imports/storyboard-pdf', async (req, reply: FastifyReply) => {
    try {
      const parts = req.parts();
      let file: { name: string; mimeType: string; buffer: Buffer } | null = null;
      const fields = new Map<string, string>();
      for await (const part of parts) {
        if (part.type === 'file') {
          const buffer = await part.toBuffer();
          file = { name: String(part.filename ?? 'storyboard.pdf'), mimeType: String(part.mimetype ?? 'application/pdf'), buffer };
        } else {
          fields.set(String(part.fieldname), String(part.value ?? ''));
        }
      }
      if (!file) return reply.code(400).send({ code: 'FACTORY_VALIDATION', error: 'No file received. Send the PDF as a multipart file field.' });
      if (file.buffer.length > PDF_MAX_BYTES) {
        return reply.code(422).send({ code: 'FACTORY_PDF_TOO_LARGE', error: `The PDF is larger than ${PDF_MAX_BYTES} bytes. Nothing was imported.` });
      }
      // Measured magic, not the declared MIME type.
      if (!file.buffer.subarray(0, Math.min(file.buffer.length, 1024)).toString('latin1').includes('%PDF-')) {
        return reply.code(422).send({ code: 'FACTORY_PDF_NOT_PDF', error: 'The file is not a PDF. Nothing was imported.' });
      }
      const source = fields.get('source')?.trim();
      const license = fields.get('license')?.trim();
      if (!source || !license) {
        return reply.code(422).send({ code: 'FACTORY_VALIDATION', error: 'Record the source and licence of the PDF and its embedded pictures before importing. Nothing was added to the library.' });
      }

      const extract = parsePdfStoryboard(file.buffer);
      ensureDirs();
      // A corrupt existing index is refused precisely instead of being silently replaced by an empty one.
      const index = readWritableAssetIndex();
      const visualAssetIds: string[] = [];
      const writtenFiles: string[] = [];
      const perPage = extract.panels.map((panel) => {
        let pictureAssetId: string | null = null;
        if (panel.picture) {
          const img = panel.picture.bytes;
          if (sniffImageMime(img) !== 'image/jpeg') {
            panel.unsupported.push(`embedded picture on page ${panel.page} is not a valid JPEG; it was not added to the library`);
          } else {
            const id = `${slug(path.basename(file!.name, path.extname(file!.name)))}-${randomUUID().slice(0, 8)}`;
            const fileName = `${id}.jpg`;
            fs.writeFileSync(path.join(ASSETS_DIR, fileName), img);
            writtenFiles.push(path.join(ASSETS_DIR, fileName));
            const dims = jpegSize(img);
            const asset: Asset = {
              id,
              name: `PDF import: ${file!.name} ${panel.picture.name}`,
              kind: 'screenshot',
              fileName,
              sha256: createHash('sha256').update(img).digest('hex'),
              path: fileName,
              mimeType: 'image/jpeg',
              sizeBytes: img.length,
              ...(dims ? { width: dims.width, height: dims.height } : {}),
              tags: ['factory', 'pdf-import'],
              status: 'active',
              preferred: false,
              source,
              license,
              addedAt: new Date().toISOString(),
              usedIn: [],
              blocked: false,
            };
            index.push(asset);
            visualAssetIds.push(id);
            pictureAssetId = id;
          }
        }
        return {
          page: panel.page,
          id: panel.id,
          chars: panel.narration.length,
          pictureAssetId,
          unsupported: panel.unsupported,
        };
      });
      try {
        // The only mutating step. Atomic temp+rename means a crash never leaves a half-written index.
        saveAssetIndex(index);
      } catch (err) {
        // Roll back every picture written by this import: no orphan files, and the pre-existing index is untouched.
        for (const f of writtenFiles) fs.rmSync(f, { force: true });
        throw err;
      }

      const storyboard: FactoryStoryboardV1 = {
        version: 1,
        scenes: extract.panels.map((panel) => {
          const bound = perPage.find((p) => p.page === panel.page);
          return {
            id: panel.id,
            narration: panel.narration,
            speakerId: null,
            assetId: bound?.pictureAssetId ?? null,
            startSec: null,
            endSec: null,
            locked: false,
          };
        }),
      };
      return reply.code(201).send({
        parser: PDF_PARSER_ID,
        storyboard,
        visualAssetIds,
        report: {
          sourceFileName: file.name,
          pageCount: extract.pageCount,
          warnings: extract.warnings,
          perPage,
        },
      });
    } catch (err) {
      if (err instanceof PdfStoryboardError) {
        return reply.code(err.status).send({ code: err.code, error: err.message });
      }
      // A pre-existing unreadable index must be reported precisely, never silently reset by this import.
      if (err instanceof Error && err.message.includes('asset index')) {
        return reply.code(422).send({ code: 'FACTORY_ASSET_INDEX_UNREADABLE', error: err.message });
      }
      console.error('pdf import failed');
      return reply.code(500).send({ code: 'FACTORY_INTERNAL', error: 'The PDF could not be imported. Nothing was changed.' });
    }
  });
}
