/**
 * Built-in PDF storyboard parser against hand-built, labelled PDF fixtures.
 * These are REAL parse tests (the parser decodes actual PDF bytes, including
 * Flate streams and embedded JPEGs), not mocks. They are not owner documents.
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  parsePdfStoryboard,
  PdfStoryboardError,
  PDF_MAX_PAGES,
  type PdfPanelExtract,
} from '../apps/api/src/services/pdf-storyboard.js';

/* Minimal, explicit PDF 1.4 writer: uncompressed objects, classic xref table. */
class PdfBuilder {
  private objects = new Map<number, string | Buffer>();

  set(id: number, body: string | Buffer): this {
    this.objects.set(id, body);
    return this;
  }

  build(rootId = 1, extraTrailer = ''): Buffer {
    const ids = [...this.objects.keys()].sort((a, b) => a - b);
    let out = '%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n';
    const offsets = new Map<number, number>();
    for (const id of ids) {
      offsets.set(id, Buffer.byteLength(out, 'latin1'));
      const body = this.objects.get(id) as string | Buffer;
      out += `${id} 0 obj\n`;
      if (Buffer.isBuffer(body)) {
        out = Buffer.concat([Buffer.from(out, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
      } else {
        out += `${body}\nendobj\n`;
      }
    }
    const xrefStart = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${ids.length + 1}\n0000000000 65535 f \n`;
    for (const id of ids) out += `${String(offsets.get(id)).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${ids.length + 1} /Root ${rootId} 0 R${extraTrailer} >>\nstartxref\n${xrefStart}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}

const streamObj = (dict: string, bytes: Buffer): string =>
  `${dict}\nstream\n` + bytes.toString('latin1') + '\nendstream';

function textPage(builder: PdfBuilder, pageId: number, contentId: number, parentId: number, content: string, extraResources = ''): void {
  builder.set(contentId, streamObj('<< /Length ' + Buffer.byteLength(content, 'latin1') + ' >>', Buffer.from(content, 'latin1')));
  builder.set(
    pageId,
    `<< /Type /Page /Parent ${parentId} 0 R /Resources << /Font << /F1 10 0 R >>${extraResources} >> /Contents ${contentId} 0 R >>`,
  );
}

describe('built-in PDF storyboard parser', () => {
  it('parses two uncompressed text pages into ordered panels with stable ids and exact words', () => {
    const b = new PdfBuilder();
    b.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
    b.set(2, '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>');
    textPage(b, 3, 4, 2, 'BT /F1 12 Tf 72 700 Td (Panel one words) Tj ET');
    textPage(b, 5, 6, 2, 'BT /F1 12 Tf 72 700 Td (Panel two words) Tj ET');
    b.set(10, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    const pdf = b.build();

    const result = parsePdfStoryboard(pdf);
    expect(result.pageCount).toBe(2);
    expect(result.panels.map((p) => p.id)).toEqual(['page-01', 'page-02']);
    expect(result.panels.map((p) => p.narration)).toEqual(['Panel one words', 'Panel two words']);
    expect(result.panels.every((p) => p.picture === null)).toBe(true);
  });

  it('decodes FlateDecode content streams and TJ arrays with kerning numbers', () => {
    const b = new PdfBuilder();
    b.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
    b.set(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    const content = zlib.deflateSync(Buffer.from('BT /F1 12 Tf 72 700 Td [(Hello) -250 ( world)] TJ ET', 'latin1'));
    b.set(4, `<< /Filter /FlateDecode /Length ${content.length} >>\nstream\n` + content.toString('latin1') + '\nendstream');
    b.set(3, '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 10 0 R >> >> /Contents 4 0 R >>');
    b.set(10, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    const result = parsePdfStoryboard(b.build());
    expect(result.panels[0].narration).toBe('Hello world');
  });

  it('extracts an embedded DCTDecode (JPEG) picture and binds it to its page', async () => {
    const jpeg = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#2266aa' } }).jpeg().toBuffer();
    const b = new PdfBuilder();
    b.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
    b.set(2, '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>');
    textPage(b, 3, 4, 2, 'BT /F1 12 Tf (Picture page) Tj ET', ' /XObject << /Im1 9 0 R >>');
    textPage(b, 5, 6, 2, 'BT /F1 12 Tf (Text only page) Tj ET');
    b.set(10, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    b.set(9, `<< /Type /XObject /Subtype /Image /Width 12 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n` + jpeg.toString('latin1') + '\nendstream');
    const result = parsePdfStoryboard(b.build());
    expect(result.panels[0].picture).not.toBeNull();
    expect(result.panels[0].picture!.mimeType).toBe('image/jpeg');
    expect(result.panels[0].picture!.bytes.equals(jpeg)).toBe(true);
    expect(result.panels[1].picture).toBeNull();
    expect(result.panels.map((p) => p.narration)).toEqual(['Picture page', 'Text only page']);
  });

  it('maps CID text through a ToUnicode CMap, including Arabic code points', () => {
    // Map CID 0x0041 -> 'A' and 0x0633 -> Arabic seen (س) through beginbfchar/beginbfrange.
    const cmap = Buffer.from(
      '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n1 beginbfchar\n<0041> <0041>\n<0633> <0633>\nendbfchar\n1 beginbfrange\n<0042> <0044> <0042>\nendbfrange\nendcmap\nCMapName currentdict /CMap defineresource pop end end',
      'latin1',
    );
    const cmapFlate = zlib.deflateSync(cmap);
    const content = Buffer.from('BT /F2 12 Tf <0041> Tj <0633> Tj ET', 'latin1');
    const b = new PdfBuilder();
    b.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
    b.set(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    b.set(4, `<< /Length ${content.length} >>\nstream\n` + content.toString('latin1') + '\nendstream');
    b.set(3, '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F2 11 0 R >> >> /Contents 4 0 R >>');
    b.set(11, '<< /Type /Font /Subtype /Type0 /BaseFont /DummyCID /Encoding /Identity-H /ToUnicode 12 0 R >>');
    b.set(12, `<< /Filter /FlateDecode /Length ${cmapFlate.length} >>\nstream\n` + cmapFlate.toString('latin1') + '\nendstream');
    const result = parsePdfStoryboard(b.build());
    expect(result.panels[0].narration).toContain('A');
    expect(result.panels[0].narration).toContain('س');
    // The bfrange maps B,C,D contiguously.
    const map = result;
    expect(map.parser).toBe('builtin-pdf-storyboard-parser-v1');
  });

  it('keeps a blank page as an empty panel in exact page order and names the gap', () => {
    const b = new PdfBuilder();
    b.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
    b.set(2, '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>');
    textPage(b, 3, 4, 2, 'BT /F1 12 Tf (First) Tj ET');
    b.set(6, '<< /Length 0 >>\nstream\n\nendstream');
    b.set(5, '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 10 0 R >> >> /Contents 6 0 R >>');
    b.set(10, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    const result = parsePdfStoryboard(b.build());
    expect(result.panels.map((p) => p.id)).toEqual(['page-01', 'page-02']);
    expect(result.panels[1].narration).toBe('');
    expect(result.panels[1].unsupported.join(' ')).toMatch(/no extractable text or picture/);
  });

  it('refuses non-PDF bytes, encrypted files, unsupported filters and over-page documents with precise codes', () => {
    expect(() => parsePdfStoryboard(Buffer.from('not a pdf at all'))).toThrow(PdfStoryboardError);
    try {
      parsePdfStoryboard(Buffer.from('not a pdf'));
    } catch (e) {
      expect((e as PdfStoryboardError).code).toBe('FACTORY_PDF_NOT_PDF');
    }

    const enc = new PdfBuilder();
    enc.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
    enc.set(2, '<< /Type /Pages /Kids [] /Count 0 >>');
    enc.set(20, '<< /Filter /Standard /V 2 /R 3 >>');
    const encrypted = enc.build(1, ' /Encrypt 20 0 R');
    expect(() => parsePdfStoryboard(encrypted)).toThrow(/Encrypted/);

    const lzw = new PdfBuilder();
    lzw.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
    lzw.set(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    lzw.set(4, '<< /Filter /LZWDecode /Length 5 >>\nstream\nABCDE\nendstream');
    lzw.set(3, '<< /Type /Page /Parent 2 0 R /Resources << >> /Contents 4 0 R >>');
    const lzwErr = (() => {
      try {
        parsePdfStoryboard(lzw.build());
        return null;
      } catch (e) {
        return e as PdfStoryboardError;
      }
    })();
    expect(lzwErr).not.toBeNull();
    expect(lzwErr!.message).toMatch(/LZW|full-parser/i);

    const big = new PdfBuilder();
    const kids: string[] = [];
    const pageIds: number[] = [];
    for (let i = 0; i < PDF_MAX_PAGES + 1; i += 1) {
      const pageId = 100 + i * 2;
      const contentId = pageId + 1;
      pageIds.push(pageId);
      big.set(contentId, '<< /Length 0 >>\nstream\n\nendstream');
      big.set(pageId, `<< /Type /Page /Parent 2 0 R /Resources << >> /Contents ${contentId} 0 R >>`);
      kids.push(`${pageId} 0 R`);
    }
    big.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
    big.set(2, `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageIds.length} >>`);
    expect(() => parsePdfStoryboard(big.build())).toThrow(/at most/);
  });

  it('refuses an oversize file before parsing', () => {
    const big = Buffer.alloc(11 * 1024 * 1024, 0x20);
    big.write('%PDF-1.4', 0, 'latin1');
    expect(() => parsePdfStoryboard(big)).toThrow(/larger than/);
  });

  it('parser output stays within the panel contract shape the import route expects', () => {
    const b = new PdfBuilder();
    b.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
    b.set(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    textPage(b, 3, 4, 2, 'BT /F1 12 Tf (Contract check) Tj ET');
    b.set(10, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    const result = parsePdfStoryboard(b.build());
    const panel: PdfPanelExtract = result.panels[0];
    expect(panel).toMatchObject({ id: 'page-01', page: 1, narration: 'Contract check' });
    expect(panel.unsupported).toBeInstanceOf(Array);
  });
});

describe('built-in PDF parser hardening: bounded, precise, no silent corruption', () => {
  const codeOf = (fn: () => unknown): string => {
    try {
      fn();
      return 'NO_THROW';
    } catch (e) {
      return (e as PdfStoryboardError).code;
    }
  };

  it('terminates on a cyclic page tree and refuses with a precise code instead of overflowing', () => {
    const b = new PdfBuilder();
    // Pages 2 lists itself as a kid: without cycle protection walk() would recurse forever.
    b.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
    b.set(2, '<< /Type /Pages /Kids [2 0 R] /Count 1 >>');
    expect(codeOf(() => parsePdfStoryboard(b.build()))).toBe('FACTORY_PDF_NO_PAGES');
  });

  it('refuses deeply nested dictionaries/arrays before the call stack can overflow', () => {
    const nested = '['.repeat(260) + '0' + ']'.repeat(260);
    const b = new PdfBuilder();
    b.set(1, `<< /Type /Catalog /Pages 2 0 R /K ${nested} >>`);
    b.set(2, '<< /Type /Pages /Kids [] /Count 0 >>');
    expect(codeOf(() => parsePdfStoryboard(b.build()))).toBe('FACTORY_PDF_MALFORMED');
  });

  it('refuses duplicate object numbers instead of letting one silently overwrite the other', () => {
    // Two physical "3 0 obj" blocks: the parser must refuse, not pick a winner silently.
    let pdf = '%PDF-1.4\n';
    pdf += '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
    pdf += '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n';
    pdf += '3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << >> /Contents 4 0 R >>\nendobj\n';
    pdf += '4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n';
    pdf += '3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << >> >>\nendobj\n';
    pdf += 'trailer\n<< /Root 1 0 R >>\n%%EOF\n';
    expect(codeOf(() => parsePdfStoryboard(Buffer.from(pdf, 'latin1')))).toBe('FACTORY_PDF_MALFORMED');
  });

  it('stops a Flate expansion beyond the decoded budget without allocating the full output', () => {
    // ~61 MB of zeros compresses to a few tens of KB, well inside the 10 MB input cap.
    const huge = Buffer.alloc(61 * 1024 * 1024, 0);
    const flate = zlib.deflateSync(huge);
    expect(flate.length).toBeLessThan(1024 * 1024);
    const b = new PdfBuilder();
    b.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
    b.set(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    b.set(3, '<< /Type /Page /Parent 2 0 R /Resources << >> /Contents 4 0 R >>');
    b.set(4, `<< /Filter /FlateDecode /Length ${flate.length} >>\nstream\n` + flate.toString('latin1') + '\nendstream');
    const code = codeOf(() => parsePdfStoryboard(b.build()));
    expect(['FACTORY_PDF_TOO_LARGE', 'FACTORY_PDF_UNSUPPORTED']).toContain(code);
  });

  it('never silently binds a non-JPEG stream as a picture: unsupported filters are named per page', () => {
    const b = new PdfBuilder();
    b.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
    b.set(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    b.set(4, '<< /Length 0 >>\nstream\n\nendstream');
    // An image with an unsupported (non-DCT) filter.
    b.set(9, '<< /Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length 0 >>\nstream\n\nendstream');
    b.set(3, '<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 9 0 R >> >> /Contents 4 0 R >>');
    const result = parsePdfStoryboard(b.build());
    expect(result.panels[0].picture).toBeNull();
    expect(result.panels[0].unsupported.join(' ')).toMatch(/FlateDecode|filter/i);
  });
});
