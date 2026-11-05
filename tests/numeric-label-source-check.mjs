/** Node 22 built-in, source-only PURE checks. NOT a typecheck, Vitest/DOM/HTTP run or renderer substitute.
 * Run: node --experimental-transform-types --test tests/numeric-label-source-check.mjs
 * Resolve the existing browser-safe core source and TS imports without installing workspace dependencies.
 */
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === '@buildtrack/core/visual') return nextResolve(new URL('../packages/core/src/visual.ts', import.meta.url).href, context);
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const url = new URL(specifier, context.parentURL);
    if (!existsSync(fileURLToPath(url))) {
      const candidate = new URL(url.href.endsWith('.js') ? url.href.slice(0, -3) + '.ts' : url.href + '.ts');
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
    }
  }
  return nextResolve(specifier, context);
} });
const { numericLabelCases } = await import('./helpers/numeric-label-cases.ts');
for (const { name, run } of numericLabelCases) test(name, run);
