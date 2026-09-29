/**
 * Fast text audit - runs the real storyboard + caption generation for every
 * demo project and prints every string that will appear on screen.
 *
 * Rendering a frame is the only way to see a *visual* defect, but most copy
 * defects (truncated headlines, trailing commas, duplicated lines, emoji that
 * the brand font cannot draw) are visible here in seconds rather than hours.
 *
 * Usage:  npx tsx tests/audit-copy.ts
 */
import { DEMO_PROJECTS } from './fixtures/demo-projects.js';
import { newProject, generateStoryboard } from '../apps/api/src/services/store.js';
import { loadHistory } from '../apps/api/src/services/store.js';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../apps/api/src/services/platform.js';

/** Glyphs the bundled brand font is known to render; anything else is tofu. */
const UNSAFE_GLYPHS = /[⚠✔✕→←↑↓⇒•·‹›«»“”‘’…]|[^\x00-\x7F]/gu;

const history = loadHistory();

for (const spec of DEMO_PROJECTS) {
  const p = newProject(spec);
  const sb = generateStoryboard(p, history, {}).storyboard;
  const long = sb.long.scenes;
  const shorts = sb.shorts ?? [];

  console.log(`\n${'='.repeat(78)}\n${p.meta.input.title}  (similarity ${sb.similarity ?? '?'}%)\n${'='.repeat(78)}`);

  const rows: { where: string; field: string; text: string }[] = [];
  const collect = (where: string, o: any) => {
    for (const f of ['headline', 'subline', 'takeaway', 'eyebrow', 'cta', 'statLabel', 'statLabel2']) {
      if (o?.[f]) rows.push({ where, field: f, text: String(o[f]) });
    }
    for (const side of o?.sides ?? []) {
      if (side?.text) rows.push({ where, field: `side[${side.label ?? '?'}]`, text: String(side.text) });
    }
  };
  for (const s of long) collect(`long/${s.variant}`, s.content);
  for (const sh of shorts) {
    for (const s of sh.scenes ?? []) collect(`short/${s.variant}`, s.content);
  }

  const issues: string[] = [];
  for (const r of rows) {
    const t = r.text;
    if (!t.trim()) {
      issues.push(`EMPTY  ${r.where} ${r.field}`);
      continue;
    }
    // a full stop ending a complete sentence is correct; a comma or colon is a
    // clause that was cut mid-thought and is a real defect
    if (/[,;:]\s*$/.test(t)) issues.push(`DANGLING-CLAUSE  ${r.where} ${r.field} "${t}"`);
    if (t !== t.trim()) issues.push(`WHITESPACE  ${r.where} ${r.field} "${t}"`);
    if (UNSAFE_GLYPHS.test(t)) issues.push(`NON-ASCII-GLYPH  ${r.where} ${r.field} "${t}"`);
    if (/\s{2,}/.test(t)) issues.push(`DOUBLE-SPACE  ${r.where} ${r.field} "${t}"`);
    if (t.length > 120) issues.push(`TOO-LONG(${t.length})  ${r.where} ${r.field} "${t}"`);
  }
  // duplicate headlines within one video = the repetition the brief forbids
  const dupes = new Map<string, number>();
  for (const s of long) dupes.set(s.headline ?? '', (dupes.get(s.headline ?? '') ?? 0) + 1);
  for (const [h, n] of dupes) if (n > 1) issues.push(`DUPLICATE-HEADLINE x${n} "${h}"`);

  console.log(`scenes: long=${long.length} shorts=${shorts.length}  strings=${rows.length}`);
  if (!issues.length) console.log('copy: clean');
  for (const i of issues) console.log(`  ${i}`);

  // captions use their own shorter extraction - audit them too
  const cues = (sb as any).captions ?? [];
  console.log(`captions: ${cues.length}`);
  for (const c of cues) {
    if (!c.text?.trim()) console.log(`  EMPTY-CAPTION ${JSON.stringify(c)}`);
    else if (c.text.length > 90) console.log(`  LONG-CAPTION(${c.text.length}) "${c.text}"`);
  }
}
