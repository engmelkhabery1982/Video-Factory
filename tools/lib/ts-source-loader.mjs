/**
 * Dependency-free loader for the factory's TypeScript sources.
 *
 * This environment has Node built-ins only: no node_modules, no tsc, no vitest.
 * Node 22.22 can strip/transform TypeScript natively, so the canonical
 * services can still be executed if two resolution details are handled:
 *
 *   1. workspace package `@buildtrack/core` -> packages/core/src/index.ts
 *   2. ESM `.js` specifiers that address `.ts` sources (TS's NodeNext style)
 *
 * This file is a *loader*, not a test double. It changes no behaviour, injects
 * no fixture and mocks nothing: the same service code the API runs is executed.
 * Anything that needs a real package (fastify, react, remotion, ffmpeg) still
 * fails loudly, which is the honest outcome here.
 *
 * Usage (from the repo root):
 *   node --experimental-transform-types --import ./tools/lib/ts-source-loader.mjs <script>
 */
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { elideTypeBindings } from './ts-module-graph.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CORE_SRC = path.join(ROOT, 'packages', 'core', 'src');
const CORE_SUBPATHS = new Map([
  ['@buildtrack/core', path.join(CORE_SRC, 'index.ts')],
  ['@buildtrack/core/node', path.join(CORE_SRC, 'scenario', 'node-adapters.ts')],
  ['@buildtrack/core/boundaries', path.join(CORE_SRC, 'scenario', 'narration-boundaries.ts')],
  ['@buildtrack/core/visual', path.join(CORE_SRC, 'visual.ts')],
]);

const asFile = (spec, parentURL) => {
  try {
    return fileURLToPath(new URL(spec, parentURL));
  } catch {
    return null;
  }
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const mapped = CORE_SUBPATHS.get(specifier);
    if (mapped) {
      if (!existsSync(mapped)) return nextResolve(specifier, context);
      return { url: pathToFileURL(mapped).href, shortCircuit: true };
    }
    // TS/NodeNext: `./foo.js` on disk is `./foo.ts`
    if (context.parentURL?.startsWith('file:') && (specifier.startsWith('./') || specifier.startsWith('../'))) {
      const target = asFile(specifier, context.parentURL);
      if (target && !existsSync(target) && target.endsWith('.js')) {
        const ts = target.slice(0, -3) + '.ts';
        if (existsSync(ts)) return { url: pathToFileURL(ts).href, shortCircuit: true };
        const tsx = target.slice(0, -3) + '.tsx';
        if (existsSync(tsx)) return { url: pathToFileURL(tsx).href, shortCircuit: true };
      }
    }
    // `@buildtrack/core` reached from inside packages/core via a self-relative import
    if (specifier.startsWith('@buildtrack/core/')) {
      const rest = specifier.slice('@buildtrack/core/'.length);
      const candidate = path.join(CORE_SRC, rest + '.ts');
      if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },

  load(url, context, nextLoad) {
    if (!url.startsWith('file:')) return nextLoad(url, context);
    const file = fileURLToPath(url);
    if (!/\.[cm]?tsx?$/.test(file)) return nextLoad(url, context);
    if (file.endsWith('.d.ts')) return nextLoad(url, context);
    const out = nextLoad(url, context);
    // Only TypeScript sources that Node already agreed to transform are touched.
    // Node 22.22 reports TypeScript ESM as `module-typescript`.
    if (!out || typeof out.format !== 'string' || !out.format.startsWith('module')) return out;
    const source =
      typeof out.source === 'string' ? out.source : Buffer.from(out.source).toString('utf8');
    const rewritten = elideTypeBindings(file, source);
    if (rewritten === null) return out;
    return { format: out.format, source: rewritten, shortCircuit: true };
  },
});

export const FACTORY_REPO_ROOT = ROOT;
