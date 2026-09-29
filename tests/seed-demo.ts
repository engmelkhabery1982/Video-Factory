/**
 * Seeds the three demo projects (storyboards only, no rendering) so the UI has
 * real content to show straight after installation.
 *
 * `generateStoryboard` persists the project and appends to the visual history
 * itself, so this only has to feed it an empty history and step through.
 *
 * Usage:  npm run seed
 */
import { DEMO_PROJECTS } from './fixtures/demo-projects.js';
import { ensureDirs, prepareBrowserEnv } from '../apps/api/src/services/platform.js';
import { newProject, generateStoryboard, loadHistory } from '../apps/api/src/services/store.js';
import { seedBrandAssets } from '../apps/api/src/routes/assets.js';

ensureDirs();
prepareBrowserEnv();
seedBrandAssets();

for (const input of DEMO_PROJECTS) {
  const created = newProject(input);
  // reload the history every time: generateStoryboard scores the new video
  // against it and appends to it, and holding one stale copy would make every
  // video look like the first one (0% similarity, same hook as its neighbour)
  const project = generateStoryboard(created, loadHistory());
  const sb = project.storyboard;
  // generateStoryboard appends the history entry itself but does not keep it
  // on the project, so read the newest one back off the saved history
  const e = (loadHistory().videos.at(-1) ?? {}) as Record<string, unknown>;
  console.log(`${created.meta.input.videoId}: ${sb.long.scenes.length} long scenes / ${sb.long.totalDuration.toFixed(1)}s, ` +
    `${sb.shorts.length} shorts (${sb.shorts.map((s) => s.totalDuration.toFixed(0) + 's').join(', ')}), ` +
    `${sb.captions.length} cues, similarity ${sb.similarity?.score ?? 0}%`);
  console.log(`   hook=${e.hookVariant}  cta=${e.ctaAnimation}  captions=${e.captionStyle}`);
  console.log(`   backgrounds: ${[...new Set((e.backgrounds as string[]) ?? [])].join(', ')}`);
  for (const w of sb.warnings) console.log(`   warn: ${w}`);
}

console.log(`\nseeded ${DEMO_PROJECTS.length} projects. Open the app and click a project.`);
