/**
 * Minimal TypeScript module-graph reader used only by the dependency-free
 * source loader (tools/lib/ts-source-loader.mjs).
 *
 * Why it exists: the repository is compiled by `tsc` with
 * `moduleResolution: "Bundler"`, which elides type-only imports/exports.
 * Node's native type stripping (22.22 `--experimental-transform-types`) keeps
 * them, because it cannot know which imported names are types. Loading the
 * canonical sources under plain Node therefore fails with
 * "The requested module './types.js' does not provide an export named ...".
 *
 * This module performs the *elision decision only*. It does not rewrite,
 * reimplement or stub any factory behaviour: the same TypeScript source is
 * executed, with the same value bindings, minus bindings that are types.
 *
 * It is deliberately conservative: when a module cannot be resolved or sits in
 * an export cycle, its names are reported as "unknown" and the caller keeps the
 * original import untouched (so a genuine mistake still fails loudly instead of
 * being silently erased).
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const VALUE_DECL = /^\s*(?:async\s+)?(?:function|const|let|var|class|enum)\b/;

function resolveFile(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [];
  if (base.endsWith('.js')) {
    candidates.push(base.slice(0, -3) + '.ts', base.slice(0, -3) + '.tsx');
  } else if (base.endsWith('.jsx')) {
    candidates.push(base.slice(0, -4) + '.tsx');
  } else {
    candidates.push(base, base + '.ts', base + '.tsx', path.join(base, 'index.ts'), path.join(base, 'index.tsx'));
  }
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

/** Walk a source file and return its import/export statements with positions. */
function scan(text) {
  const statements = [];
  const declarations = [];
  const n = text.length;
  let i = 0;

  const skipTrivia = (j) => {
    while (j < n) {
      const c = text[j];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') j += 1;
      else if (c === '/' && text[j + 1] === '/') {
        const nl = text.indexOf('\n', j);
        j = nl === -1 ? n : nl + 1;
      } else if (c === '/' && text[j + 1] === '*') {
        const close = text.indexOf('*/', j + 2);
        j = close === -1 ? n : close + 2;
      } else break;
    }
    return j;
  };

  const readString = (j) => {
    const quote = text[j];
    let k = j + 1;
    while (k < n) {
      if (text[k] === '\\') { k += 2; continue; }
      if (text[k] === quote) return { value: text.slice(j + 1, k), end: k + 1 };
      k += 1;
    }
    return null;
  };

  const parseBraceList = (j) => {
    // j points at '{'
    let depth = 0;
    let k = j;
    for (; k < n; k += 1) {
      const c = text[k];
      if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const body = text.slice(j + 1, k);
    const names = body
      .split(',')
      .map((part) => part.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim())
      .filter(Boolean)
      .map((part) => {
        const typeOnly = /^type\s+/.test(part);
        const cleaned = part.replace(/^type\s+/, '');
        const m = cleaned.match(/^([A-Za-z_$][\w$]*|default)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
        if (!m) return null;
        return { imported: m[1], local: m[2] ?? m[1], typeOnly };
      })
      .filter(Boolean);
    return { names, end: k + 1 };
  };

  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? n : close + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const s = readString(i);
      i = s ? s.end : n;
      continue;
    }
    if ((c === 'i' || c === 'e') && (i === 0 || !/[\w$]/.test(text[i - 1]))) {
      const word = text.slice(i, i + 6);
      const isImport = /^import\b/.test(text.slice(i, i + 7));
      const isExport = /^export\b/.test(text.slice(i, i + 7));
      if (isImport || isExport) {
        const start = i;
        let j = skipTrivia(i + 6);
        if (isImport) {
          if (text[j] === '(') { i = j + 1; continue; } // dynamic import
          if (text[j] === '"' || text[j] === "'") {
            const s = readString(j);
            i = s ? s.end : n;
            continue;
          }
          // import type { ... } / import { ... } / import default / import * as x
          let typeKeyword = false;
          if (/^type\b/.test(text.slice(j, j + 5)) && /[\s{]/.test(text[j + 4] ?? '')) {
            typeKeyword = true;
            j = skipTrivia(j + 4);
          }
          if (text[j] === '{') {
            const list = parseBraceList(j);
            let k = skipTrivia(list.end);
            let spec = null;
            if (/^from\b/.test(text.slice(k, k + 5))) {
              k = skipTrivia(k + 4);
              const s = readString(k);
              if (s) { spec = s.value; k = s.end; }
            }
            if (spec) {
              statements.push({ kind: 'import', start, end: k, spec, names: list.names, allType: typeKeyword });
              i = k;
              continue;
            }
          }
        } else {
          // export ...
          if (/^type\s*\{/.test(text.slice(start + 6))) {
            j = skipTrivia(start + 6 + 4);
            if (text[j] === '{') {
              const list = parseBraceList(j);
              let k = skipTrivia(list.end);
              let spec = null;
              if (/^from\b/.test(text.slice(k, k + 5))) {
                k = skipTrivia(k + 4);
                const s = readString(k);
                if (s) { spec = s.value; k = s.end; }
              }
              if (spec) {
                statements.push({ kind: 'reexport', start, end: k, spec, names: list.names, allType: true });
                i = k;
                continue;
              }
            }
          }
          if (text[j] === '{') {
            const list = parseBraceList(j);
            let k = skipTrivia(list.end);
            let spec = null;
            if (/^from\b/.test(text.slice(k, k + 5))) {
              k = skipTrivia(k + 4);
              const s = readString(k);
              if (s) { spec = s.value; k = s.end; }
            }
            statements.push({
              kind: spec ? 'reexport' : 'exportlist',
              start,
              end: spec ? k : list.end,
              spec,
              names: list.names,
              allType: false,
            });
            i = spec ? k : list.end;
            continue;
          }
          if (text[j] === '*') {
            let k = skipTrivia(j + 1);
            let asName = null;
            if (/^as\b/.test(text.slice(k, k + 2))) {
              k = skipTrivia(k + 2);
              const m = text.slice(k).match(/^([A-Za-z_$][\w$]*)/);
              if (m) { asName = m[1]; k = skipTrivia(k + m[1].length); }
            }
            let spec = null;
            if (/^from\b/.test(text.slice(k, k + 5))) {
              k = skipTrivia(k + 4);
              const s = readString(k);
              if (s) { spec = s.value; k = s.end; }
            }
            if (spec) {
              statements.push({ kind: 'star', start, end: k, spec, names: [], allType: false, asName });
              i = k;
              continue;
            }
          }
          // declarations
          if (VALUE_DECL.test(text.slice(j))) {
            const rest = text.slice(j).replace(/^async\s+/, '');
            const m = rest.match(/^(?:function|const|let|var|class|enum)\s+\*?\s*([A-Za-z_$][\w$]*)/);
            if (m) declarations.push({ name: m[1], kind: 'value' });
            i = j + 1;
            continue;
          }
          if (/^(?:interface|declare)\b/.test(text.slice(j))) {
            const m = text.slice(j).match(/^(?:interface|declare)\s+(?:const\s+|function\s+|namespace\s+)?([A-Za-z_$][\w$]*)/);
            if (m) declarations.push({ name: m[1], kind: 'type' });
            i = j + 1;
            continue;
          }
          if (/^type\b/.test(text.slice(j))) {
            const m = text.slice(j).match(/^type\s+([A-Za-z_$][\w$]*)/);
            if (m) declarations.push({ name: m[1], kind: 'type' });
            i = j + 1;
            continue;
          }
          if (/^default\b/.test(text.slice(j))) {
            declarations.push({ name: 'default', kind: 'value' });
            i = j + 1;
            continue;
          }
        }
      }
    }
    i += 1;
  }
  return { statements, declarations };
}

const cache = new Map();

/**
 * Names exported by `file` as runtime values / as types only.
 * `unknown: true` means the answer depends on a cycle or an unresolvable
 * specifier; callers must then leave imports untouched.
 */
export function moduleExports(file, inProgress = new Set()) {
  const hit = cache.get(file);
  if (hit) return hit;
  if (inProgress.has(file)) return { values: new Set(), types: new Set(), unknown: true };
  inProgress.add(file);

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    inProgress.delete(file);
    return { values: new Set(), types: new Set(), unknown: true };
  }

  const { statements, declarations } = scan(text);
  const values = new Set();
  const types = new Set();
  let unknown = false;

  for (const d of declarations) {
    if (d.kind === 'value') values.add(d.name);
    else types.add(d.name);
  }

  const localDeclared = new Map();
  for (const d of declarations) localDeclared.set(d.name, d.kind);

  for (const s of statements) {
    if (s.kind === 'exportlist') {
      for (const nm of s.names) {
        if (nm.typeOnly) { types.add(nm.local); continue; }
        const kind = localDeclared.get(nm.imported);
        if (kind === 'value') values.add(nm.local);
        else if (kind === 'type') types.add(nm.local);
        else unknown = true; // re-export of an imported name: kept as-is
      }
      continue;
    }
    if (s.kind === 'reexport') {
      const target = s.spec ? resolveFile(file, s.spec) : null;
      if (!target) { unknown = true; continue; }
      const inner = moduleExports(target, inProgress);
      if (inner.unknown) unknown = true;
      for (const nm of s.names) {
        if (s.allType || nm.typeOnly) { types.add(nm.local); continue; }
        if (inner.values.has(nm.imported)) values.add(nm.local);
        else if (inner.types.has(nm.imported)) types.add(nm.local);
        else unknown = true;
      }
      continue;
    }
    if (s.kind === 'star') {
      const target = s.spec ? resolveFile(file, s.spec) : null;
      if (!target) { unknown = true; continue; }
      const inner = moduleExports(target, inProgress);
      if (inner.unknown) unknown = true;
      if (s.asName) {
        values.add(s.asName);
      } else {
        for (const v of inner.values) values.add(v);
        for (const t of inner.types) types.add(t);
      }
    }
  }

  inProgress.delete(file);
  const result = { values, types, unknown };
  cache.set(file, result);
  return result;
}

/**
 * Rewrite one source text: drop import/reexport bindings that the target module
 * exports as types only (what `tsc` elides). Unknown targets are left alone.
 */
export function elideTypeBindings(file, text) {
  const { statements } = scan(text);
  const edits = [];
  for (const s of statements) {
    if (s.kind !== 'import' && s.kind !== 'reexport') continue;
    if (!s.spec) continue;
    const target = resolveFile(file, s.spec);
    if (!target) continue;
    const info = moduleExports(target, new Set());
    if (info.unknown && s.kind === 'reexport') continue;
    const drop = s.names.filter((nm) => nm.typeOnly || info.types.has(nm.imported));
    if (s.kind === 'import' && s.allType) { edits.push({ start: s.start, end: s.end, text: `import ${JSON.stringify(s.spec)};` }); continue; }
    if (!drop.length) continue;
    const keep = s.names.filter((nm) => !drop.includes(nm));
    if (!keep.length) {
      edits.push({ start: s.start, end: s.end, text: `/* type-only ${s.kind} */ import ${JSON.stringify(s.spec)};` });
      continue;
    }
    const list = keep.map((nm) => (nm.imported === nm.local ? nm.local : `${nm.imported} as ${nm.local}`)).join(', ');
    const head = s.kind === 'import' ? 'import' : 'export';
    edits.push({ start: s.start, end: s.end, text: `${head} { ${list} } from ${JSON.stringify(s.spec)};` });
  }
  if (!edits.length) return null;
  edits.sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

export const __internals = { scan, resolveFile };
