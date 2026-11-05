/** Installed-Node PURE checks, not Vitest/HTTP/DOM/typecheck/render evidence.
 * Run: node --experimental-transform-types --test tests/draft-static-source-check.mjs
 * VF_DRAFT_STATIC_BEFORE=1 selects the regression/control before production edits.
 */
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const url = new URL(specifier, context.parentURL);
    if (!existsSync(fileURLToPath(url))) {
      const candidate = new URL(url.href.endsWith('.js') ? url.href.slice(0, -3) + '.ts' : url.href + '.ts');
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
    }
  }
  return nextResolve(specifier, context);
} });
const { draftStaticCases } = await import('./helpers/draft-static-cases.ts');
for (const c of draftStaticCases) if (process.env.VF_DRAFT_STATIC_BEFORE !== '1' || c.beforeFix) test(c.name, c.run);
