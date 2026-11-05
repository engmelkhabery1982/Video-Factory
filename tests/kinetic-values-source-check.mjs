/** PURE source checks using installed Node only; not Vitest, DOM, HTTP, typechecking or rendered acceptance.
 * Run: node --experimental-transform-types --test tests/kinetic-values-source-check.mjs
 * BEFORE fixture: VF_KINETIC_VALUES_BEFORE=1, only while the original Apply call is still present.
 */
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
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
const model = await import('../apps/web/src/lib/graphic-form.ts');
const { kineticValuesCases } = await import('./helpers/kinetic-values-cases.ts');
const before = process.env.VF_KINETIC_VALUES_BEFORE === '1';
let apply = model.buildKineticValues;
if (before) {
  const source = readFileSync(new URL('../apps/web/src/components/graphic/GraphicEditors.tsx', import.meta.url), 'utf8');
  if (!source.includes('buildKineticGraphic(list, format, durationSec, options)')) throw new Error('Before-fix check requires the original Apply call.');
  // Execute the existing PURE merger verbatim, without importing React or claiming a DOM run.
  const mergeSource = source.match(/export function mergeActions\([\s\S]*?\n\}/)?.[0];
  if (!mergeSource) throw new Error('Existing merger source not found.');
  const merge = new Function('defaultActions', stripTypeScriptTypes(mergeSource.replace(/^export /, '')) + '\nreturn mergeActions;')(model.defaultActions);
  apply = (form, format, duration, previous) => {
    const built = model.buildKineticGraphic(form, format, duration, { direction: previous?.direction ?? 'ltr' });
    if (model.graphicProblems(built, duration, format, 'educational').length) throw new Error('Reproduction must reach Apply.');
    built.actions = merge(built, previous, duration); return built;
  };
}
if (typeof apply !== 'function') throw new Error('Kinetic preservation helper is absent.');
for (const c of kineticValuesCases(apply)) if (!before || c.beforeFix) test(c.name, c.run);
