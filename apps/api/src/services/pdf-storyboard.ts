/**
 * Built-in PDF storyboard parser. Zero third-party dependencies: only node:zlib and node:buffer.
 *
 * Scope (honest, tested limits — the full-parser provisioning decision is documented beside this):
 *  - PDF 1.x with uncompressed indirect objects and classic or stream cross-references.
 *  - Text: literal and hex strings in content streams, WinAnsi/PDFDoc simple fonts and CID fonts
 *    with a /ToUnicode CMap (the common Word/Google Docs print path, including Arabic).
 *  - Pictures: embedded DCTDecode (JPEG) images, in page/XObject order. Flate/other raster filters
 *    are named as unsupported instead of being silently dropped.
 *  - One panel per page, in page-tree order, with stable page-NN ids.
 * Refused precisely: encrypted files, compressed object streams that own required objects,
 * unsupported content filters, oversize/over-page files and files with no pages.
 */
import zlib from 'node:zlib';

export const PDF_MAX_BYTES = 10 * 1024 * 1024;
export const PDF_MAX_PAGES = 60;
export const PDF_MAX_OBJECTS = 4096;
export const PDF_MAX_DECODED_BYTES = 60 * 1024 * 1024;
export const PDF_PARSER_ID = 'builtin-pdf-storyboard-parser-v1';

export class PdfStoryboardError extends Error {
  constructor(readonly code: string, message: string, readonly status: number = 422) {
    super(message);
    this.name = 'PdfStoryboardError';
  }
}

export interface PdfPicture {
  mimeType: 'image/jpeg';
  bytes: Buffer;
  name: string;
}

export interface PdfPanelExtract {
  id: string;
  page: number;
  narration: string;
  picture: PdfPicture | null;
  /** Per-page unsupported features, named precisely. Never silently ignored. */
  unsupported: string[];
}

export interface PdfStoryboardExtract {
  parser: typeof PDF_PARSER_ID;
  pageCount: number;
  panels: PdfPanelExtract[];
  warnings: string[];
}

interface PdfObject {
  id: number;
  gen: number;
  dict: Map<string, PdfToken>;
  stream: Buffer | null;
  raw: Buffer;
}

type PdfToken =
  | { kind: 'name'; value: string }
  | { kind: 'ref'; id: number; gen: number }
  | { kind: 'string'; value: Buffer }
  | { kind: 'hex'; value: Buffer }
  | { kind: 'array'; value: PdfToken[] }
  | { kind: 'dict'; value: Map<string, PdfToken> }
  | { kind: 'number'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' };

const pad2 = (n: number) => String(n).padStart(2, '0');

/* ------------------------------------------------------------------ */
/* Tokenizer                                                           */
/* ------------------------------------------------------------------ */

/** Nested arrays/dicts past this depth are malformed: the bound stops a crafted file from overflowing the call stack. */
const PDF_MAX_NESTING = 200;

class PdfScanner {
  private pos = 0;
  private depth = 0;
  constructor(private readonly buf: Buffer) {}

  get position(): number {
    return this.pos;
  }

  peek(at = 0): number {
    return this.buf[this.pos + at] ?? -1;
  }

  skipWhitespace(): void {
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos];
      if (c === 0x25) {
        // comment to end of line
        while (this.pos < this.buf.length && this.buf[this.pos] !== 0x0a && this.buf[this.pos] !== 0x0d) this.pos += 1;
        continue;
      }
      if (/\s/.test(String.fromCharCode(c))) {
        this.pos += 1;
        continue;
      }
      break;
    }
  }

  /** Parse one object token starting at the current position. */
  next(): PdfToken | null {
    this.skipWhitespace();
    if (this.pos >= this.buf.length) return null;
    const c = this.buf[this.pos];
    if (c === 0x3c) {
      if (this.buf[this.pos + 1] === 0x3c) {
        this.pos += 2;
        return this.readDict();
      }
      return this.readHexString();
    }
    if (c === 0x28) return this.readLiteralString();
    if (c === 0x5b) return this.readArray();
    if (c === 0x2f) return this.readName();
    if (c === 0x3e && this.buf[this.pos + 1] === 0x3e) {
      this.pos += 2;
      return { kind: 'null' }; // closing dict marker; caller stops
    }
    return this.readKeywordOrNumber();
  }

  private readName(): PdfToken {
    this.pos += 1; // slash
    let out = '';
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos];
      if (/\s/.test(String.fromCharCode(c)) || '()<>[]/{}/%'.includes(String.fromCharCode(c))) break;
      if (c === 0x23) {
        out += String.fromCharCode(parseInt(this.buf.toString('latin1', this.pos + 1, this.pos + 3), 16));
        this.pos += 3;
        continue;
      }
      out += String.fromCharCode(c);
      this.pos += 1;
    }
    return { kind: 'name', value: out };
  }

  private readLiteralString(): PdfToken {
    this.pos += 1; // (
    let depth = 1;
    const bytes: number[] = [];
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos];
      if (c === 0x5c) {
        const e = this.buf[this.pos + 1];
        if (e >= 0x30 && e <= 0x37) {
          let oct = '';
          let k = 1;
          while (k <= 3 && this.buf[this.pos + k] >= 0x30 && this.buf[this.pos + k] <= 0x37) {
            oct += String.fromCharCode(this.buf[this.pos + k]);
            k += 1;
          }
          bytes.push(parseInt(oct, 8) & 0xff);
          this.pos += k;
          continue;
        }
        const simple: Record<number, number> = { [0x6e]: 0x0a, [0x72]: 0x0d, [0x74]: 0x09, [0x62]: 0x08, [0x66]: 0x0c, [0x28]: 0x28, [0x29]: 0x29, [0x5c]: 0x5c };
        if (e in simple) bytes.push(simple[e]);
        else if (e === 0x0a) { /* escaped newline: skip */ }
        else if (e === 0x0d) {
          if (this.buf[this.pos + 2] === 0x0a) this.pos += 1;
        } else bytes.push(e);
        this.pos += 2;
        continue;
      }
      if (c === 0x28) {
        depth += 1;
        bytes.push(c);
        this.pos += 1;
        continue;
      }
      if (c === 0x29) {
        depth -= 1;
        this.pos += 1;
        if (depth === 0) break;
        bytes.push(c);
        continue;
      }
      bytes.push(c);
      this.pos += 1;
    }
    return { kind: 'string', value: Buffer.from(bytes) };
  }

  private readHexString(): PdfToken {
    this.pos += 1; // <
    const hex: string[] = [];
    while (this.pos < this.buf.length && this.buf[this.pos] !== 0x3e) {
      const ch = String.fromCharCode(this.buf[this.pos]);
      if (!/\s/.test(ch)) hex.push(ch);
      this.pos += 1;
    }
    this.pos += 1; // >
    if (hex.length % 2 === 1) hex.push('0');
    const clean = hex.join('').replace(/[^0-9a-fA-F]/g, '0');
    return { kind: 'hex', value: Buffer.from(clean, 'hex') };
  }

  private readArray(): PdfToken {
    this.pos += 1; // [
    this.depth += 1;
    if (this.depth > PDF_MAX_NESTING) {
      throw new PdfStoryboardError('FACTORY_PDF_MALFORMED', `The PDF nests arrays or dictionaries deeper than ${PDF_MAX_NESTING}. Nothing was imported.`);
    }
    const value: PdfToken[] = [];
    for (;;) {
    this.skipWhitespace();
    if (this.buf[this.pos] === 0x5d) {
      this.pos += 1;
      this.depth -= 1;
      return { kind: 'array', value };
    }
    const t = this.next();
      if (!t) throw new PdfStoryboardError('FACTORY_PDF_MALFORMED', 'A PDF array is not closed.');
      const maybeRef = this.tryRef(t);
      value.push(maybeRef ?? t);
    }
  }

  private readDict(): PdfToken {
    this.depth += 1;
    if (this.depth > PDF_MAX_NESTING) {
      throw new PdfStoryboardError('FACTORY_PDF_MALFORMED', `The PDF nests arrays or dictionaries deeper than ${PDF_MAX_NESTING}. Nothing was imported.`);
    }
    const value = new Map<string, PdfToken>();
    for (;;) {
      this.skipWhitespace();
      if (this.buf[this.pos] === 0x3e && this.buf[this.pos + 1] === 0x3e) {
        this.pos += 2;
        this.depth -= 1;
        return { kind: 'dict', value };
      }
      const key = this.next();
      if (!key || key.kind !== 'name') throw new PdfStoryboardError('FACTORY_PDF_MALFORMED', 'A PDF dictionary key is not a name.');
      const val = this.next();
      if (!val) throw new PdfStoryboardError('FACTORY_PDF_MALFORMED', `PDF dictionary entry /${key.value} has no value.`);
      value.set(key.value, this.tryRef(val) ?? val);
    }
  }

  /** "12 0 R" is three tokens; fold the pattern into one ref token. */
  private tryRef(first: PdfToken): PdfToken | null {
    if (first.kind !== 'number' || !Number.isInteger(first.value)) return null;
    const save = this.pos;
    this.skipWhitespace();
    const gen = this.next();
    const r = this.next();
    if (gen && gen.kind === 'number' && r && r.kind === 'name' && r.value === 'R') {
      return { kind: 'ref', id: first.value, gen: gen.value };
    }
    this.pos = save;
    return null;
  }

  private readKeywordOrNumber(): PdfToken {
    const start = this.pos;
    while (this.pos < this.buf.length) {
      const c = String.fromCharCode(this.buf[this.pos]);
      if (/\s/.test(c) || '()<>[]/{}/%'.includes(c)) break;
      this.pos += 1;
    }
    const word = this.buf.toString('latin1', start, this.pos);
    if (word === 'true') return { kind: 'bool', value: true };
    if (word === 'false') return { kind: 'bool', value: false };
    if (word === 'null') return { kind: 'null' };
    const n = Number(word);
    if (word.length > 0 && Number.isFinite(n)) return { kind: 'number', value: n };
    return { kind: 'name', value: word };
  }
}

/* ------------------------------------------------------------------ */
/* Object level                                                        */
/* ------------------------------------------------------------------ */

const SUPPORTED_STREAM_FILTERS = new Set(['FlateDecode', 'Fl', 'DCTDecode', 'DCT']);

function filterNames(t: PdfToken | undefined): string[] {
  if (!t) return [];
  if (t.kind === 'name') return [t.value];
  if (t.kind === 'array') return t.value.filter((x): x is Extract<PdfToken, { kind: 'name' }> => x.kind === 'name').map((x) => x.value);
  return [];
}

function decodeStream(obj: PdfObject, decodedBudget: { used: number }): { bytes: Buffer | null; unsupported: string[] } {
  if (!obj.stream) return { bytes: null, unsupported: [] };
  const unsupported: string[] = [];
  const filters = filterNames(obj.dict.get('Filter'));
  const bad = filters.filter((f) => !SUPPORTED_STREAM_FILTERS.has(f));
  if (bad.length > 0) {
    unsupported.push(`stream filter ${bad.join(', ')} is not supported by the built-in parser`);
    return { bytes: null, unsupported };
  }
  if (filters.length === 0) {
    return { bytes: obj.stream, unsupported }; // uncompressed stream: bytes are already decoded
  }
  if (filters.some((f) => f === 'DCTDecode' || f === 'DCT')) {
    return { bytes: obj.stream, unsupported }; // JPEG bytes are used as-is
  }
  // Bound a single stream's allocation: maxOutputLength makes zlib stop instead of inflating a bomb into memory.
  const remaining = Math.max(0, PDF_MAX_DECODED_BYTES - decodedBudget.used);
  try {
    let out: Buffer;
    try {
      out = zlib.inflateSync(obj.stream, { maxOutputLength: remaining });
    } catch {
      out = zlib.inflateRawSync(obj.stream, { maxOutputLength: remaining });
    }
    decodedBudget.used += out.length;
    if (decodedBudget.used > PDF_MAX_DECODED_BYTES) {
      throw new PdfStoryboardError('FACTORY_PDF_TOO_LARGE', `The PDF expands beyond ${PDF_MAX_DECODED_BYTES} decoded bytes. Nothing was imported.`);
    }
    return { bytes: out, unsupported };
  } catch (err) {
    if (err instanceof PdfStoryboardError) throw err;
    unsupported.push('a FlateDecode stream could not be decompressed');
    return { bytes: null, unsupported };
  }
}

function parseObjects(buf: Buffer): { objects: Map<number, PdfObject>; hasObjStm: boolean; hasEncrypt: boolean } {
  const objects = new Map<number, PdfObject>();
  const head = buf.toString('latin1', 0, Math.min(buf.length, 1024));
  if (!/%PDF-\d\.\d/.test(head)) {
    throw new PdfStoryboardError('FACTORY_PDF_NOT_PDF', 'The file does not start with a PDF header. Nothing was imported.');
  }
  // latin1 keeps one byte per character, so string indices below stay identical to byte offsets.
  const latin = buf.toString('latin1');
  if (/\/Encrypt\b/.test(latin)) {
    throw new PdfStoryboardError('FACTORY_PDF_ENCRYPTED', 'Encrypted PDFs are not supported. Remove the password and save an unencrypted copy, then import again.');
  }
  const re = /(\d+)\s+(\d+)\s+obj/g;
  let m: RegExpExecArray | null;
  let hasObjStm = false;
  while ((m = re.exec(latin)) !== null) {
    if (objects.size >= PDF_MAX_OBJECTS) {
      throw new PdfStoryboardError('FACTORY_PDF_TOO_LARGE', `The PDF has more than ${PDF_MAX_OBJECTS} objects. Nothing was imported.`);
    }
    const id = Number(m[1]);
    const gen = Number(m[2]);
    const start = re.lastIndex;
    const end = buf.indexOf('endobj', start);
    if (end < 0) break;
    const raw = buf.subarray(start, end);
    const streamIdx = raw.indexOf('stream');
    let dictBuf: Buffer;
    let stream: Buffer | null = null;
    if (streamIdx >= 0) {
      // The dictionary is the <<...>> before 'stream'; validate the keyword sits outside a dict token.
      const dictEnd = raw.lastIndexOf('>>', streamIdx);
      dictBuf = dictEnd >= 0 ? raw.subarray(0, dictEnd + 2) : raw.subarray(0, streamIdx);
      let s = streamIdx + 6;
      if (raw[s] === 0x0d && raw[s + 1] === 0x0a) s += 2;
      else if (raw[s] === 0x0a || raw[s] === 0x0d) s += 1;
      let e = raw.indexOf('endstream', s);
      if (e < 0) e = raw.length;
      // Trim a single EOL before endstream per the PDF spec.
      if (raw[e - 1] === 0x0a) e -= 1;
      if (raw[e - 1] === 0x0d) e -= 1;
      stream = raw.subarray(s, e);
    } else {
      dictBuf = raw;
    }
    const scanner = new PdfScanner(dictBuf);
    const token = scanner.next();
    if (!token || token.kind !== 'dict') continue; // malformed object; pages that need it will fail precisely
    if (objects.has(id)) {
      // Duplicate object numbers are ambiguous (which revision wins?). Refuse instead of silently last-wins.
      throw new PdfStoryboardError('FACTORY_PDF_MALFORMED', `The PDF defines object ${id} more than once. Nothing was imported.`);
    }
    const obj: PdfObject = { id, gen, dict: token.value, stream, raw };
    if (obj.dict.get('Type')?.kind === 'name' && (obj.dict.get('Type') as Extract<PdfToken, { kind: 'name' }>).value === 'ObjStm') {
      hasObjStm = true;
    }
    objects.set(id, obj);
  }
  return { objects, hasObjStm, hasEncrypt: false };
}

/* ------------------------------------------------------------------ */
/* Page tree                                                           */
/* ------------------------------------------------------------------ */

function asRef(t: PdfToken | undefined): { id: number } | null {
  return t && t.kind === 'ref' ? { id: t.id } : null;
}

function dictName(t: PdfToken | undefined): string | null {
  return t && t.kind === 'name' ? t.value : null;
}

function orderedPages(objects: Map<number, PdfObject>): PdfObject[] {
  const roots: PdfObject[] = [];
  for (const obj of objects.values()) {
    if (dictName(obj.dict.get('Type')) === 'Pages') roots.push(obj);
  }
  const pageRoot = roots.find((o) => !o.dict.has('Parent')) ?? roots[0];
  const out: PdfObject[] = [];
  // Every node id, not just pages: a cyclic or re-entrant Kids tree must terminate instead of overflowing the stack.
  const visited = new Set<number>();
  const seenPages = new Set<number>();
  const walk = (node: PdfObject | undefined): void => {
    if (!node || visited.has(node.id)) return;
    visited.add(node.id);
    const type = dictName(node.dict.get('Type'));
    if (type === 'Page') {
      if (seenPages.has(node.id)) return;
      seenPages.add(node.id);
      out.push(node);
      return;
    }
    const kids = node.dict.get('Kids');
    if (kids && kids.kind === 'array') {
      for (const kid of kids.value) {
        const ref = asRef(kid);
        if (ref) walk(objects.get(ref.id));
      }
    }
  };
  if (pageRoot) walk(pageRoot);
  if (out.length === 0) {
    // Fallback: direct /Page objects in object-id order, still de-duplicated.
    for (const obj of [...objects.values()].sort((a, b) => a.id - b.id)) {
      if (dictName(obj.dict.get('Type')) === 'Page' && !seenPages.has(obj.id)) {
        seenPages.add(obj.id);
        out.push(obj);
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Fonts and text                                                      */
/* ------------------------------------------------------------------ */

interface FontInfo {
  toUnicode: Map<number, string> | null;
  codeWidth: 1 | 2;
}

function parseToUnicode(bytes: Buffer): Map<number, string> {
  const text = bytes.toString('latin1');
  const map = new Map<number, string>();
  // ToUnicode destination strings are UTF-16BE; swap to host UTF-16LE before decoding.
  const decodeDst = (hex: string): string => {
    const be = Buffer.from(hex.trim(), 'hex');
    return be.length >= 2 ? be.swap16().toString('utf16le') : be.toString('latin1');
  };
  for (const block of text.match(/beginbfchar[\s\S]*?endbfchar/g) ?? []) {
    const pairs = block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g);
    for (const p of pairs) map.set(parseInt(p[1], 16), decodeDst(p[2]));
  }
  for (const block of text.match(/beginbfrange[\s\S]*?endbfrange/g) ?? []) {
    const lines = block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]+>|\[[\s\S]*?\])/g);
    for (const line of lines) {
      const lo = parseInt(line[1], 16);
      const hi = parseInt(line[2], 16);
      if (line[3].startsWith('[')) {
        const dsts = [...line[3].matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => x[1]);
        for (let i = 0; i <= hi - lo && i < dsts.length; i += 1) map.set(lo + i, decodeDst(dsts[i]));
      } else {
        const baseCode = [...line[3].replace(/[<>]/g, '').matchAll(/.{4}/g)].map((x) => parseInt(x[0], 16));
        for (let code = lo; code <= hi; code += 1) {
          const tail = baseCode.length > 0 ? baseCode[baseCode.length - 1] + (code - lo) : code;
          const prefix = baseCode.slice(0, -1);
          // Big-endian UTF-16 code units, then swap16 for the host decoder.
          const be = Buffer.from([...prefix.flatMap((c) => [c >> 8, c & 0xff]), tail >> 8, tail & 0xff]);
          map.set(code, be.swap16().toString('utf16le'));
        }
      }
    }
  }
  return map;
}

// PDF WinAnsiEncoding (a.k.a. Code Page 1252) for the 0x80..0xFF range.
const WIN_ANSI: Record<number, string> = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž',
  0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
  0xa0: ' ', 0xa1: '¡', 0xa2: '¢', 0xa3: '£', 0xa4: '¤', 0xa5: '¥', 0xa6: '¦', 0xa7: '§', 0xa8: '¨', 0xa9: '©', 0xaa: 'ª', 0xab: '«', 0xac: '¬', 0xae: '®', 0xaf: '¯',
  0xb0: '°', 0xb1: '±', 0xb2: '²', 0xb3: '³', 0xb4: '´', 0xb5: 'µ', 0xb6: '¶', 0xb7: '·', 0xb8: '¸', 0xb9: '¹', 0xba: 'º', 0xbb: '»', 0xbc: '¼', 0xbd: '½', 0xbe: '¾', 0xbf: '¿',
};

function decodeTextBytes(bytes: Buffer, font: FontInfo | null): string {
  if (font?.toUnicode) {
    const width = font.codeWidth;
    const out: string[] = [];
    for (let i = 0; i + width <= bytes.length; i += width) {
      const code = width === 2 ? bytes.readUInt16BE(i) : bytes[i];
      const mapped = font.toUnicode.get(code);
      if (mapped !== undefined) out.push(mapped);
    }
    return out.join('');
  }
  let out = '';
  for (const b of bytes) {
    if (b < 0x80) out += String.fromCharCode(b);
    else out += WIN_ANSI[b] ?? String.fromCharCode(b);
  }
  return out;
}

/** Extract text lines from one decoded content stream. */
function extractContentText(content: Buffer, fonts: Map<string, FontInfo>): string {
  const lines: string[] = [];
  let line = '';
  const flushLine = () => {
    const trimmed = line.replace(/\s+/g, ' ').trim();
    if (trimmed) lines.push(trimmed);
    line = '';
  };
  const scanner = new PdfScanner(content);
  let currentFont: FontInfo | null = null;
  let pendingResourceName: string | null = null;
  let inText = false;
  for (;;) {
    const token = scanner.next();
    if (!token) break;
    if (token.kind === 'name') {
      if (token.value === 'BT') {
        inText = true;
      } else if (token.value === 'ET') {
        inText = false;
        flushLine();
      } else if (!inText) {
        continue;
      } else if (token.value === 'Tf') {
        // Pattern: /F1 12 Tf — the font resource name was the previous name token.
        currentFont = pendingResourceName ? (fonts.get(pendingResourceName) ?? null) : null;
        pendingResourceName = null;
      } else if (/^(Td|TD|Tm|T\*|'|")$/.test(token.value)) {
        flushLine();
        pendingResourceName = null;
      } else if (!/^(Tj|TJ)$/.test(token.value)) {
        // A resource name (font, state, colour) remembered until its operator arrives.
        pendingResourceName = token.value;
      }
      continue;
    }
    if (!inText) continue;
    if (token.kind === 'string' || token.kind === 'hex') {
      line += decodeTextBytes(token.value, currentFont);
    } else if (token.kind === 'array') {
      for (const part of token.value) {
        if (part.kind === 'string' || part.kind === 'hex') line += decodeTextBytes(part.value, currentFont);
      }
    }
  }
  flushLine();
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Pictures                                                            */
/* ------------------------------------------------------------------ */

function pageResourceDict(page: PdfObject, objects: Map<number, PdfObject>): Map<string, PdfToken> | null {
  let res = page.dict.get('Resources');
  if (res && res.kind === 'ref') res = objects.get(res.id)?.dict.get('Resources') ?? res;
  if (res && res.kind === 'dict') return res.value;
  return null;
}

function extractPagePictures(
  page: PdfObject,
  objects: Map<number, PdfObject>,
  decodedBudget: { used: number },
  pageNo: number,
): { pictures: PdfPicture[]; unsupported: string[] } {
  const unsupported: string[] = [];
  const pictures: PdfPicture[] = [];
  const resources = pageResourceDict(page, objects);
  const xobj = resources?.get('XObject');
  if (!xobj || xobj.kind !== 'dict') return { pictures, unsupported };
  let index = 0;
  for (const [name, token] of xobj.value) {
    if (token.kind !== 'ref') continue;
    const obj = objects.get(token.id);
    if (!obj) {
      unsupported.push(`picture /${name} references a missing object (${token.id})`);
      continue;
    }
    if (dictName(obj.dict.get('Subtype')) !== 'Image') continue;
    const filters = filterNames(obj.dict.get('Filter'));
    if (filters.some((f) => f === 'DCTDecode' || f === 'DCT') && obj.stream) {
      pictures.push({ mimeType: 'image/jpeg', bytes: obj.stream, name: `page-${pad2(pageNo)}-${index + 1}.jpg` });
      index += 1;
    } else {
      unsupported.push(`picture /${name} on page ${pageNo} uses ${filters.join('+') || 'an unknown filter'}, not extracted; add it through the library`);
    }
    void decodedBudget;
  }
  return { pictures, unsupported };
}

/* ------------------------------------------------------------------ */
/* Public entry point                                                  */
/* ------------------------------------------------------------------ */

export function parsePdfStoryboard(buf: Buffer): PdfStoryboardExtract {
  if (buf.length > PDF_MAX_BYTES) {
    throw new PdfStoryboardError('FACTORY_PDF_TOO_LARGE', `The PDF is larger than ${PDF_MAX_BYTES} bytes. Nothing was imported.`);
  }
  const { objects, hasObjStm } = parseObjects(buf);
  const pages = orderedPages(objects);
  if (pages.length === 0) {
    throw new PdfStoryboardError('FACTORY_PDF_NO_PAGES', 'The PDF has no readable pages. Nothing was imported.');
  }
  if (pages.length > PDF_MAX_PAGES) {
    throw new PdfStoryboardError('FACTORY_PDF_TOO_MANY_PAGES', `The PDF has ${pages.length} pages; at most ${PDF_MAX_PAGES} storyboard panels are accepted. Split it and import each part.`);
  }
  const decodedBudget = { used: 0 };
  const warnings: string[] = [];
  if (hasObjStm) warnings.push('The PDF contains compressed object streams. The built-in parser read the uncompressed objects it needed; a file whose pages live only in object streams is refused with the exact reason.');

  const panels: PdfPanelExtract[] = [];
  pages.forEach((page, i) => {
    const pageNo = i + 1;
    const unsupported: string[] = [];
    // Fonts for this page.
    const fonts = new Map<string, FontInfo>();
    const resDict = pageResourceDict(page, objects);
    const fontToken = resDict?.get('Font');
    let fontDict: Map<string, PdfToken> | null = null;
    if (fontToken) {
      const resolved = fontToken.kind === 'ref' ? objects.get(fontToken.id) : null;
      fontDict = resolved?.dict ? (resolved.dict.get('Font')?.kind === 'dict' ? (resolved.dict.get('Font') as Extract<PdfToken, { kind: 'dict' }>).value : null) : null;
      if (!fontDict && fontToken.kind === 'dict') fontDict = fontToken.value;
    }
    if (fontDict) {
      for (const [name, t] of fontDict) {
        if (t.kind !== 'ref') continue;
        const fontObj = objects.get(t.id);
        if (!fontObj) continue;
        const uniRef = fontObj.dict.get('ToUnicode');
        let toUnicode: Map<number, string> | null = null;
        if (uniRef?.kind === 'ref') {
          const uniObj = objects.get(uniRef.id);
          if (uniObj?.stream) {
            const decoded = decodeStream(uniObj, decodedBudget);
            if (decoded.bytes) toUnicode = parseToUnicode(decoded.bytes);
            unsupported.push(...decoded.unsupported);
          }
        }
        const codeWidth: 1 | 2 = toUnicode && [...toUnicode.keys()].some((k) => k > 255) ? 2 : 1;
        fonts.set(name, { toUnicode, codeWidth });
      }
    }

    // Content streams.
    let contentToken = page.dict.get('Contents');
    if (contentToken?.kind === 'ref') contentToken = objects.get(contentToken.id)?.dict.get('Contents') ?? contentToken;
    const contentRefs: number[] = [];
    if (contentToken?.kind === 'ref') contentRefs.push(contentToken.id);
    else if (contentToken?.kind === 'array') {
      for (const part of contentToken.value) if (part.kind === 'ref') contentRefs.push(part.id);
    }
    const contentParts: Buffer[] = [];
    for (const refId of contentRefs) {
      const obj = objects.get(refId);
      if (!obj) {
        unsupported.push(`content object ${refId} is missing`);
        continue;
      }
      const decoded = decodeStream(obj, decodedBudget);
      unsupported.push(...decoded.unsupported);
      if (decoded.bytes) contentParts.push(decoded.bytes);
    }
    const narration = contentParts.length > 0 ? extractContentText(Buffer.concat(contentParts), fonts) : '';

    const picResult = extractPagePictures(page, objects, decodedBudget, pageNo);
    unsupported.push(...picResult.unsupported);
    const picture = picResult.pictures[0] ?? null;
    if (picResult.pictures.length > 1) warnings.push(`Page ${pageNo} has ${picResult.pictures.length} embedded pictures; the first is bound to the panel and the rest are reported for manual library binding.`);
    if (!narration && !picture) unsupported.push(`page ${pageNo} has no extractable text or picture`);
    panels.push({ id: `page-${pad2(pageNo)}`, page: pageNo, narration, picture, unsupported });
  });

  const blocked = panels.flatMap((p) => p.unsupported).filter((u) => /not supported|could not be decompressed|missing object/.test(u));
  if (panels.every((p) => !p.narration && !p.picture) && blocked.length > 0) {
    throw new PdfStoryboardError('FACTORY_PDF_UNSUPPORTED', `No panel could be read: ${blocked[0]}. The full-parser provisioning decision names the supported alternative.`);
  }
  return { parser: PDF_PARSER_ID, pageCount: pages.length, panels, warnings };
}
